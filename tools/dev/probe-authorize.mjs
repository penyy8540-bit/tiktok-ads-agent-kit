/**
 * Validate the OAuth authorize-URL contract without logging in:
 * DCR -> build authorize URL -> GET it -> inspect status/body.
 *
 *   node tools/probe-authorize.mjs [--proxy http://127.0.0.1:7890] [--port 43113]
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { httpRequest, parseProxy } from '../lib/transport.js'
import { buildAuthorizeUrl, discoverMetadata, registerClient } from '../lib/oauth.js'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const config = normalizeConfig({
  mode: argValue('--mode', 'layer'),
  proxy: argValue('--proxy', 'auto'),
  callbackPort: Number(argValue('--port', '43113')),
})
const resolved = resolveProxy(config.proxySetting)
const proxy = parseProxy(resolved.proxy)
const redirectUri = `http://127.0.0.1:${config.callbackPort}/callback`

console.log(`端点：${config.resourceUrl}`)
console.log(`代理：${resolved.proxy ?? '直连'}（${resolved.source}）`)

const metadata = await discoverMetadata(config.resourceUrl, { proxy, timeoutMs: config.requestTimeoutMs })
const registration = await registerClient(metadata, { redirectUri, proxy, timeoutMs: config.requestTimeoutMs })
console.log(`DCR client_id：${registration.clientId}`)

const url = buildAuthorizeUrl(metadata, {
  clientId: registration.clientId,
  redirectUri,
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  state: 'probe-state',
  scope: config.oauthScopes,
  resource: config.resourceUrl,
})
console.log(`\n授权 URL（含 resource 参数）：\n${url}\n`)

const withResource = await httpRequest(url, { proxy, timeoutMs: config.requestTimeoutMs })
const body = withResource.text
console.log(`含 resource：HTTP ${withResource.status}，content-type=${withResource.headers['content-type'] || '?'}，${body.length} 字节`)
console.log(`  首行：${body.slice(0, 160).replace(/\s+/g, ' ').trim()}`)
for (const marker of ['mcp-tt4b', 'client_id', 'code_challenge', 'redirect_uri', '登录', 'Log in', 'error']) {
  if (body.includes(marker)) console.log(`  命中关键字：${marker}`)
}

const urlNoResource = new URL(url)
urlNoResource.searchParams.delete('resource')
const withoutResource = await httpRequest(urlNoResource.toString(), { proxy, timeoutMs: config.requestTimeoutMs })
console.log(`\n不含 resource：HTTP ${withoutResource.status}，${withoutResource.text.length} 字节`)
console.log(`  首行：${withoutResource.text.slice(0, 160).replace(/\s+/g, ' ').trim()}`)

const badClient = new URL(url)
badClient.searchParams.set('client_id', 'not-a-real-client')
const bad = await httpRequest(badClient.toString(), { proxy, timeoutMs: config.requestTimeoutMs })
console.log(`\n伪造 client_id：HTTP ${bad.status}，${bad.text.length} 字节`)
console.log(`  首行：${bad.text.slice(0, 160).replace(/\s+/g, ' ').trim()}`)
