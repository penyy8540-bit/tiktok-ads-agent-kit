/**
 * 只探测参数结构：故意用不完整参数，让接口报"缺字段"，绝不真正提交变更
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const advertiserId = String(accounts[0].advertiser_id)
console.log(`advertiser: ${advertiserId}`)

const attempts = [
  ['campaign_gmv_max_update', { advertiser_id: advertiserId }],
  ['campaign_gmv_max_update', { advertiser_id: advertiserId, campaign_id: '0' }],
  ['campaign_update', { advertiser_id: advertiserId }],
  ['adgroup_update', { advertiser_id: advertiserId }],
]

for (const [name, args] of attempts) {
  try {
    const result = await core.callTool(name, args)
    console.log(`\n${name} ${JSON.stringify(args)} -> 成功返回: ${JSON.stringify(result).slice(0, 300)}`)
  } catch (error) {
    console.log(`\n${name} ${JSON.stringify(args).slice(0, 80)}`)
    console.log(`   错误: ${String(error.message).slice(0, 300)}`)
  }
}
