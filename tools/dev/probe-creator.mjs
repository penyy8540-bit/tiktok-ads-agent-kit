/**
 * 探测：flat 端点里有没有「素材发布时间 / 达人名」相关工具，并实测能否拿到发布时间/达人
 * 用法：node tools/dev/probe-creator.mjs
 */
import { createAdsCore, MODES } from '../../lib/core.js'

const core = createAdsCore({ settings: { mode: 'flat' }, log: (m) => console.error(`[probe] ${m}`) })
console.log('resource:', core.settings.resourceUrl, '| flat:', MODES.flat)

const session = await core.ensureSession({ force: true })
console.log('flat 工具数:', session.tools.length)

const interesting = session.tools.filter((tool) => /video|item|creator|author|post|identity|material/i.test(tool.name))
console.log('\n=== 候选工具 ===')
for (const tool of interesting.slice(0, 50)) {
  console.log(`- ${tool.name}: ${String(tool.description || '').slice(0, 100)}`)
}

// 拿一个真实素材 ID 和账户/店铺
const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const advertiser = accounts.find((row) => String(row.advertiser_name || '').includes('UK')) || accounts[0]
const advertiserId = String(advertiser.advertiser_id)
const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
const store = stores.find((row) => row.is_gmv_max_available === true)
console.log(`\n账户 ${advertiserId} / 店铺 ${store && store.store_id} (${store && store.store_name})`)

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

// 取今天消耗最高的素材
const campaignReport = await core.callTool('gmv_max_report_get', {
  advertiser_id: advertiserId,
  store_ids: [String(store.store_id)],
  start_date: date,
  end_date: date,
  metrics: ['cost'],
  dimensions: ['campaign_id'],
  page_size: 50,
})
const campaignIds = (campaignReport.data?.list || []).filter((r) => Number(r.metrics?.cost) > 0).map((r) => String(r.dimensions?.campaign_id || ''))
const spuReport = await core.callTool('gmv_max_report_get', {
  advertiser_id: advertiserId,
  store_ids: [String(store.store_id)],
  start_date: date,
  end_date: date,
  metrics: ['cost'],
  dimensions: ['item_group_id'],
  filtering: { campaign_ids: campaignIds },
  page_size: 500,
})
const spuIds = (spuReport.data?.list || []).map((r) => String(r.dimensions?.item_group_id || '')).filter(Boolean)
const itemReport = await core.callTool('gmv_max_report_get', {
  advertiser_id: advertiserId,
  store_ids: [String(store.store_id)],
  start_date: date,
  end_date: date,
  metrics: ['cost'],
  dimensions: ['item_id'],
  filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
  page_size: 200,
})
const items = (itemReport.data?.list || [])
  .filter((r) => Number(r.metrics?.cost) > 0)
  .map((r) => ({ itemId: String(r.dimensions?.item_id || ''), cost: Number(r.metrics?.cost) }))
  .filter((r) => r.itemId && r.itemId !== '-1')
  .sort((a, b) => b.cost - a.cost)
console.log('\n前 3 个素材:', items.slice(0, 3))
const probeItems = items.slice(0, 3).map((row) => row.itemId)
if (!probeItems.length) {
  console.log('今天没有素材消耗，无法探测')
  process.exit(0)
}

const candidates = [
  ['gmv_max_video_get', { advertiser_id: advertiserId, store_id: String(store.store_id), item_ids: probeItems }],
  ['tt_video_info_get', { advertiser_id: advertiserId, item_ids: probeItems }],
  ['identity_video_get', { advertiser_id: advertiserId, item_type: 'VIDEO' }],
  ['identity_get', { advertiser_id: advertiserId }],
  ['file_video_ad_info_get', { advertiser_id: advertiserId }],
]

for (const [name, args] of candidates) {
  const exists = session.tools.some((tool) => tool.name === name)
  if (!exists) {
    console.log(`\n--- ${name}: 工具不存在（flat 端点未暴露）`)
    continue
  }
  try {
    const result = await core.callTool(name, args)
    const text = JSON.stringify(result).slice(0, 900)
    console.log(`\n--- ${name} ok: ${text}`)
  } catch (error) {
    console.log(`\n--- ${name} 失败: ${error.message}`)
  }
}
