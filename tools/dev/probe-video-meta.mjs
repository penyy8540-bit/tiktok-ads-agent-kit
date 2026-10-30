/**
 * 在 layer 端点下尝试视频/达人相关工具（这些工具未在 layer 目录里）
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
console.log('resource:', core.settings.resourceUrl)

const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

let picked = null
for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
  const store = stores.find((row) => row.is_gmv_max_available === true)
  if (!store) continue
  const storeId = String(store.store_id)
  try {
    const campaignReport = await core.callTool('gmv_max_report_get', {
      advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
      metrics: ['cost'], dimensions: ['campaign_id'], page_size: 50,
    })
    const campaignIds = (campaignReport.data?.list || [])
      .filter((row) => Number(row.metrics?.cost) > 0)
      .map((row) => String(row.dimensions?.campaign_id || ''))
    if (!campaignIds.length) continue
    picked = { advertiserId, storeId, storeName: store.store_name, campaignIds }
    break
  } catch {
    continue
  }
}
if (!picked) {
  console.log('没有任何账户今天有消耗，无法探测')
  process.exit(0)
}
console.log(`账户 ${picked.advertiserId} 店铺 ${picked.storeId} ${picked.storeName}`)

const spuReport = await core.callTool('gmv_max_report_get', {
  advertiser_id: picked.advertiserId, store_ids: [picked.storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['item_group_id'], filtering: { campaign_ids: picked.campaignIds }, page_size: 500,
})
const spuIds = (spuReport.data?.list || []).map((row) => String(row.dimensions?.item_group_id || '')).filter(Boolean)
const itemReport = await core.callTool('gmv_max_report_get', {
  advertiser_id: picked.advertiserId, store_ids: [picked.storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['item_id'],
  filtering: { campaign_ids: picked.campaignIds, item_group_ids: spuIds }, page_size: 200,
})
const items = (itemReport.data?.list || [])
  .filter((row) => Number(row.metrics?.cost) > 0)
  .map((row) => ({ itemId: String(row.dimensions?.item_id || ''), cost: Number(row.metrics?.cost) }))
  .filter((row) => row.itemId && row.itemId !== '-1')
  .sort((a, b) => b.cost - a.cost)
console.log('前 3 素材:', items.slice(0, 3))
const itemIds = items.slice(0, 3).map((row) => row.itemId)
if (!itemIds.length) process.exit(0)

const attempts = [
  ['gmv_max_video_get', { advertiser_id: picked.advertiserId, store_id: picked.storeId, item_ids: itemIds }],
  ['tt_video_info_get', { advertiser_id: picked.advertiserId, item_ids: itemIds }],
  ['identity_video_get', { advertiser_id: picked.advertiserId, item_type: 'VIDEO' }],
  ['file_video_ad_info_get', { advertiser_id: picked.advertiserId, video_ids: itemIds }],
]

for (const [name, args] of attempts) {
  try {
    const result = await core.callTool(name, args)
    console.log(`\n--- ${name} OK:`, JSON.stringify(result).slice(0, 1500))
  } catch (error) {
    console.log(`\n--- ${name} 失败:`, String(error.message).slice(0, 200))
  }
}
