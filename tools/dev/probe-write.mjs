/**
 * 探测当前授权下「写操作」能力：列工具 + 看 GMV Max 相关
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
const tools = core.cachedCatalog()
console.log(`layer 目录工具数: ${tools.length}`)

const writeWords = /(update|create|delete|remove|pause|enable|disable|budget|bid|status)/i
const writes = tools.filter((tool) => writeWords.test(tool.name))
console.log(`\n=== 看起来是写操作的工具（${writes.length} 个）===`)
for (const tool of writes) console.log(`- ${tool.name}: ${String(tool.description || '').slice(0, 80)}`)

console.log('\n=== GMV Max 相关 ===')
for (const tool of tools.filter((t) => /gmv/i.test(t.name))) {
  console.log(`- ${tool.name}: ${String(tool.description || '').slice(0, 90)}`)
}

// 试探：flat 里常见的写工具是否能通过 tool_execute 触达（不真正执行写，用缺参数看报错类型）
const candidates = ['campaign_update', 'adgroup_update', 'campaign_gmv_max_update', 'adgroup_gmv_max_update', 'gmv_max_campaign_update']
console.log('\n=== 探测工具是否存在（缺参数调用，只看是否 unknown tool）===')
for (const name of candidates) {
  try {
    await core.callTool(name, {})
    console.log(`- ${name}: 可调用（返回成功，意外）`)
  } catch (error) {
    const message = String(error.message)
    const unknown = /unknown tool|not found|不存在/i.test(message)
    console.log(`- ${name}: ${unknown ? '不存在' : '存在（参数错误）'} :: ${message.slice(0, 120)}`)
  }
}
