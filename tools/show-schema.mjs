/**
 * Print input schemas for registry tools via the layer-mode `tool_get` meta tool.
 *   node tools/show-schema.mjs gmv_max_video_get identity_video_info_get ...
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'

const names = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (names.length === 0) {
  console.error('usage: node tools/show-schema.mjs <tool_name...>')
  process.exit(1)
}
const settings = normalizeConfig({ proxy: 'auto' })
const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
let auth = readAuth(settings.dataDir)
if (!isTokenUsable(auth, settings.resourceUrl)) {
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
  const tokens = await refreshAccessToken(metadata, { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl }, proxy)
  auth = updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || auth.refreshToken, expiresAt: tokens.expiresAt })
}
const session = new McpSession({ url: settings.resourceUrl, proxy, timeoutMs: 90_000, getToken: async () => auth.accessToken })
await session.connect()
const result = await session.callTool('tool_get', { tool_name_list: names }, { limit: 200_000 })
const definitions = JSON.parse(result.text)
for (const definition of definitions) {
  console.log(`\n### ${definition.name}`)
  console.log(String(definition.description || '').replace(/\s+/g, ' ').slice(0, 400))
  const schema = definition.inputSchema || {}
  console.log(`required: ${(schema.required || []).join(', ') || '(none)'}`)
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const type = spec.type || (spec.enum ? 'enum' : '?')
    const enumText = Array.isArray(spec.enum) ? ` enum=${spec.enum.join('|').slice(0, 200)}` : ''
    console.log(`  - ${key} (${type})${enumText}: ${String(spec.description || '').replace(/\s+/g, ' ').slice(0, 150)}`)
  }
}
