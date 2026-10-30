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

/** 报表结果缓存时长：素材级一次要翻 7+ 页，重复刷新没必要重新拉 */
export const REPORT_CACHE_TTL_MS = 45_000
/** 最多缓存多少组结果（按 账户条件 + 日期区间） */
const REPORT_CACHE_LIMIT = 100
const reportCache = new Map()

/** 清空报表缓存（测试或强制刷新时用） */
export function clearReportCache() {
  reportCache.clear()
}

const cacheKeyOf = (kind, filter, range) =>
  [kind, filter.advertiserId || '', range.start || '', range.end || ''].join('|')

function readCacheEntry(key) {
  const hit = reportCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > REPORT_CACHE_TTL_MS) {
    reportCache.delete(key)
    return null
  }
  return hit.data
}

function writeCacheEntry(key, data) {
  if (reportCache.size >= REPORT_CACHE_LIMIT) {
    const oldest = reportCache.keys().next().value
    if (oldest !== undefined) reportCache.delete(oldest)
  }
  reportCache.set(key, { at: Date.now(), data })
}

/** TikTok 报表单页上限；超过这个数量必须翻页，否则会静默漏数 */
export const REPORT_PAGE_SIZE = 1000
/** 翻页保护上限：避免接口分页信息异常时无限循环 */
export const REPORT_MAX_PAGES = 50

/**
 * 分页拉完一个 gmv_max_report_get 查询。
 *
 * TikTok 返回 `data.page_info = { page, page_size, total_number, total_page }`。
 * 这里按 total_page 一直翻到最后一页；如果接口没有返回分页信息且第一页就满了，
 * 会返回 truncated + warning（绝不静默丢数据）。
 *
 * @param {{ callTool: (name: string, params: object) => Promise<any> }} core
 * @param {Record<string, unknown>} params 报表参数（不含 page / page_size）
 * @param {{ pageSize?: number, maxPages?: number }} [options]
 * @returns {Promise<{ rows: any[], pages: number, truncated: boolean, warning: string }>}
 */
export async function fetchReportRows(core, params, options = {}) {
  const pageSize = Math.max(1, Math.min(REPORT_PAGE_SIZE, Number(options.pageSize) || REPORT_PAGE_SIZE))
  const maxPages = Math.max(1, Number(options.maxPages) || REPORT_MAX_PAGES)
  const rows = []
  let page = 1
  let truncated = false
  let warning = ''
  let lastPage = 1

  while (page <= maxPages) {
    const result = await core.callTool('gmv_max_report_get', { ...params, page, page_size: pageSize })
    const list = result?.data?.list || []
    rows.push(...list)
    const info = result?.data?.page_info || null
    const totalNumber = Number(info?.total_number)
    const totalPage = Number(info?.total_page)
    lastPage = page

    if (Number.isFinite(totalPage) && totalPage > 0) {
      if (page >= totalPage) break
      if (list.length === 0) {
        // 分页信息说还有，但实际返回空：标记出来，别假装完整
        truncated = true
        warning = `第 ${page} 页返回空，但接口声明共 ${totalPage} 页，结果可能不完整`
        break
      }
      page += 1
      continue
    }

    if (Number.isFinite(totalNumber) && totalNumber > 0) {
      if (rows.length >= totalNumber) break
      if (list.length === 0) {
        truncated = true
        warning = `已有 ${rows.length}/${totalNumber} 行，但接口返回空页，结果可能不完整`
        break
      }
      page += 1
      continue
    }

    // 完全没有分页信息：单页已满就无法确认是否还有下一页
    if (list.length >= pageSize) {
      truncated = true
      warning = `接口未返回分页信息且单页已满（${pageSize} 行），无法确认是否还有更多数据`
    }
    break
  }

  if (page > maxPages) {
    truncated = true
    warning = warning || `翻页达到上限 ${maxPages} 页，结果可能不完整`
  }
  return { rows, pages: lastPage, truncated, warning }
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
  const key = cacheKeyOf('campaign', filter, range)
  if (!filter.noCache) {
    const cached = readCacheEntry(key)
    if (cached) return cached
  }
  const accounts = await getAccounts(core)
  const rows = []
  const warnings = []
  for (const account of accounts) {
    if (filter.advertiserId && String(account.advertiserId) !== String(filter.advertiserId)) continue
    const paged = await fetchReportRows(core, {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders', 'gross_revenue'],
      dimensions: ['campaign_id'],
    })
    if (paged.truncated) warnings.push(`${account.storeName}: ${paged.warning}`)
    for (const row of paged.rows) {
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
  const result = {
    range,
    totals: {
      ...totals,
      roi: totals.cost ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
      costPerOrder: totals.orders ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
    },
    campaigns: rows,
    truncated: warnings.length > 0,
    warnings,
  }
  if (!filter.noCache) writeCacheEntry(key, result)
  return result
}

/** 素材级明细（item_id 需要 campaign_ids + item_group_ids 双锚点） */
export async function getCreativeReport(core, range, filter = {}) {
  const key = cacheKeyOf('creative', filter, range)
  if (!filter.noCache) {
    const cached = readCacheEntry(key)
    if (cached) return cached
  }
  const accounts = await getAccounts(core)
  const rows = []
  const warnings = []
  for (const account of accounts) {
    if (filter.advertiserId && String(account.advertiserId) !== String(filter.advertiserId)) continue
    const campaignPaged = await fetchReportRows(core, {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost'],
      dimensions: ['campaign_id'],
    }, { pageSize: 1000 })
    if (campaignPaged.truncated) warnings.push(`${account.storeName}: ${campaignPaged.warning}`)
    const campaignIds = campaignPaged.rows
      .filter((row) => num(row.metrics?.cost) > 0)
      .map((row) => String(row.dimensions?.campaign_id || ''))
      .filter(Boolean)
    if (!campaignIds.length) continue
    const spuPaged = await fetchReportRows(core, {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders'],
      dimensions: ['item_group_id'],
      filtering: { campaign_ids: campaignIds },
    })
    if (spuPaged.truncated) warnings.push(`${account.storeName}: ${spuPaged.warning}`)
    const spuIds = spuPaged.rows
      .filter((row) => num(row.metrics?.cost) > 0 || num(row.metrics?.orders) > 0)
      .map((row) => String(row.dimensions?.item_group_id || ''))
      .filter(Boolean)
    if (!spuIds.length) continue
    const itemPaged = await fetchReportRows(core, {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders', 'gross_revenue', 'product_clicks'],
      dimensions: ['item_id'],
      filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
    })
    if (itemPaged.truncated) warnings.push(`${account.storeName}: ${itemPaged.warning}`)
    for (const row of itemPaged.rows) {
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
  const result = { range, count: rows.length, creatives: rows, truncated: warnings.length > 0, warnings }
  if (!filter.noCache) writeCacheEntry(key, result)
  return result
}
