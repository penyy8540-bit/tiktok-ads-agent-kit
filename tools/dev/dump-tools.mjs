/**
 * Dump the live MCP tool catalog with full input schemas for the layer/flat
 * endpoint, so callers know the exact parameter contract.
 *
 *   node tools/dump-tools.mjs [--query report] [--out path]
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { readAuth, isTokenUsable } from '../lib/store.js'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const config = normalizeConfig({ mode: argValue('--mode', 'layer'), proxy: argValue('--proxy', 'auto') })
const { proxy: proxyString } = resolveProxy(config.proxySetting)
const proxy = parseProxy(proxyString)
const auth = readAuth(config.dataDir)
if (!auth.accessToken) {
  console.error('缺少 access token，请先完成授权')
  process.exit(1)
}
if (!isTokenUsable(auth, config.resourceUrl)) {
  console.error('access token 已过期或与当前端点不匹配，请重新授权')
  process.exit(1)
}

const session = new McpSession({
  url: config.resourceUrl,
  proxy,
  timeoutMs: config.requestTimeoutMs,
  getToken: async () => auth.accessToken,
})
await session.connect()
console.log(`server=${session.serverInfo?.name} tools=${session.tools.length}`)

const query = (argValue('--query', '') || '').toLowerCase()
const selected = query
  ? session.tools.filter((tool) => `${tool.name} ${tool.description || ''}`.toLowerCase().includes(query))
  : session.tools

const outFile = argValue('--out', path.join(config.dataDir, 'tools-schema.json'))
fs.writeFileSync(outFile, JSON.stringify(selected.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), null, 2))
console.log(`matched=${selected.length} -> ${outFile}`)

for (const tool of selected.slice(0, 12)) {
  const schema = tool.inputSchema || {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const props = schema.properties ? Object.keys(schema.properties) : []
  console.log(`\n- ${tool.name}`)
  console.log(`  required: ${required.join(', ') || '(none)'}`)
  console.log(`  properties: ${props.slice(0, 20).join(', ')}${props.length > 20 ? ' …' : ''}`)
}
