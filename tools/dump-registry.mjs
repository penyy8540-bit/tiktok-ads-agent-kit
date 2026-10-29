/**
 * Capture the layer-mode progressive-disclosure registry (`tool_list`) to disk
 * and print the Shop / GMV Max / report related tool names.
 *
 *   node tools/dump-registry.mjs [--proxy http://127.0.0.1:7890] [--filter shop|gmv|report]
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { readAuth } from '../lib/store.js'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const config = normalizeConfig({ mode: argValue('--mode', 'layer'), proxy: argValue('--proxy', 'auto') })
const proxy = parseProxy(resolveProxy(config.proxySetting).proxy)
const auth = readAuth(config.dataDir)
const session = new McpSession({ url: config.resourceUrl, proxy, timeoutMs: 120_000, getToken: async () => auth.accessToken })
await session.connect()

const result = await session.callTool('tool_list', {}, { limit: 400_000 })
const out = path.join(config.dataDir, 'registry-tool-list.json')
fs.writeFileSync(out, result.text)

const data = JSON.parse(result.text)
const groups = Array.isArray(data.l1) ? data.l1 : []
const tools = []
for (const group of groups) for (const tool of group.tools || []) tools.push({ group: group.group_name, ...tool })
console.log(`groups=${groups.length} tools=${tools.length} -> ${out}`)

const filter = new RegExp(argValue('--filter', 'shop|gmv|max|report|order|product'), 'i')
const hits = tools.filter((tool) => filter.test(tool.tool_name) || filter.test(String(tool.tool_summary || '')))
console.log(`matched=${hits.length}`)
for (const hit of hits.slice(0, 60)) console.log(`- [${hit.group}] ${hit.tool_name}: ${String(hit.tool_summary || '').slice(0, 100)}`)
