/**
 * 常用查询（CLI / MCP server / 其他宿主共用）。
 * 全部返回纯 JSON，不含任何框架依赖。
 */
const num = (value) => Number(value) || 0

const pad = (value) => String(value).padStart(2, '0')
export const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** 把 --days / --start/--end / --today 这类参数归一成 {start, end} */
export function resolveRange(options = {}) {
  if (options.start && options.end) return { start: String(options.start), end: String(options.end) }
  const days = Math.max(1, Number(options.days) || 1)
  const end = options.today ? new Date() : new Date(Date.now() - (options.yesterday ? 86_400_000 : 0))
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  return { start: formatDate(start), end: formatDate(end) }
}

/** 已授权的 GMV Max 账户（带默认店铺） */
export async function getAccounts(core) {
  const authorized = (await core.callTool('auth_advertiser_get', {})).data?.list || []
  const accounts = []
  for (const account of authorized) {
    const advertiserId = String(account.advertiser_id)
    let stores = []
    try {
      stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
    } catch { /* 非 GMV Max 账户会报错，跳过 */ }
    const gmvStores = stores.filter((store) => store.is_gmv_max_available === true)
    accounts.push({
      advertiserId,
      advertiserName: account.advertiser_name || advertiserId,
      storeId: gmvStores[0] ? String(gmvStores[0].store_id) : null,
      storeName: gmvStores[0] ? String(gmvStores[0].store_name) : null,
      gmvMaxStores: gmvStores.map((store) => ({ storeId: String(store.store_id), storeName: store.store_name })),
    })
  }
  return accounts.filter((account) => account.storeId)
}

/** 广告组级汇总 */
export async function getCampaignReport(core, range, filter = {}) {
  const accounts = await getAccounts(core)
  const rows = []
  for (const account of accounts) {
    if (filter.advertiserId && String(account.advertiserId) !== String(filter.advertiserId)) continue
    const result = await core.callTool('gmv_max_report_get', {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders', 'gross_revenue'],
      dimensions: ['campaign_id'],
      page_size: 500,
    })
    for (const row of result.data?.list || []) {
      const cost = num(row.metrics?.cost)
      const revenue = num(row.metrics?.gross_revenue)
      rows.push({
        advertiserId: account.advertiserId,
        store: account.storeName,
        campaignId: String(row.dimensions?.campaign_id || ''),
        cost,
        orders: num(row.metrics?.orders),
        revenue,
        roi: cost ? Number((revenue / cost).toFixed(2)) : 0,
      })
    }
  }
  rows.sort((left, right) => right.cost - left.cost)
  const totals = rows.reduce((acc, row) => ({
    cost: acc.cost + row.cost,
    orders: acc.orders + row.orders,
    revenue: acc.revenue + row.revenue,
  }), { cost: 0, orders: 0, revenue: 0 })
  return {
    range,
    totals: {
      ...totals,
      roi: totals.cost ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
      costPerOrder: totals.orders ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
    },
    campaigns: rows,
  }
}

/** 素材级明细（item_id 需要 campaign_ids + item_group_ids 双锚点） */
export async function getCreativeReport(core, range, filter = {}) {
  const accounts = await getAccounts(core)
  const rows = []
  for (const account of accounts) {
    if (filter.advertiserId && String(account.advertiserId) !== String(filter.advertiserId)) continue
    const campaignResult = await core.callTool('gmv_max_report_get', {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost'],
      dimensions: ['campaign_id'],
      page_size: 100,
    })
    const campaignIds = (campaignResult.data?.list || [])
      .filter((row) => num(row.metrics?.cost) > 0)
      .map((row) => String(row.dimensions?.campaign_id || ''))
      .filter(Boolean)
    if (!campaignIds.length) continue
    const spuResult = await core.callTool('gmv_max_report_get', {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders'],
      dimensions: ['item_group_id'],
      filtering: { campaign_ids: campaignIds },
      page_size: 1000,
    })
    const spuIds = (spuResult.data?.list || [])
      .filter((row) => num(row.metrics?.cost) > 0 || num(row.metrics?.orders) > 0)
      .map((row) => String(row.dimensions?.item_group_id || ''))
      .filter(Boolean)
    if (!spuIds.length) continue
    const itemResult = await core.callTool('gmv_max_report_get', {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders', 'gross_revenue', 'product_clicks'],
      dimensions: ['item_id'],
      filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
      page_size: 1000,
    })
    for (const row of itemResult.data?.list || []) {
      const itemId = String(row.dimensions?.item_id || '')
      if (!itemId || itemId === '-1') continue
      const cost = num(row.metrics?.cost)
      const revenue = num(row.metrics?.gross_revenue)
      rows.push({
        advertiserId: account.advertiserId,
        store: account.storeName,
        itemId,
        cost,
        orders: num(row.metrics?.orders),
        revenue,
        roi: cost ? Number((revenue / cost).toFixed(2)) : 0,
        clicks: num(row.metrics?.product_clicks),
      })
    }
  }
  rows.sort((left, right) => right.cost - left.cost)
  return { range, count: rows.length, creatives: rows }
}
