/**
 * 探测 gmv_max_report_get 的分页返回结构
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
  const store = stores.find((row) => row.is_gmv_max_available === true)
  if (!store) continue
  const result = await core.callTool('gmv_max_report_get', {
    advertiser_id: advertiserId,
    store_ids: [String(store.store_id)],
    start_date: date,
    end_date: date,
    metrics: ['cost'],
    dimensions: ['campaign_id'],
    page: 1,
    page_size: 2,
  })
  console.log('顶层 keys:', Object.keys(result))
  console.log('data keys:', Object.keys(result.data || {}))
  console.log('page_info:', JSON.stringify(result.data?.page_info || result.page_info || null))
  console.log('list 长度:', (result.data?.list || []).length)
  console.log('完整(截断):', JSON.stringify(result).slice(0, 900))
  break
}
