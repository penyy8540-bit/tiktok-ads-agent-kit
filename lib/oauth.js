/**
 * OAuth 2.1 (authorization code + PKCE + RFC 7591 dynamic client registration)
 * for TikTok's official Ads MCP server.
 *
 * The server is a public client (`token_endpoint_auth_method: none`), so no
 * secret exists: the PKCE verifier is the only proof we hold the code request.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { httpRequest, TransportError } from './transport.js'

const DEFAULT_ISSUER_PATH = '/oauth'
const DISCOVERY_TIMEOUT_MS = 20_000

/**
 * @typedef {object} OAuthMetadata
 * @property {string} issuer
 * @property {string} authorizationEndpoint
 * @property {string} tokenEndpoint
 * @property {string} registrationEndpoint
 * @property {string} revocationEndpoint
 * @property {string[]} scopes
 */

/**
 * base64url encoding without padding.
 * @param {Buffer} buffer
 */
function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh PKCE verifier/challenge pair (S256). */
export function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** A CSRF-safe OAuth state value. */
export function randomState() {
  return base64url(crypto.randomBytes(24))
}

/**
 * Fetch JSON, returning null on any failure (discovery is best effort).
 * @param {string} url
 * @param {{ proxy?: import('node:url').URL | null, timeoutMs?: number, signal?: AbortSignal }} options
 */
async function getJson(url, { proxy = null, timeoutMs = DISCOVERY_TIMEOUT_MS, signal } = {}) {
  const response = await httpRequest(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    proxy,
    timeoutMs,
    signal,
  })
  if (response.status < 200 || response.status >= 300) return null
  try {
    return JSON.parse(response.text)
  } catch {
    return null
  }
}

/**
 * Discover OAuth metadata for an MCP resource (RFC 9728 then RFC 8414).
 * Falls back to the endpoints published by TikTok when discovery is blocked.
 *
 * @param {string} resourceUrl MCP endpoint, e.g. .../tt-ads-mcp-layer
 * @param {{ proxy?: import('node:url').URL | null, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<OAuthMetadata>}
 */
export async function discoverMetadata(resourceUrl, { proxy = null, signal, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const resource = new URL(resourceUrl)
  const origin = resource.origin
  const fallbackIssuer = `${origin}${resource.pathname}${DEFAULT_ISSUER_PATH}`
  const fallback = {
    issuer: fallbackIssuer,
    authorizationEndpoint: `${origin}/portal/mcp-tt4b-authorize`,
    tokenEndpoint: `${fallbackIssuer}/token`,
    registrationEndpoint: `${fallbackIssuer}/register`,
    revocationEndpoint: `${fallbackIssuer}/revoke`,
    scopes: ['mcp:tt4b'],
  }

  let issuer = fallback.issuer
  try {
    const protectedResource = await getJson(`${origin}/.well-known/oauth-protected-resource${resource.pathname}`, { proxy, signal, timeoutMs })
    const servers = protectedResource?.authorization_servers
    if (Array.isArray(servers) && typeof servers[0] === 'string' && servers[0]) issuer = servers[0]
  } catch {
    // keep the documented default issuer
  }

  try {
    const metadata = await getJson(`${issuer}/.well-known/oauth-authorization-server`, { proxy, signal, timeoutMs })
    if (metadata?.authorization_endpoint && metadata?.token_endpoint) {
      return {
        issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint || `${issuer}/register`,
        revocationEndpoint: metadata.revocation_endpoint || `${issuer}/revoke`,
        scopes: Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.length ? metadata.scopes_supported : fallback.scopes,
      }
    }
  } catch {
    // fall through to the published defaults
  }
  return fallback
}

/**
 * Register this plugin as a public OAuth client (RFC 7591).
 *
 * @param {OAuthMetadata} metadata
 * @param {{ redirectUri: string, clientName?: string, proxy?: import('node:url').URL | null, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ clientId: string, redirectUri: string }>}
 */
export async function registerClient(metadata, { redirectUri, clientName = 'DeepSeek Harness TikTok Ads', proxy = null, signal, timeoutMs = DISCOVERY_TIMEOUT_MS }) {
  const body = JSON.stringify({
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp:tt4b',
  })
  const response = await httpRequest(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    proxy,
    timeoutMs,
    signal,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new TransportError(`Dynamic client registration 失败（HTTP ${response.status}）：${response.text.slice(0, 400)}`, {
      code: 'dcr_failed',
      status: response.status,
    })
  }
  let parsed
  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new TransportError('Dynamic client registration 返回了非 JSON 响应', { code: 'dcr_bad_body', status: response.status })
  }
  if (!parsed?.client_id) throw new TransportError('Dynamic client registration 未返回 client_id', { code: 'dcr_no_client_id' })
  return { clientId: String(parsed.client_id), redirectUri }
}

/**
 * Build the browser authorization URL.
 * @param {OAuthMetadata} metadata
 * @param {{ clientId: string, redirectUri: string, challenge: string, state: string, scope: string, resource: string }} input
 */
export function buildAuthorizeUrl(metadata, input) {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  url.searchParams.set('scope', input.scope)
  url.searchParams.set('resource', input.resource)
  return url.toString()
}

/**
 * Exchange an authorization code for tokens.
 * @param {OAuthMetadata} metadata
 * @param {object} input
 * @param {string} input.clientId
 * @param {string} input.code
 * @param {string} input.redirectUri
 * @param {string} input.codeVerifier
 * @param {string} input.resource
 * @param {import('node:url').URL | null} [proxy]
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number, scope?: string }>}
 */
export async function exchangeCode(metadata, input, proxy = null, signal, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  return tokenRequest(
    metadata,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    },
    proxy,
    signal,
    timeoutMs,
  )
}

/**
 * Refresh an access token.
 * @param {OAuthMetadata} metadata
 * @param {{ clientId: string, refreshToken: string, resource: string }} input
 * @param {import('node:url').URL | null} [proxy]
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 */
export async function refreshAccessToken(metadata, input, proxy = null, signal, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  return tokenRequest(
    metadata,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: input.resource,
    },
    proxy,
    signal,
    timeoutMs,
  )
}

/**
 * @param {OAuthMetadata} metadata
 * @param {Record<string, string>} form
 * @param {import('node:url').URL | null} proxy
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 */
async function tokenRequest(metadata, form, proxy, signal, timeoutMs) {
  const body = new URLSearchParams(form).toString()
  const response = await httpRequest(metadata.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    proxy,
    timeoutMs,
    signal,
  })
  let parsed = null
  try {
    parsed = JSON.parse(response.text)
  } catch {
    parsed = null
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = parsed?.error ? `${parsed.error}${parsed.error_description ? `：${parsed.error_description}` : ''}` : response.text.slice(0, 400)
    throw new TransportError(`token 请求失败（HTTP ${response.status}）：${detail}`, { code: 'token_failed', status: response.status })
  }
  if (!parsed?.access_token) throw new TransportError('token 响应缺少 access_token', { code: 'token_bad_body', status: response.status })
  const expiresIn = Number(parsed.expires_in)
  return {
    accessToken: String(parsed.access_token),
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  }
}

/**
 * Revoke a token (best effort).
 * @param {OAuthMetadata} metadata
 * @param {{ clientId: string, token: string, tokenTypeHint?: string }} input
 * @param {import('node:url').URL | null} [proxy]
 */
export async function revokeToken(metadata, input, proxy = null) {
  try {
    const response = await httpRequest(metadata.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: input.clientId,
        token: input.token,
        token_type_hint: input.tokenTypeHint || 'access_token',
      }).toString(),
      proxy,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    })
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

/**
 * Start the loopback redirect listener the browser returns to.
 *
 * @param {{ port: number, path?: string, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ redirectUri: string, waitForCode: (state: string) => Promise<string>, close: () => void }>}
 */
export async function startCallbackServer({ port, path: callbackPath = '/callback', timeoutMs, signal }) {
  /** @type {(value: { code: string, state: string }) => void} */
  let settle
  /** @type {(error: Error) => void} */
  let rejectHandle
  const result = new Promise((resolve, reject) => {
    settle = resolve
    rejectHandle = reject
  })

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') || ''
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
    if (error) {
      response.end(page('授权失败', `TikTok 返回错误：<code>${escapeHtml(error)}</code><p>${escapeHtml(url.searchParams.get('error_description') || '')}</p><p>你可以关闭此页面并回到 DSH 重试。</p>`))
      rejectHandle(new TransportError(`授权被拒绝：${error}${url.searchParams.get('error_description') ? `（${url.searchParams.get('error_description')}）` : ''}`, { code: 'auth_denied' }))
      return
    }
    response.end(page('授权成功', '<p>已收到 TikTok 授权，正在返回 DeepSeek Harness…</p><p>本页面可以关闭。</p>'))
    settle({ code: code || '', state })
  })

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      const hint = error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可在插件配置里改 callbackPort` : error.message
      reject(new TransportError(`本地回调服务启动失败：${hint}`, { code: 'callback_server_failed', cause: error }))
    })
    server.listen(port, '127.0.0.1', () => resolve())
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      server.close()
    } catch { /* already closed */ }
  }

  const timer = setTimeout(() => {
    rejectHandle(new TransportError(`等待授权超时（${Math.round(timeoutMs / 1000)} 秒）`, { code: 'auth_timeout' }))
    close()
  }, timeoutMs)
  timer.unref?.()
  signal?.addEventListener('abort', () => {
    rejectHandle(new TransportError('授权已被取消', { code: 'auth_aborted' }))
    close()
  }, { once: true })

  return {
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
    /**
     * @param {string} expectedState
     * @returns {Promise<string>} authorization code
     */
    async waitForCode(expectedState) {
      try {
        const { code, state } = await result
        if (!code) throw new TransportError('回调缺少 code 参数', { code: 'auth_no_code' })
        if (expectedState && state !== expectedState) throw new TransportError('OAuth state 不匹配，已中止（可能是过期或伪造的回调）', { code: 'auth_state_mismatch' })
        return code
      } finally {
        clearTimeout(timer)
        close()
      }
    },
    close,
  }
}

/**
 * Best-effort system browser launch.
 *
 * On Windows we deliberately avoid `cmd /c start`: cmd re-parses the command
 * line, so an unquoted URL containing `&` loses every query parameter after the
 * first one (the authorize page then renders "Missing required parameter(s)").
 * `explorer.exe <url>` hands the URL to the shell verbatim, and `rundll32` is
 * the fallback when explorer is unavailable (some minimal/Server installs).
 * @param {string} url
 */
export function openExternal(url) {
  /** @param {string} command @param {string[]} args */
  const launch = (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {
      const fallback = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
      fallback.on('error', () => {})
      fallback.unref()
    })
    child.unref()
    return true
  }
  try {
    if (process.platform === 'win32') return launch('explorer.exe', [url])
    if (process.platform === 'darwin') return launch('open', [url])
    return launch('xdg-open', [url])
  } catch {
    return false
  }
}

/** @param {string} text */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
}

/**
 * @param {string} title
 * @param {string} body
 */
function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · TikTok Ads</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:36rem;margin:18vh auto;padding:0 1.5rem;line-height:1.6;color:light-dark(#111,#f5f5f5);background:light-dark(#fff,#1b1b1f)}h1{font-size:1.35rem;margin:0 0 .75rem}code{background:light-dark(#f2f3f5,#2a2b30);padding:.1rem .35rem;border-radius:.3rem}p{color:light-dark(#444,#c9c9cf)}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}
