/**
 * Zero-dependency HTTP client for the TikTok MCP transport.
 *
 * The plugin runs inside the DSH host process (Electron main / Node), so it may
 * not rely on `undici` being importable nor on global `fetch` honouring proxy
 * environment variables. This module therefore speaks HTTP/1.1 over
 * `node:net` / `node:tls` sockets directly and supports an explicit
 * `HTTP CONNECT` tunnel for deployments that need a local proxy.
 *
 * Supported response framings: `Content-Length`, `Transfer-Encoding: chunked`,
 * connection-close, and incremental `text/event-stream` bodies (needed because
 * a Streamable HTTP MCP server may answer one JSON-RPC request inside an SSE
 * stream that stays open).
 */
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

const CRLF = '\r\n'

/** Raised for transport-level failures; `code` is stable for callers. */
export class TransportError extends Error {
  constructor(message, { code = 'transport_error', status, cause } = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    if (status !== undefined) this.status = status
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Normalize proxy configuration into a URL or null.
 * @param {unknown} proxy
 * @returns {URL | null}
 */
export function parseProxy(proxy) {
  if (proxy === undefined || proxy === null || proxy === false) return null
  const text = String(proxy).trim()
  if (!text || text === 'off' || text === 'none' || text === 'direct') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new TransportError(`代理地址无法解析：${text}`, { code: 'bad_proxy' })
  }
  if (url.protocol !== 'http:') {
    throw new TransportError(`仅支持 http:// 代理（不支持 ${url.protocol}）`, { code: 'bad_proxy' })
  }
  return url
}

/**
 * Open a TCP socket and resolve once connected.
 * @param {import('node:net').NetConnectOpts} options
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 */
function connectTcp(options, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options)
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new TransportError('连接代理/服务器超时', { code: 'connect_timeout' })), timeoutMs)
    const onAbort = () => fail(new TransportError('请求已取消', { code: 'aborted' }))
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    })
    socket.once('error', (error) => fail(new TransportError(error.message, { code: 'connect_failed', cause: error })))
  })
}

/**
 * Establish a TLS connection, optionally through an HTTP CONNECT tunnel.
 * @param {{ host: string, port: number, proxy: URL | null, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
async function connectTls({ host, port, proxy, timeoutMs, signal }) {
  let plainSocket
  if (proxy) {
    const proxyPort = Number(proxy.port || 80)
    plainSocket = await connectTcp({ host: proxy.hostname, port: proxyPort }, timeoutMs, signal)
    await establishConnectTunnel(plainSocket, host, port, proxy, timeoutMs, signal)
  } else {
    plainSocket = await connectTcp({ host, port }, timeoutMs, signal)
  }

  const secure = tls.connect({ socket: plainSocket, servername: host, ALPNProtocols: ['http/1.1'] })
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secure.destroy()
      reject(error instanceof TransportError ? error : new TransportError(error.message, { code: 'tls_failed', cause: error }))
    }
    const timer = setTimeout(() => fail(new TransportError('TLS 握手超时', { code: 'tls_timeout' })), timeoutMs)
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once('error', fail)
  })
}

/**
 * Perform `CONNECT host:port HTTP/1.1` and resolve after the proxy answers 2xx.
 * @param {import('node:net').Socket} socket
 * @param {string} host
 * @param {number} port
 * @param {URL} proxy
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 */
function establishConnectTunnel(socket, host, port, proxy, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        socket.destroy()
        reject(error)
      } else resolve()
    }
    const onAbort = () => finish(new TransportError('请求已取消', { code: 'aborted' }))
    const onError = (error) => finish(new TransportError(`代理连接失败：${error.message}`, { code: 'proxy_error', cause: error }))
    const timer = setTimeout(() => finish(new TransportError('代理 CONNECT 超时', { code: 'proxy_timeout' })), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    const auth = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}${CRLF}`
      : ''
    socket.write(`CONNECT ${host}:${port} HTTP/1.1${CRLF}Host: ${host}:${port}${CRLF}${auth}${CRLF}`)

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffer.length > 64 * 1024) finish(new TransportError('代理响应头过大', { code: 'proxy_headers' }))
        return
      }
      const head = buffer.subarray(0, end).toString('latin1')
      const statusLine = head.split(CRLF)[0] || ''
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
      const status = match ? Number(match[1]) : 0
      if (status >= 200 && status < 300) return finish()
      finish(new TransportError(`代理拒绝 CONNECT（HTTP ${status || '?'}）：${head.split(CRLF).slice(1).join(' ').slice(0, 300)}`, { code: 'proxy_rejected', status }))
    }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

/**
 * Parse a raw HTTP/1.1 header block.
 * @param {string} head
 */
function parseHead(head) {
  const lines = head.split(CRLF)
  const statusLine = lines.shift() || ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/.exec(statusLine)
  if (!match) throw new TransportError(`无法解析 HTTP 状态行：${statusLine.slice(0, 120)}`, { code: 'bad_status_line' })
  /** @type {Record<string, string>} */
  const headers = {}
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }
  return { status: Number(match[1]), statusText: match[2] || '', headers }
}

/**
 * Incremental decoder for `Transfer-Encoding: chunked` bodies.
 */
class ChunkedDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.remaining = 0
    this.needsSizeLine = true
    this.done = false
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[]} decoded fragments
   */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out = []
    for (;;) {
      if (this.done) break
      if (this.needsSizeLine) {
        const index = this.buffer.indexOf('\r\n')
        if (index < 0) break
        const line = this.buffer.subarray(0, index).toString('latin1').split(';')[0].trim()
        this.buffer = this.buffer.subarray(index + 2)
        const size = Number.parseInt(line, 16)
        if (!Number.isFinite(size) || size < 0) throw new TransportError(`chunked 长度非法：${line.slice(0, 40)}`, { code: 'bad_chunk' })
        if (size === 0) {
          this.done = true
          break
        }
        this.remaining = size
        this.needsSizeLine = false
      } else {
        if (this.buffer.length < this.remaining + 2) break
        out.push(this.buffer.subarray(0, this.remaining))
        this.buffer = this.buffer.subarray(this.remaining + 2)
        this.remaining = 0
        this.needsSizeLine = true
      }
    }
    return out
  }
}

/**
 * Extract complete SSE events from a text buffer.
 * @param {string} text
 * @returns {{ events: Array<{ event: string, data: string }>, rest: string }}
 */
export function splitSseEvents(text) {
  const events = []
  let rest = text
  for (;;) {
    const index = rest.indexOf('\n\n')
    const indexCrlf = rest.indexOf('\r\n\r\n')
    let boundary = -1
    let width = 0
    if (index < 0 && indexCrlf < 0) break
    if (indexCrlf >= 0 && (index < 0 || indexCrlf < index)) {
      boundary = indexCrlf
      width = 4
    } else {
      boundary = index
      width = 2
    }
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + width)
    let event = 'message'
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const sep = line.indexOf(':')
      const field = sep < 0 ? line : line.slice(0, sep)
      const value = sep < 0 ? '' : line.slice(sep + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') })
  }
  return { events, rest }
}

/**
 * Send one request and read the complete response body.
 * Used for OAuth endpoint calls (small JSON payloads).
 *
 * @param {string} urlString
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | Buffer, proxy?: URL | null, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string }>}
 */
export async function httpRequest(urlString, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    proxy = null,
    timeoutMs = 60_000,
    signal,
  } = options
  const url = new URL(urlString)
  if (url.protocol !== 'https:') throw new TransportError(`仅支持 https（收到 ${url.protocol}）`, { code: 'bad_url' })
  const host = url.hostname
  const port = Number(url.port || 443)
  const socket = await connectTls({ host, port, proxy, timeoutMs, signal })

  return new Promise((resolve, reject) => {
    let settled = false
    const chunks = []
    const decoder = new ChunkedDecoder()
    let head = null
    let headBuffer = Buffer.alloc(0)
    let contentLength = null
    let bodyBytes = 0

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners('data')
      socket.removeAllListeners('end')
      socket.removeAllListeners('close')
      socket.removeAllListeners('error')
      socket.destroy()
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof TransportError ? error : new TransportError(error.message, { code: 'request_failed', cause: error }))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      // 连接在收到任何响应头之前被关闭时 head 为 null（代理/网关静默断连）。
      // 这里必须 fail 而不是继续读 head.status，否则会抛未捕获 TypeError 崩掉宿主进程。
      if (!head) {
        fail(new TransportError('连接在响应头到达前被关闭（可能是代理中断）', { code: 'connection_closed' }))
        return
      }
      const buffer = Buffer.concat(chunks)
      resolve({ status: head.status, headers: head.headers, text: buffer.toString('utf8') })
    }
    const onAbort = () => fail(new TransportError('请求已取消', { code: 'aborted' }))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => fail(new TransportError(`请求超时（${timeoutMs}ms）`, { code: 'timeout' })), timeoutMs)

    const consumeBody = (fragment) => {
      if (fragment.length === 0) return
      chunks.push(fragment)
      bodyBytes += fragment.length
      if (contentLength !== null && bodyBytes >= contentLength) succeed()
    }

    const onData = (chunk) => {
      try {
        if (!head) {
          headBuffer = Buffer.concat([headBuffer, chunk])
          const end = headBuffer.indexOf('\r\n\r\n')
          if (end < 0) {
            if (headBuffer.length > 128 * 1024) fail(new TransportError('响应头过大', { code: 'headers_too_large' }))
            return
          }
          head = parseHead(headBuffer.subarray(0, end).toString('latin1'))
          const rest = headBuffer.subarray(end + 4)
          headBuffer = Buffer.alloc(0)
          if (head.headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
            for (const part of decoder.push(rest)) consumeBody(part)
            if (decoder.done) succeed()
          } else if (head.headers['content-length']) {
            contentLength = Number(head.headers['content-length'])
            if (rest.length) consumeBody(rest)
            if (bodyBytes >= contentLength) succeed()
          } else if (rest.length) {
            consumeBody(rest)
          }
          return
        }
        if (decoder.remaining > 0 || (head.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
          for (const part of decoder.push(chunk)) consumeBody(part)
          if (decoder.done) succeed()
        } else {
          consumeBody(chunk)
        }
      } catch (error) {
        fail(error)
      }
    }

    socket.on('data', onData)
    socket.once('end', () => succeed())
    socket.once('close', () => succeed())
    socket.once('error', (error) => fail(new TransportError(error.message, { code: 'socket_error', cause: error })))

    const requestHeaders = {
      Host: url.host,
      Connection: 'close',
      'User-Agent': 'dsh-plugin-tiktok-ads/0.1',
      ...headers,
    }
    if (body !== undefined) requestHeaders['Content-Length'] = String(Buffer.byteLength(body))
    const path = `${url.pathname}${url.search}`
    const headerLines = Object.entries(requestHeaders)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}: ${value}${CRLF}`)
      .join('')
    socket.write(`${method} ${path} HTTP/1.1${CRLF}${headerLines}${CRLF}`)
    if (body !== undefined) socket.write(body)
  })
}

/**
 * POST a JSON-RPC message to a Streamable HTTP MCP endpoint.
 *
 * Resolves with the first matching JSON-RPC response (JSON body or the SSE
 * event whose payload carries the same `id`) and the response headers, which
 * carry `mcp-session-id` during initialization.
 *
 * @param {string} urlString
 * @param {{ headers?: Record<string,string>, payload: unknown, proxy?: URL|null, timeoutMs?: number, signal?: AbortSignal, expectResponse?: boolean }} options
 * @returns {Promise<{ status: number, headers: Record<string,string>, json: unknown, text: string }>}
 */
export async function postJsonRpc(urlString, options) {
  const {
    headers = {},
    payload,
    proxy = null,
    timeoutMs = 60_000,
    signal,
    expectResponse = true,
  } = options
  const url = new URL(urlString)
  if (url.protocol !== 'https:') throw new TransportError(`仅支持 https（收到 ${url.protocol}）`, { code: 'bad_url' })
  const socket = await connectTls({ host: url.hostname, port: Number(url.port || 443), proxy, timeoutMs, signal })
  const requestId = payload && typeof payload === 'object' ? payload.id : undefined

  return new Promise((resolve, reject) => {
    let settled = false
    let head = null
    let headBuffer = Buffer.alloc(0)
    let isChunked = false
    const decoder = new ChunkedDecoder()
    let textBuffer = ''
    let rawText = ''
    const chunks = []

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners('data')
      socket.removeAllListeners('end')
      socket.removeAllListeners('close')
      socket.removeAllListeners('error')
      socket.destroy()
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof TransportError ? error : new TransportError(error.message, { code: 'request_failed', cause: error }))
    }
    const succeed = (json) => {
      if (settled) return
      // 代理/服务端可能在响应头之前就断开，此时 head 为 null —— 必须当失败处理，
      // 否则 head.status 会抛未捕获异常（整进程崩掉）。
      if (!head) {
        fail(new TransportError('连接在响应头到达前被关闭（可能被代理或服务端断开）', { code: 'connection_closed' }))
        return
      }
      settled = true
      cleanup()
      resolve({ status: head.status, headers: head.headers, json, text: rawText })
    }
    const onAbort = () => fail(new TransportError('请求已取消', { code: 'aborted' }))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => fail(new TransportError(`MCP 请求超时（${timeoutMs}ms）`, { code: 'timeout' })), timeoutMs)

    const contentType = () => (head?.headers['content-type'] || '').toLowerCase()
    const isSse = () => contentType().includes('text/event-stream')

    const tryFinishJson = () => {
      const trimmed = rawText.trim()
      if (!trimmed) return false
      try {
        const parsed = JSON.parse(trimmed)
        void parsed
        succeed(parsed)
        return true
      } catch {
        return false
      }
    }

    const handleDecoded = (fragment) => {
      const text = fragment.toString('utf8')
      rawText += text
      if (isSse()) {
        textBuffer += text
        const { events, rest } = splitSseEvents(textBuffer)
        textBuffer = rest
        for (const event of events) {
          if (event.event === 'ping' || !event.data.trim()) continue
          let parsed
          try {
            parsed = JSON.parse(event.data)
          } catch {
            continue
          }
          if (!expectResponse) return succeed(parsed)
          if (parsed && typeof parsed === 'object' && 'id' in parsed && parsed.id === requestId) return succeed(parsed)
        }
        return
      }
      // Plain JSON body: resolve as soon as it parses. A server may still hold
      // the socket open, so waiting for `end` is not dependable.
      if (expectResponse) tryFinishJson()
    }

    const onData = (chunk) => {
      try {
        if (!head) {
          headBuffer = Buffer.concat([headBuffer, chunk])
          const end = headBuffer.indexOf('\r\n\r\n')
          if (end < 0) {
            if (headBuffer.length > 128 * 1024) fail(new TransportError('响应头过大', { code: 'headers_too_large' }))
            return
          }
          head = parseHead(headBuffer.subarray(0, end).toString('latin1'))
          isChunked = (head.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')
          const rest = headBuffer.subarray(end + 4)
          headBuffer = Buffer.alloc(0)
          if (isChunked) {
            for (const part of decoder.push(rest)) handleDecoded(part)
          } else if (rest.length) handleDecoded(rest)
          return
        }
        if (isChunked) {
          for (const part of decoder.push(chunk)) handleDecoded(part)
        } else handleDecoded(chunk)
      } catch (error) {
        fail(error)
      }
    }

    const onEnd = () => {
      if (settled) return
      if (!head) {
        fail(new TransportError('连接在响应头到达前被关闭（可能被代理或服务端断开）', { code: 'connection_closed' }))
        return
      }
      if (head && isSse()) {
        // Flush a final event that arrived without a trailing blank line.
        if (textBuffer.trim()) {
          const synthetic = `${textBuffer}\n\n`
          textBuffer = ''
          const { events } = splitSseEvents(synthetic)
          for (const event of events) {
            if (!event.data.trim()) continue
            try {
              const parsed = JSON.parse(event.data)
              if (!expectResponse || (parsed && 'id' in parsed && parsed.id === requestId)) return succeed(parsed)
            } catch { /* ignore malformed trailing event */ }
          }
        }
        return succeed(null)
      }
      if (tryFinishJson()) return
      succeed(null)
    }

    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    socket.once('error', (error) => fail(new TransportError(error.message, { code: 'socket_error', cause: error })))

    const requestHeaders = {
      Host: url.host,
      // One request per socket: we resolve as soon as the JSON-RPC answer for
      // our id arrives, and `Connection: keep-alive` would let the server hold
      // the socket open so no `end` event ever fires.
      Connection: 'close',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'dsh-plugin-tiktok-ads/0.1',
      ...headers,
    }
    const bodyText = JSON.stringify(payload)
    requestHeaders['Content-Length'] = String(Buffer.byteLength(bodyText))
    const headerLines = Object.entries(requestHeaders)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}: ${value}${CRLF}`)
      .join('')
    socket.write(`POST ${url.pathname}${url.search} HTTP/1.1${CRLF}${headerLines}${CRLF}`)
    socket.write(bodyText)
    if (!expectResponse && requestId === undefined) {
      // Notifications still get a 202; wait for the status line then finish.
      setTimeout(() => {
        if (!settled && head) succeed(null)
      }, 250)
    }
  })
}
