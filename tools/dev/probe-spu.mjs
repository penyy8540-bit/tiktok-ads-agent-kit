import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: () => {} })
const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const account = accounts[0]
const advertiserId = String(account.advertiser_id)
const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
const store = stores.find((row) => row.is_gmv_max_available === true)
const storeId = String(store.store_id)
const range = { start: '2026-11-21', end: '2026-11-27' }
console.log('account:', advertiserId, store.store_name)

async function tryCall(label, params) {
  try {
    const r = await core.callTool('gmv_max_report_get', {
      advertiser_id: advertiserId,
      store_ids: [storeId],
      start_date: range.start,
      end_date: range.end,
      page_size: 50,
      ...params,
    })
    const list = r.data?.list || []
    console.log(`\n[${label}] ok, rows=${list.length}, total=${r.data?.page_info?.total_number ?? 'n/a'}`)
    console.log('  示例:', JSON.stringify(list.slice(0, 2)))
  } catch (error) {
    console.log(`\n[${label}] 失败: ${String(error.message).slice(0, 160)}`)
  }
}

await tryCall('item_group_id 无过滤', { metrics: ['cost', 'orders', 'gross_revenue'], dimensions: ['item_group_id'] })

// 先拿有消耗的广告组，再带上 campaign_ids 过滤
const campaigns = await core.callTool('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId],
  start_date: range.start, end_date: range.end,
  metrics: ['cost'], dimensions: ['campaign_id'], page_size: 200,
})
const campaignIds = (campaigns.data?.list || [])
  .filter((row) => Number(row.metrics?.cost) > 0)
  .map((row) => String(row.dimensions?.campaign_id || ''))
  .filter(Boolean)
console.log('\n有消耗的广告组:', campaignIds.length)
await tryCall('item_group_id + campaign_ids 过滤', {
  metrics: ['cost', 'orders', 'gross_revenue', 'product_clicks', 'product_impressions'],
  dimensions: ['item_group_id'],
  filtering: { campaign_ids: campaignIds.slice(0, 20) },
  page_size: 500,
})
