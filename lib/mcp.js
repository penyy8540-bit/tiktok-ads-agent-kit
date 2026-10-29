/**
 * Minimal MCP client for a Streamable HTTP server.
 *
 * Implements only what this plugin needs: `initialize`,
 * `notifications/initialized`, `tools/list` (with pagination) and `tools/call`.
 * Inline base64 media is intentionally flattened to a short text note so a
 * 400-tool advertising server cannot flood the model context with images.
 */
import { postJsonRpc, TransportError } from './transport.js'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'dsh-plugin-tiktok-ads', version: '0.1.0' }
const MAX_TOOL_PAGES = 30

/** Error raised for a JSON-RPC level failure or an MCP tool `isError` result. */
export class McpError extends Error {
  constructor(message, { code = 'mcp_error', status, data } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    if (status !== undefined) this.status = status
    if (data !== undefined) this.data = data
  }
}

let nextRequestId = 1
function requestId() {
  return nextRequestId++
}

/**
 * Flatten MCP result content blocks into plain text sized for a chat tool result.
 * @param {unknown} result
 * @param {number} limit
 */
export function flattenToolResult(result, limit = 24_000) {
  const parts = []
  const content = result && typeof result === 'object' && Array.isArray(result.content) ? result.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      const mime = block.mimeType || 'image'
      const bytes = typeof block.data === 'string' ? block.data.length : 0
      parts.push(`[图片已省略：${mime}，base64 ${bytes} 字符。如需图片请在 TikTok 后台查看。]`)
    } else if (block.type === 'audio') {
      parts.push('[音频结果已省略]')
    } else if (block.type === 'resource') {
      const uri = block.resource?.uri || '未知资源'
      parts.push(`[资源：${uri}]`)
    } else if (block.type === 'resource_link') {
      parts.push(`[资源链接：${block.name || ''} ${block.uri || ''}]`.trim())
    } else {
      try {
        parts.push(JSON.stringify(block))
      } catch {
        parts.push('[无法序列化的内容块]')
      }
    }
  }
  if (parts.length === 0 && result && typeof result === 'object' && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2))
    } catch { /* ignore */ }
  }
  let text = parts.join('\n').trim()
  if (!text) text = '(TikTok 返回了空结果)'
  let truncated = false
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n…（结果过长，已截断 ${text.length - limit} 字符）`
    truncated = true
  }
  return { text, truncated }
}

/**
 * One MCP session bound to a resource URL and an access-token provider.
 */
export class McpSession {
  /**
   * @param {object} options
   * @param {string} options.url
   * @param {import('node:url').URL | null} options.proxy
   * @param {() => Promise<string>} options.getToken returns a usable access token, refreshing if needed
   * @param {(reason: string) => Promise<void>} [options.onUnauthorized] force token refresh, called once per retry
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, proxy, getToken, onUnauthorized, timeoutMs = 60_000 }) {
    this.url = url
    this.proxy = proxy
    this.getToken = getToken
    this.onUnauthorized = onUnauthorized
    this.timeoutMs = timeoutMs
    this.sessionId = null
    this.protocolVersion = PROTOCOL_VERSION
    this.serverInfo = null
    this.instructions = ''
    this.tools = []
    this.capabilities = null
    this.initialized = false
    this.lastSyncedAt = 0
  }

  /**
   * Send one JSON-RPC request, retrying once after a forced token refresh on 401.
   * @param {string} method
   * @param {Record<string, unknown> | undefined} params
   * @param {{ signal?: AbortSignal, timeoutMs?: number, expectResponse?: boolean }} options
   */
  async #rpc(method, params, { signal, timeoutMs, expectResponse = true } = {}) {
    const id = requestId()
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    let attempt = 0
    let refreshed = false
    for (;;) {
      attempt++
      const token = await this.getToken()
      const headers = {
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': this.protocolVersion,
      }
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
      const response = await postJsonRpc(this.url, {
        headers,
        payload,
        proxy: this.proxy,
        timeoutMs: timeoutMs ?? this.timeoutMs,
        signal,
        expectResponse,
      })
      if (response.status === 401 || response.status === 403) {
        if (!refreshed && this.onUnauthorized) {
          refreshed = true
          await this.onUnauthorized(`HTTP ${response.status}`)
          continue
        }
        throw new McpError(
          response.status === 401
            ? '访问令牌已失效（HTTP 401）。请运行 tiktok_ads_connect 重新授权。'
            : 'TikTok 拒绝了该请求（HTTP 403）：当前账号可能没有该广告账户或接口的权限。',
          { code: response.status === 401 ? 'unauthorized' : 'forbidden', status: response.status },
        )
      }
      const headerSession = response.headers['mcp-session-id']
      if (headerSession && !this.sessionId) this.sessionId = headerSession
      if (!expectResponse) return null
      if (response.status >= 400) {
        throw new McpError(`TikTok MCP 返回 HTTP ${response.status}：${String(response.text || '').slice(0, 500)}`, {
          code: 'http_error',
          status: response.status,
        })
      }
      const message = response.json
      if (!message || typeof message !== 'object') {
        throw new McpError('TikTok MCP 返回了空的 JSON-RPC 响应', { code: 'empty_response', status: response.status })
      }
      if (message.error) {
        const error = message.error
        const detail = error.data !== undefined ? `：${JSON.stringify(error.data).slice(0, 800)}` : ''
        throw new McpError(`${error.message || 'MCP 调用失败'}（code ${error.code}）${detail}`, {
          code: 'rpc_error',
          status: response.status,
          data: error,
        })
      }
      if (message.id !== undefined && message.id !== id) continue
      return message.result ?? null
    }
  }

  /** Perform the MCP handshake and initial tool discovery. */
  async connect({ signal } = {}) {
    const result = await this.#rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: CLIENT_INFO,
      },
      { signal },
    )
    if (result?.protocolVersion) this.protocolVersion = String(result.protocolVersion)
    this.serverInfo = result?.serverInfo || null
    this.capabilities = result?.capabilities || null
    this.instructions = typeof result?.instructions === 'string' ? result.instructions : ''
    await this.#rpc('notifications/initialized', undefined, { expectResponse: false, signal }).catch(() => null)
    this.initialized = true
    if (this.capabilities?.tools !== undefined) await this.syncTools({ signal })
    return this
  }

  /** Re-read the tool list, replacing the previous generation on success. */
  async syncTools({ signal } = {}) {
    const collected = []
    let cursor
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.#rpc('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs: Math.max(this.timeoutMs, 60_000) })
      const tools = Array.isArray(result?.tools) ? result.tools : []
      collected.push(...tools)
      cursor = result?.nextCursor
      if (!cursor) break
    }
    const seen = new Set()
    this.tools = collected.filter((tool) => {
      const name = tool?.name
      if (typeof name !== 'string' || !name || seen.has(name)) return false
      seen.add(name)
      return true
    })
    this.lastSyncedAt = Date.now()
    return this.tools
  }

  /**
   * Call one MCP tool.
   * @param {string} name raw MCP tool name
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal, timeoutMs?: number, limit?: number }} options
   */
  async callTool(name, args, { signal, timeoutMs, limit } = {}) {
    const result = await this.#rpc('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs: timeoutMs ?? this.timeoutMs })
    const flattened = flattenToolResult(result, limit ?? 24_000)
    if (result && typeof result === 'object' && result.isError === true) {
      throw new McpError(flattened.text, { code: 'tool_error', data: result })
    }
    return { ...flattened, structured: result?.structuredContent ?? null }
  }
}
