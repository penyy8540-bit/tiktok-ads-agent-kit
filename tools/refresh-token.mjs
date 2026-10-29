/**
 * Force a token refresh with the stored refresh_token and verify the new access
 * token works. This is the path the daily daemon depends on after 24 hours.
 *
 *   node tools/refresh-token.mjs [--proxy http://127.0.0.1:7890]
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { readAuth, updateAuth } from '../lib/store.js'
import { McpSession } from '../lib/mcp.js'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const settings = normalizeConfig({ proxy: argValue('--proxy', 'auto') })
const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
const before = readAuth(settings.dataDir)
if (!before.refreshToken || !before.clientId) {
  console.error('缺少 refresh_token/clientId，需要重新授权')
  process.exit(1)
}
console.log(`旧 access_token 尾号 ${String(before.accessToken || '').slice(-6)}，到期 ${before.expiresAt ? new Date(before.expiresAt).toLocaleString('zh-CN') : '未知'}`)
console.log(`旧 refresh_token 尾号 ${String(before.refreshToken).slice(-6)}`)

const metadata = await discoverMetadata(settings.resourceUrl, { proxy, timeoutMs: settings.requestTimeoutMs })
const tokens = await refreshAccessToken(
  metadata,
  { clientId: before.clientId, refreshToken: before.refreshToken, resource: settings.resourceUrl },
  proxy,
  undefined,
  settings.requestTimeoutMs,
)
const after = updateAuth(settings.dataDir, {
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken || before.refreshToken,
  expiresAt: tokens.expiresAt,
  scope: tokens.scope || before.scope,
})
console.log(`✅ 续期成功：新 access_token 尾号 ${after.accessToken.slice(-6)}，到期 ${after.expiresAt ? new Date(after.expiresAt).toLocaleString('zh-CN') : '未知'}`)
console.log(`   refresh_token ${tokens.refreshToken ? '已轮换' : '未轮换（沿用旧值）'}`)

const session = new McpSession({
  url: settings.resourceUrl,
  proxy,
  timeoutMs: settings.requestTimeoutMs,
  getToken: async () => after.accessToken,
})
await session.connect()
console.log(`✅ 新令牌可用：${session.serverInfo?.name} 工具 ${session.tools.length} 个`)
