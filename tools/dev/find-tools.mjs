/**
 * List registry tools matching a keyword (product / SKU / creative / identity).
 *   node tools/find-tools.mjs [keyword]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const keyword = process.argv[2] || 'product|sku|item|creative|video|post|identity'
const pattern = new RegExp(keyword, 'i')
const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugin-data', 'tiktok-ads', 'registry-tool-list.json')
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const all = []
for (const group of data.l1 || []) {
  for (const tool of group.tools || []) all.push({ group: group.group_name, name: tool.tool_name, summary: String(tool.tool_summary || '') })
}
console.log(`registry tools=${all.length}`)
const hits = all.filter((entry) => pattern.test(entry.name) || pattern.test(entry.summary))
console.log(`matches=${hits.length}`)
for (const hit of hits) console.log(`[${hit.group}] ${hit.name}: ${hit.summary.slice(0, 110)}`)
