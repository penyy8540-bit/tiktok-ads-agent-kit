/**
 * Debug one raw MCP initialize call and print exactly what the wire returns.
 *   node tools/debug-mcp.mjs [--proxy http://127.0.0.1:7890]
 */
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'
import { parseProxy } from '../lib/transport.js'
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { readAuth } from '../lib/store.js'

const config = normalizeConfig({ proxy: process.argv.includes('--proxy') ? process.argv[process.argv.indexOf('--proxy') + 1] : 'auto' })
const { proxy: proxyString } = resolveProxy(config.proxySetting)
const proxy = parseProxy(proxyString)
const auth = readAuth(config.dataDir)
if (!auth.accessToken) {
  console.error('no access token — authorize first')
  process.exit(1)
}

const url = new URL(config.resourceUrl)
const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'debug', version: '0' } },
})

/** Open TLS (through CONNECT when proxied) */
async function connect() {
  let socket
  if (proxy) {
    socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`CONNECT ${url.hostname}:443 HTTP/1.1\r\nHost: ${url.hostname}:443\r\n\r\n`)
    await new Promise((resolve, reject) => {
      let buf = ''
      const onData = (chunk) => {
        buf += chunk.toString('latin1')
        if (buf.includes('\r\n\r\n')) {
          socket.removeListener('data', onData)
          if (/^HTTP\/1\.[01] 2\d\d/.test(buf)) resolve()
          else reject(new Error(`proxy CONNECT failed: ${buf.split('\r\n')[0]}`))
        }
      }
      socket.on('data', onData)
    })
  } else {
    socket = net.connect({ host: url.hostname, port: 443 })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
  }
  const secure = tls.connect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] })
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  return secure
}

const socket = await connect()
const started = Date.now()
let headerEnded = false
let headerText = ''
let bodyBytes = 0
let bodyText = ''
let finished = false
const lines = []
const log = (line) => {
  lines.push(`[+${String(Date.now() - started).padStart(5)}ms] ${line}`)
  console.log(lines[lines.length - 1])
}

const timer = setTimeout(() => {
  log('--- 15s elapsed, closing ---')
  finish()
}, 15_000)

function finish() {
  if (finished) return
  finished = true
  clearTimeout(timer)
  console.log('\n=== headers ===')
  console.log(headerText || '(none)')
  console.log(`\n=== body (${bodyBytes} bytes) ===`)
  console.log(bodyText.slice(0, 4000))
  socket.destroy()
  process.exit(0)
}

socket.on('data', (chunk) => {
  if (!headerEnded) {
    headerText += chunk.toString('latin1')
    const idx = headerText.indexOf('\r\n\r\n')
    if (idx >= 0) {
      headerEnded = true
      bodyText += headerText.slice(idx + 4)
      headerText = headerText.slice(0, idx)
      log(`headers received: ${headerText.split('\r\n')[0]}`)
      const ct = /content-type:\s*([^\r\n]+)/i.exec(headerText)
      const te = /transfer-encoding:\s*([^\r\n]+)/i.exec(headerText)
      const cl = /content-length:\s*([^\r\n]+)/i.exec(headerText)
      log(`content-type=${ct?.[1] || '?'} transfer-encoding=${te?.[1] || '-'} content-length=${cl?.[1] || '-'}`)
      const rest = headerText.slice(idx + 4)
      void rest
    } else return
  } else {
    bodyText += chunk.toString('utf8')
  }
  bodyBytes = Buffer.byteLength(bodyText, 'utf8')
  log(`chunk: +${chunk.length} bytes, total body=${bodyText.length}`)
  if (bodyText.trim().length > 0 && !finished) {
    try {
      const parsed = JSON.parse(bodyText.trim())
      log(`JSON parsed OK: ${JSON.stringify(parsed).slice(0, 300)}`)
      finish()
    } catch { /* incomplete or SSE */ }
  }
})
socket.once('end', () => { log('socket end'); finish() })
socket.once('close', () => { log('socket close'); finish() })

socket.write(
  `POST ${url.pathname} HTTP/1.1\r\n` +
  `Host: ${url.host}\r\n` +
  `Authorization: Bearer ${auth.accessToken}\r\n` +
  `Content-Type: application/json\r\n` +
  `Accept: application/json, text/event-stream\r\n` +
  `MCP-Protocol-Version: 2025-06-18\r\n` +
  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
  `Connection: close\r\n\r\n` +
  body,
)
log('request sent')
