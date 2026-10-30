import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[dbg] ${m}`) })
const pad = (n) => String(n).padStart(2, '0')
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const end = new Date(Date.now() - 86_400_000)
const start = new Date(end.getTime() - 2 * 86_400_000)

const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  let stores = []
  try {
    stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
  } catch { continue }
  const store = stores.find((row) => row.is_gmv_max_available === true)
  if (!store) continue
  const storeId = String(store.store_id)
  const current = await core.callTool('gmv_max_report_get', {
    advertiser_id: advertiserId, store_ids: [storeId], start_date: iso(start), end_date: iso(end),
    metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue', 'roi'], dimensions: ['campaign_id'], page_size: 200,
  })
  const prevEnd = new Date(start.getTime() - 86_400_000)
  const prevStart = new Date(prevEnd.getTime() - 2 * 86_400_000)
  const previous = await core.callTool('gmv_max_report_get', {
    advertiser_id: advertiserId, store_ids: [storeId], start_date: iso(prevStart), end_date: iso(prevEnd),
    metrics: ['campaign_name', 'cost', 'orders'], dimensions: ['campaign_id'], page_size: 200,
  })
  const cur = (current.data?.list || []).map((row) => ({ id: row.dimensions.campaign_id, cost: Number(row.metrics.cost), orders: Number(row.metrics.orders) }))
  const pre = (previous.data?.list || []).map((row) => ({ id: row.dimensions.campaign_id, cost: Number(row.metrics.cost), orders: Number(row.metrics.orders) }))
  console.log(`\n${account.advertiser_name} 当前窗口 ${iso(start)}~${iso(end)}: ${cur.length} 行, 合计 $${cur.reduce((s, r) => s + r.cost, 0).toFixed(2)}`)
  console.log(`  上一窗口 ${iso(prevStart)}~${iso(prevEnd)}: ${pre.length} 行, 合计 $${pre.reduce((s, r) => s + r.cost, 0).toFixed(2)}`)
  const prevMap = new Map(pre.map((r) => [r.id, r]))
  for (const row of cur.filter((r) => r.cost >= 1)) {
    const before = prevMap.get(row.id)
    if (!before) continue
    const ratio = before.cost > 0 ? row.cost / before.cost : Infinity
    if (ratio >= 1.5 && row.orders <= before.orders) {
      console.log(`  候选 spike: ${row.id} $${before.cost}→$${row.cost} (${ratio.toFixed(1)}×) orders ${before.orders}→${row.orders}`)
    }
  }
  break
}
