/**
 * Glue between the plugin's MCP session and the dashboard + monitor stack:
 * data providers for the panel, persisted thresholds, scan scheduling, and
 * Feishu notification dispatch.
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AlertStore, formatFindings, normalizeRules, scanStore, sendFeishu } from './monitor.js'
import { startDashboard } from './dashboard.js'
import { createBoard } from './board.js'
import { createProducts } from './products.js'

const CONFIG_FILE = 'monitor-config.json'
const DAY_MS = 86_400_000
const pad = (n) => String(n).padStart(2, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/**
 * Load the small mutable config the dashboard writes (thresholds / webhook /
 * interval / watched accounts). Plugin config stays the fallback.
 * @param {string} dataDir
 * @param {{ rules: object, monitorIntervalMinutes: number, feishuWebhook: string, watchAll?: boolean, watchAccounts?: string[] }} defaults
 */
export function loadPanelConfig(dataDir, defaults) {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'))
  } catch { /* first run */ }
  const watchAll = typeof stored.watchAll === 'boolean' ? stored.watchAll : defaults.watchAll !== false
  const watchAccounts = Array.isArray(stored.watchAccounts)
    ? stored.watchAccounts.map(String).filter(Boolean)
    : Array.isArray(defaults.watchAccounts) ? defaults.watchAccounts.map(String) : []
  return {
    rules: normalizeRules({ ...defaults.rules, ...(stored.rules || {}) }),
    monitorIntervalMinutes: Number(stored.monitorIntervalMinutes) > 0 ? Number(stored.monitorIntervalMinutes) : defaults.monitorIntervalMinutes,
    feishuWebhook: typeof stored.feishuWebhook === 'string' ? stored.feishuWebhook : defaults.feishuWebhook,
    watchAll,
    watchAccounts,
    creativeSpendThreshold: Number(stored.creativeSpendThreshold) > 0 ? Number(stored.creativeSpendThreshold) : (defaults.creativeSpendThreshold || 5),
    boardSpeedThreshold: Number(stored.boardSpeedThreshold) > 0 ? Number(stored.boardSpeedThreshold) : (defaults.boardSpeedThreshold || 40),
    boardStallMinutes: Number(stored.boardStallMinutes) > 0 ? Number(stored.boardStallMinutes) : (defaults.boardStallMinutes || 120),
  }
}

/**
 * @param {string} dataDir
 * @param {object} config
 */
export function savePanelConfig(dataDir, config) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2))
  } catch { /* best effort */ }
  return config
}

/**
 * Minimal product_id → {sku, name} lookup from the sku-map cache + overrides.
 * @param {string} dataDir
 */
export function loadProductLookup(dataDir) {
  const map = new Map()
  const readCsv = (file) => {
    try {
      const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
      const header = (lines[0] || '').split(',').map((cell) => cell.replace(/^"|"$/g, '').trim().toLowerCase())
      const productIndex = header.indexOf('product_id')
      const skuIndex = header.indexOf('seller_sku')
      const nameIndex = header.indexOf('product_name')
      if (productIndex < 0) return
      for (const line of lines.slice(1)) {
        const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || []
        const productId = cells[productIndex]
        if (!productId) continue
        map.set(productId, { sku: skuIndex >= 0 ? cells[skuIndex] || '' : '', name: nameIndex >= 0 ? cells[nameIndex] || '' : '' })
      }
    } catch { /* ignore */ }
  }
  const cacheDir = path.join(dataDir, 'sku-map-cache')
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.toLowerCase().endsWith('.csv')) readCsv(path.join(cacheDir, name))
    }
  } catch { /* no cache */ }
  readCsv(path.join(dataDir, 'sku-overrides.csv'))
  return (productId) => map.get(String(productId)) || { sku: '', name: '' }
}

/**
 * Build the dashboard/monitor runtime.
 *
 * @param {object} options
 * @param {object} options.settings normalized plugin config
 * @param {(name: string, params: Record<string, unknown>) => Promise<any>} options.callTool
 * @param {(reason: string) => void} [options.log]
 * @param {(status: {authorized: boolean, mode: string}) => {authorized: boolean, mode: string, resource: string}} [options.getStatus]
 */
export function createPanel({ settings, callTool: rawCallTool, log = () => {}, getStatus = () => ({ authorized: false, mode: settings.mode, resource: settings.resourceUrl }) }) {
  const dataDir = settings.dataDir
  const alertStore = new AlertStore(dataDir)
  let productLookup = loadProductLookup(dataDir)

  /**
   * Wrap the MCP call with a small retry: the proxy/TikTok occasionally drops
   * the TLS handshake or returns transient 5xxxx codes during a scan.
   * @param {string} name
   * @param {Record<string, unknown>} params
   */
  async function callTool(name, params) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await rawCallTool(name, params)
      } catch (error) {
        lastError = error
        const message = String(error?.message || error)
        const rateLimited = /rate|limit|429|too many|quota/i.test(message)
        const retryable = rateLimited || /socket|ECONN|ECONNRESET|TLS|network|timeout|timed out|超时|connection_closed|响应头|\b5\d{4}\b|52404|51010|internal/i.test(message)
        if (!retryable || attempt === 2) throw error
        const delay = rateLimited ? 2500 * (attempt + 1) : 700 * (attempt + 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastError
  }
  let config = loadPanelConfig(dataDir, {
    rules: settings.rules,
    monitorIntervalMinutes: settings.monitorIntervalMinutes,
    feishuWebhook: settings.feishuWebhook,
    watchAll: true,
    watchAccounts: [],
  })
  let dashboard = null
  let timer = null
  let lastScan = { at: null, fresh: 0, resolved: 0, scannedStores: 0, errors: [] }
  // 盯盘看板（模块化：账户/广告组/多条素材）
  const products = createProducts({ dataDir, log })

  const board = createBoard({
    dataDir,
    callTool: (name, params) => callTool(name, params),
    listAccounts,
    log,
    getRules: () => ({
      spendThreshold: config.rules.spendThreshold,
      speedThreshold: config.boardSpeedThreshold,
      stallMinutes: config.boardStallMinutes,
    }),
  })
  /** 素材级不支持 stat_time_hour，用本机每分钟采样画出实时曲线。key → samples[] */
  const watchSamples = new Map()
  let scanInFlight = null

  /**
   * Reporting window. `today` switches the end date to the current day (partial
   * day; callers then ask for `stat_time_hour` so the operator sees the intraday
   * build-up), otherwise the window ends yesterday.
   * @param {number} days
   * @param {boolean} [today]
   */
  const rangeOf = (days, today = false) => {
    const end = today ? new Date() : new Date(Date.now() - DAY_MS)
    const span = Math.max(1, today ? 1 : days)
    const start = new Date(end.getTime() - (span - 1) * DAY_MS)
    return { start: formatDate(start), end: formatDate(end), days: span, today: Boolean(today) }
  }

  /**
   * Resolve a dashboard query into a reporting window.
   * Custom start/end wins; otherwise days/today as before.
   * @param {{ days?: number, today?: boolean, start?: string, end?: string }} [query]
   */
  const resolveRange = (query = {}) => {
    const start = typeof query.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.start) ? query.start : ''
    const end = typeof query.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.end) ? query.end : ''
    if (start && end) {
      const from = new Date(`${start}T00:00:00`)
      const to = new Date(`${end}T00:00:00`)
      if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
        const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1)
        return { start, end, days, today: false, custom: true }
      }
    }
    return rangeOf(Number(query.days) || 7, Boolean(query.today))
  }

  /** Hour label from a `stat_time_hour` dimension, e.g. "2026-10-29 09:00:00" → "09:00". */
  const hourLabel = (value) => {
    const text = String(value || '')
    const match = /(\d{2}):00/.exec(text)
    return match ? `${match[1]}:00` : text.slice(11, 16)
  }

  /** Aggregate rows into an hourly series (today view). */
  const hourlyRows = (rawRows) => {
    const map = new Map()
    for (const row of rawRows) {
      const stamp = String(row.dimensions?.stat_time_hour || '')
      if (!stamp) continue
      const label = hourLabel(stamp)
      const bucket = map.get(label) || { hour: label, stamp, cost: 0, orders: 0, revenue: 0 }
      bucket.cost += toNumber(row.metrics?.cost)
      bucket.orders += toNumber(row.metrics?.orders)
      bucket.revenue += toNumber(row.metrics?.gross_revenue)
      map.set(label, bucket)
    }
    return [...map.values()]
      .sort((left, right) => left.stamp.localeCompare(right.stamp))
      .map((row) => ({
        hour: row.hour,
        date: row.hour,
        cost: Number(row.cost.toFixed(2)),
        orders: row.orders,
        revenue: Number(row.revenue.toFixed(2)),
        roi: row.cost > 0 ? Number((row.revenue / row.cost).toFixed(2)) : 0,
      }))
  }

  /**
   * Enumerate authorized advertisers → their GMV Max-usable shops.
   * @param {string[]} [accountIds] restrict to these advertiser ids (empty = all)
   */
  async function listTargets(accountIds) {
    const authorized = (await callTool('auth_advertiser_get', {})).data?.list || []
    const wanted = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds.map(String)) : null
    const targets = []
    for (const account of authorized) {
      const advertiserId = String(account.advertiser_id)
      if (wanted && !wanted.has(advertiserId)) continue
      const advertiserName = account.advertiser_name || advertiserId
      let stores = []
      try {
        const storeList = (await callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
        stores = storeList.filter((store) => store.is_gmv_max_available === true)
      } catch (error) {
        log(`面板：店铺列表失败 ${advertiserName}: ${error.message}`)
      }
      for (const store of stores) {
        targets.push({
          advertiserId,
          advertiserName,
          storeId: String(store.store_id),
          storeName: store.store_name || String(store.store_id),
        })
      }
    }
    return targets
  }

  // ---------------------------------------------------------------- 数据查询
  // Every provider is cached briefly: the dashboard polls and the TikTok API is
  // rate-limited, and a drill-down re-render should not hit the network again.
  const cache = new Map()
  /** itemId → SPU 缓存：素材表显示所属 SKU 用，10 分钟内复用。 */
  const itemSpuCache = new Map()
  /**
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} loader
   * @returns {Promise<T>}
   */
  const DISK_CACHE_DIR = path.join(dataDir, 'cache')
  const diskFile = (key) => path.join(DISK_CACHE_DIR, String(key).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) + '.json')

  const readDiskCache = (key) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskFile(key), 'utf8'))
      if (parsed && typeof parsed.at === 'number') return parsed
    } catch { /* miss */ }
    return null
  }
  const writeDiskCache = (key, data) => {
    try {
      fs.mkdirSync(DISK_CACHE_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(diskFile(key), JSON.stringify({ at: Date.now(), data }))
    } catch { /* best effort */ }
  }
  /** 启动时清理 3 天前的缓存文件 */
  try {
    const cutoff = Date.now() - 3 * 86_400_000
    for (const name of fs.readdirSync(DISK_CACHE_DIR)) {
      const file = path.join(DISK_CACHE_DIR, name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch { /* ignore */ }
    }
  } catch { /* no cache dir yet */ }

  async function cached(key, ttlMs, loader, { persist = false } = {}) {
    // 展示台 / 广告组 / 诊断默认落盘：重启后先给旧数据，再后台刷新
    const persistKey = persist || /^(desk|campaigns|diag|accounts)(:|$)/.test(key)
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.data
    if (hit && persistKey) {
      // 先返回旧数据不阻塞界面，但必须后台刷新，否则面板会一直停留在首次加载的数据上
      if (!hit.refreshing) {
        hit.refreshing = true
        loader()
          .then((data) => {
            cache.set(key, { at: Date.now(), data })
            if (persistKey) writeDiskCache(key, data)
          })
          .catch(() => {})
          .finally(() => {
            hit.refreshing = false
          })
      }
      return hit.data
    }
    if (persistKey && !hit) {
      const disk = readDiskCache(key)
      if (disk) {
        cache.set(key, { at: disk.at, data: disk.data })
        // 磁盘有数据：先返回，后台刷新
        loader()
          .then((data) => {
            cache.set(key, { at: Date.now(), data })
            writeDiskCache(key, data)
          })
          .catch(() => {})
        return disk.data
      }
    }
    const data = await loader()
    cache.set(key, { at: Date.now(), data })
    if (persistKey) writeDiskCache(key, data)
    if (cache.size > 200) cache.delete(cache.keys().next().value)
    return data
  }

  // rangeOf 已在 createPanel 顶部定义
  const toNumber = (value) => Number(value) || 0
  const round2 = (value) => Number(Number(value || 0).toFixed(2))
  const seriesRows = (rawRows, keyField) => {
    const map = new Map()
    for (const row of rawRows) {
      const date = String(row.dimensions?.stat_time_day || '').slice(0, 10)
      if (!date) continue
      const bucket = map.get(date) || { date, cost: 0, orders: 0, revenue: 0 }
      bucket.cost += toNumber(row.metrics?.cost)
      bucket.orders += toNumber(row.metrics?.orders)
      bucket.revenue += toNumber(row.metrics?.gross_revenue)
      map.set(date, bucket)
    }
    void keyField
    return [...map.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((row) => ({
        date: row.date,
        cost: Number(row.cost.toFixed(2)),
        orders: row.orders,
        revenue: Number(row.revenue.toFixed(2)),
        roi: row.cost > 0 ? Number((row.revenue / row.cost).toFixed(2)) : 0,
      }))
  }

  /** Authorized advertisers with their GMV-Max-usable store (one per advertiser here). */
  async function listAccounts() {
    return cached('accounts', 5 * 60_000, async () => {
      const authorized = (await callTool('auth_advertiser_get', {})).data?.list || []
      const accounts = []
      for (const account of authorized) {
        const advertiserId = String(account.advertiser_id)
        let stores = []
        try {
          const storeList = (await callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
          stores = storeList.filter((store) => store.is_gmv_max_available === true)
        } catch (error) {
          log(`账户：店铺列表失败 ${advertiserId}: ${error.message}`)
        }
        if (!stores.length) continue
        const store = stores[0]
        accounts.push({
          advertiserId,
          advertiserName: account.advertiser_name || advertiserId,
          storeId: String(store.store_id),
          storeName: store.store_name || String(store.store_id),
          label: account.advertiser_name || String(store.store_name || advertiserId),
        })
      }
      return accounts
    })
  }

  /** Filter selected accounts; empty selection = all. */
  async function pickAccounts(accountIds) {
    const all = await listAccounts()
    const wanted = Array.isArray(accountIds) ? accountIds.filter(Boolean) : []
    if (!wanted.length) return all
    const set = new Set(wanted.map(String))
    return all.filter((account) => set.has(account.advertiserId))
  }

  /**
   * 展示台：per-account totals + daily series + merged view.
   * @param {number} days
   * @param {string[]} [accountIds]
   */
  async function getDesk(query, accountIds) {
    const range = resolveRange(typeof query === 'object' && query !== null ? query : { days: Number(query) || 7 })
    const accounts = await pickAccounts(accountIds)
    return cached(`desk:${range.days}:${range.today ? 'h' : 'd'}:${range.start}:${accounts.map((account) => account.advertiserId).join(',')}`, range.today ? 30_000 : 60_000, async () => {
      const rows = []
      const merged = new Map()
      for (const account of accounts) {
        let totals = { cost: 0, orders: 0, revenue: 0 }
        let series = []
        try {
          const data = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders', 'gross_revenue'],
            dimensions: range.today ? ['advertiser_id', 'stat_time_hour'] : ['advertiser_id', 'stat_time_day'],
            page_size: range.today ? 48 : 400,
          })
          series = range.today ? hourlyRows(data.data?.list || []) : seriesRows(data.data?.list || [])
          for (const point of series) {
            totals.cost += point.cost
            totals.orders += point.orders
            totals.revenue += point.revenue
            const bucket = merged.get(point.date) || { date: point.date, cost: 0, orders: 0, revenue: 0 }
            bucket.cost += point.cost
            bucket.orders += point.orders
            bucket.revenue += point.revenue
            merged.set(point.date, bucket)
          }
        } catch (error) {
          log(`展示台：${account.label} 拉取失败：${error.message}`)
        }
        rows.push({
          advertiserId: account.advertiserId,
          name: account.label,
          store: account.storeName,
          cost: Number(totals.cost.toFixed(2)),
          orders: totals.orders,
          revenue: Number(totals.revenue.toFixed(2)),
          roi: totals.cost > 0 ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
          costPerOrder: totals.orders > 0 ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
          series,
        })
      }
      const mergedSeries = [...merged.values()]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((point) => ({
          date: point.date,
          cost: Number(point.cost.toFixed(2)),
          orders: point.orders,
          revenue: Number(point.revenue.toFixed(2)),
          roi: point.cost > 0 ? Number((point.revenue / point.cost).toFixed(2)) : 0,
        }))
      const totals = rows.reduce(
        (acc, row) => ({ cost: acc.cost + row.cost, orders: acc.orders + row.orders, revenue: acc.revenue + row.revenue }),
        { cost: 0, orders: 0, revenue: 0 },
      )
      return {
        range,
        mode: accountIds && accountIds.length === 1 ? 'single' : accountIds && accountIds.length > 1 ? 'split' : 'merged',
        accounts: rows,
        mergedSeries,
        totals: {
          cost: Number(totals.cost.toFixed(2)),
          orders: totals.orders,
          revenue: Number(totals.revenue.toFixed(2)),
          roi: totals.cost > 0 ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
          costPerOrder: totals.orders > 0 ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
        },
      }
    })
  }

  /**
   * 广告组 tab: campaign rows for selected accounts, with a daily sparkline.
   * @param {number} days
   * @param {string[]} [accountIds]
   */
  async function getCampaigns(query, accountIds) {
    const range = resolveRange(typeof query === 'object' && query !== null ? query : { days: Number(query) || 7 })
    const accounts = await pickAccounts(accountIds)
    return cached(`campaigns:${range.days}:${range.start}:${accounts.map((account) => account.advertiserId).join(',')}`, 60_000, async () => {
      const rows = []
      for (const account of accounts) {
        try {
          const aggregate = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue', 'roi'],
            dimensions: ['campaign_id'],
            page_size: 200,
          })
          const daily = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders', 'gross_revenue'],
            dimensions: ['campaign_id', 'stat_time_day'],
            page_size: 1000,
          })
          const seriesByCampaign = new Map()
          for (const row of daily.data?.list || []) {
            const campaignId = String(row.dimensions?.campaign_id || '')
            if (!campaignId) continue
            const date = String(row.dimensions?.stat_time_day || '').slice(0, 10)
            if (!date) continue
            if (!seriesByCampaign.has(campaignId)) seriesByCampaign.set(campaignId, new Map())
            const bucket = seriesByCampaign.get(campaignId)
            const point = bucket.get(date) || { date, cost: 0, orders: 0, revenue: 0 }
            point.cost += toNumber(row.metrics?.cost)
            point.orders += toNumber(row.metrics?.orders)
            point.revenue += toNumber(row.metrics?.gross_revenue)
            bucket.set(date, point)
          }
          for (const row of aggregate.data?.list || []) {
            const metrics = row.metrics || {}
            const campaignId = String(row.dimensions?.campaign_id || '')
            const cost = toNumber(metrics.cost)
            const orders = toNumber(metrics.orders)
            const revenue = toNumber(metrics.gross_revenue)
            if (!campaignId || (cost === 0 && orders === 0 && revenue === 0)) continue
            const series = [...(seriesByCampaign.get(campaignId)?.values() || [])]
              .sort((left, right) => left.date.localeCompare(right.date))
              .map((point) => ({ date: point.date, cost: Number(point.cost.toFixed(2)), orders: point.orders, revenue: Number(point.revenue.toFixed(2)) }))
            rows.push({
              advertiserId: account.advertiserId,
              accountName: account.label,
              store: account.storeName,
              campaignId,
              name: metrics.campaign_name || campaignId,
              cost: Number(cost.toFixed(2)),
              orders,
              revenue: Number(revenue.toFixed(2)),
              roi: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
              costPerOrder: orders > 0 ? Number((cost / orders).toFixed(2)) : 0,
              series,
            })
          }
        } catch (error) {
          log(`广告组：${account.label} 拉取失败：${error.message}`)
        }
      }
      rows.sort((left, right) => right.cost - left.cost)
      return { range, rows }
    })
  }

  /**
   * 单个广告组下钻：里面的 SKU 与素材。
   * @param {number} days
   * @param {string} advertiserId
   * @param {string} campaignId
   */
  async function getCampaignDetail(query, advertiserId, campaignId, options = {}) {
    const range = resolveRange(typeof query === 'object' && query !== null ? query : { days: Number(query) || 7 })
    const accounts = await listAccounts()
    const account = accounts.find((candidate) => candidate.advertiserId === String(advertiserId))
    if (!account) throw new Error(`未知广告账户 ${advertiserId}`)
    return cached(`detail:${range.days}:${range.start || ''}:${range.end || ''}:${account.advertiserId}:${campaignId}`, 60_000, async () => {
      const skus = []
      const creatives = []
      let spuIds = []
      try {
        const spuReport = await callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost', 'orders', 'gross_revenue', 'roi'],
          dimensions: ['item_group_id'],
          filtering: { campaign_ids: [campaignId] },
          page_size: 500,
        })
        spuIds = (spuReport.data?.list || []).map((row) => String(row.dimensions?.item_group_id || '')).filter(Boolean)
        for (const row of spuReport.data?.list || []) {
          const metrics = row.metrics || {}
          const cost = toNumber(metrics.cost)
          const orders = toNumber(metrics.orders)
          const revenue = toNumber(metrics.gross_revenue)
          const spu = String(row.dimensions?.item_group_id || '')
          if (!spu || (cost === 0 && orders === 0 && revenue === 0)) continue
          const product = productLookup(spu)
          skus.push({
            spu,
            sku: product.sku,
            name: product.name,
            cost: Number(cost.toFixed(2)),
            orders,
            revenue: Number(revenue.toFixed(2)),
            roi: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
          })
        }
        skus.sort((left, right) => right.cost - left.cost)
      } catch (error) {
        log(`下钻：SKU 失败 ${campaignId}: ${error.message}`)
      }

      if (spuIds.length) {
        try {
          const itemReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders', 'gross_revenue', 'product_impressions', 'product_clicks'],
            dimensions: ['item_id'],
            filtering: { campaign_ids: [campaignId], item_group_ids: spuIds },
            page_size: 1000,
          })
          for (const row of itemReport.data?.list || []) {
            const metrics = row.metrics || {}
            const cost = toNumber(metrics.cost)
            const orders = toNumber(metrics.orders)
            const revenue = toNumber(metrics.gross_revenue)
            const itemId = String(row.dimensions?.item_id || '')
            if (!itemId || itemId === '-1' || (cost === 0 && orders === 0 && revenue === 0)) continue
            const impressions = toNumber(metrics.product_impressions)
            const clicks = toNumber(metrics.product_clicks)
            creatives.push({
              itemId,
              cost: Number(cost.toFixed(2)),
              orders,
              revenue: Number(revenue.toFixed(2)),
              roi: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
              impressions,
              clicks,
              ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
            })
          }
          // 用投放数据复刻商家的「探索状态」：待删 / 观察 / 加热 / 正常
          const spendThreshold = config.creativeSpendThreshold
          const target = config.rules.roiTarget
          for (const creative of creatives) {
            if (creative.cost >= spendThreshold && creative.orders === 0) creative.status = 'kill'
            else if (creative.orders > 0 && creative.roi >= target * 1.2) creative.status = 'scale'
            else if (creative.cost < spendThreshold || creative.roi < target * config.rules.roiRatio) creative.status = 'watch'
            else creative.status = 'normal'
          }
          // 补「这条素材属于哪个 SKU」：按 SPU 分批查 item 报表（命中缓存则跳过；light 模式跳过）
          const spuNeeds = options.skipSkuMap ? [] : spuIds.filter((spu) => {
            const key = `${account.advertiserId}:${campaignId}:${spu}`
            const hit = itemSpuCache.get(String(itemId))
            return !hit || Date.now() - hit.at > 600_000
          })
          for (const spu of spuNeeds) {
            try {
              const itemOfSpu = await callTool('gmv_max_report_get', {
                advertiser_id: account.advertiserId,
                store_ids: [account.storeId],
                start_date: range.start,
                end_date: range.end,
                metrics: ['cost', 'orders'],
                dimensions: ['item_id'],
                filtering: { campaign_ids: [campaignId], item_group_ids: [spu] },
                page_size: 500,
              })
              for (const itemRow of itemOfSpu.data?.list || []) {
                const itemId = String(itemRow.dimensions?.item_id || '')
                if (!itemId || itemId === '-1') continue
                itemSpuCache.set(String(itemId), { spu, at: Date.now() })
              }
            } catch (error) {
              log(`下钻：素材→SPU 映射失败 ${spu} ${error.message}`)
            }
          }
          for (const creative of creatives) {
            const mapped = itemSpuCache.get(String(creative.itemId))
            if (!mapped) continue
            creative.spu = mapped.spu
            const product = productLookup(mapped.spu)
            creative.sku = product.sku
            creative.productName = product.name
          }
          creatives.sort((left, right) => right.cost - left.cost)
        } catch (error) {
          log(`下钻：素材失败 ${campaignId}: ${error.message}`)
        }
      }
      return { range, account: { advertiserId: account.advertiserId, name: account.label, store: account.storeName }, campaignId, skus, creatives }
    })
  }

  /**
   * 素材实时看板：按账户批量拉一次（每个账户 3 张报表），所有盯盘卡片共用。
   * 这样 N 张卡片不会变成 N 倍请求。
   */
  async function getCreativeBoard(query, accountIds) {
    const accounts = await pickAccounts(accountIds)
    const range = resolveRange(query)
    const key = 'creative-board:' + range.start + ':' + range.end + ':' + accounts.map((row) => row.advertiserId).sort().join(',')
    return cached(key, 45_000, async () => {
      const rows = new Map()
      for (const account of accounts) {
        try {
          const campaignReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost'],
            dimensions: ['campaign_id'],
            page_size: 100,
          })
          const campaigns = (campaignReport.data?.list || [])
            .filter((row) => Number(row.metrics?.cost) > 0)
            .map((row) => ({ id: String(row.dimensions?.campaign_id || ''), cost: Number(row.metrics?.cost) }))
            .filter((row) => row.id)
          if (!campaigns.length) continue
          const campaignIds = campaigns.map((row) => row.id)

          const spuReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders'],
            dimensions: ['item_group_id'],
            filtering: { campaign_ids: campaignIds },
            page_size: 1000,
          })
          const spuIds = (spuReport.data?.list || [])
            .filter((row) => Number(row.metrics?.cost) > 0 || Number(row.metrics?.orders) > 0)
            .map((row) => String(row.dimensions?.item_group_id || ''))
            .filter(Boolean)
          if (!spuIds.length) continue

          const itemReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders', 'gross_revenue', 'product_clicks'],
            dimensions: ['item_id'],
            filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
            page_size: 1000,
          })
          for (const row of itemReport.data?.list || []) {
            const itemId = String(row.dimensions?.item_id || '')
            if (!itemId || itemId === '-1') continue
            const bucket = rows.get(itemId) || {
              itemId,
              advertiserId: account.advertiserId,
              storeName: account.storeName,
              cost: 0,
              orders: 0,
              revenue: 0,
              clicks: 0,
              campaignIds: new Set(),
            }
            bucket.cost += Number(row.metrics?.cost) || 0
            bucket.orders += Number(row.metrics?.orders) || 0
            bucket.revenue += Number(row.metrics?.gross_revenue) || 0
            bucket.clicks += Number(row.metrics?.product_clicks) || 0
            rows.set(itemId, bucket)
          }
          for (const campaign of campaigns) {
            if (!campaign.cost) continue
            void campaign
          }
        } catch (error) {
          log(`素材看板：${account.storeName} 拉取失败 ${error.message}`)
        }
      }
      const threshold = config.creativeSpendThreshold
      const target = config.rules.roiTarget
      const ratio = config.rules.roiRatio
      const meta = board.creativeMeta ? board.creativeMeta() : {}
      const list = [...rows.values()]
        .map((row) => {
          const roi = row.cost > 0 ? Number((row.revenue / row.cost).toFixed(2)) : 0
          const status = row.cost >= threshold && row.orders === 0
            ? 'kill'
            : row.orders > 0 && roi >= target * 1.2
              ? 'scale'
              : row.orders > 0 && roi < target * ratio
                ? 'watch'
                : 'normal'
          const spu = (itemSpuCache.get(String(row.itemId)) || {}).spu || ''
          const sku = spu ? productLookup(spu) : ''
          return {
            itemId: row.itemId,
            advertiserId: row.advertiserId,
            storeName: row.storeName,
            cost: Number(row.cost.toFixed(2)),
            orders: row.orders,
            revenue: Number(row.revenue.toFixed(2)),
            roi,
            clicks: row.clicks,
            status,
            sku,
            favorite: Boolean(meta[row.itemId] && meta[row.itemId].favorite),
            note: (meta[row.itemId] && meta[row.itemId].note) || '',
          }
        })
        .filter((row) => row.cost > 0 || row.orders > 0)
        .sort((left, right) => {
          if (left.favorite !== right.favorite) return left.favorite ? -1 : 1
          return right.cost - left.cost
        })
      return { ok: true, range, rows: list, total: list.length, updatedAt: new Date().toISOString() }
    })
  }

  /**
   * 各广告账户的时区（TikTok 报表的小时口径就是账户时区）。
   * 面板用它把小时轴换算成用户选择的时区。
   */
  async function getTimezones() {
    return cached('timezones', 10 * 60_000, async () => {
      const accounts = await listAccounts()
      const rows = []
      for (const account of accounts) {
        let timezone = ''
        try {
          const info = await callTool('advertiser_info_get', { advertiser_ids: [account.advertiserId] })
          const list = info.data?.list || info.data || []
          const first = Array.isArray(list) ? list[0] : list
          timezone = first?.timezone || first?.time_zone || ''
        } catch (error) {
          log(`时区：${account.storeName} 查询失败 ${error.message}`)
        }
        rows.push({
          advertiserId: account.advertiserId,
          storeName: account.storeName,
          accountName: account.advertiserName,
          timezone: timezone || 'UTC',
        })
      }
      return { ok: true, accounts: rows, fetchedAt: new Date().toISOString() }
    })
  }

  /**
   * AI 巡检（规则版）：把当前区间的情况整理成「结论 + 异常 + 建议」，
   * 同时生成一段可直接贴给大模型的摘要文本。
   * @param {{ days?: number, today?: boolean, start?: string, end?: string }} query
   * @param {string[]} [accountIds]
   */
  async function getInspect(query, accountIds) {
    const range = resolveRange(query)
    const desk = await getDesk(query, accountIds)
    const campaigns = await getCampaigns(query, accountIds)
    const rules = config.rules
    const threshold = config.creativeSpendThreshold
    const rows = campaigns.rows || []
    const zeroOrder = rows.filter((row) => row.cost >= threshold && row.orders === 0)
    const lowRoi = rows.filter((row) => row.orders > 0 && row.roi < rules.roiTarget * rules.roiRatio)
    const star = rows.filter((row) => row.orders > 0 && row.roi >= rules.roiTarget * 1.2).slice(0, 5)
    const totals = desk.totals || { cost: 0, orders: 0, revenue: 0, roi: 0, costPerOrder: 0 }
    const target = rules.roiTarget
    const verdict = totals.roi >= target ? '达标' : totals.roi >= target * rules.roiRatio ? '偏低' : '不达标'
    const conclusions = [
      `区间 ${range.start} ~ ${range.end}：消耗 ${money(totals.cost)}，订单 ${totals.orders}，GMV ${money(totals.revenue)}，ROI ${totals.roi}（目标 ${target}，${verdict}）`,
      `单均成本 ${money(totals.costPerOrder)}；共 ${rows.length} 个广告组有消耗`,
    ]
    if (zeroOrder.length) conclusions.push(`${zeroOrder.length} 个广告组花钱但 0 单，合计浪费 ${money(zeroOrder.reduce((sum, row) => sum + row.cost, 0))}`)
    if (lowRoi.length) conclusions.push(`${lowRoi.length} 个广告组 ROI 低于目标的 ${Math.round(rules.roiRatio * 100)}%`)
    if (star.length) conclusions.push(`${star.length} 个广告组 ROI 高于目标 1.2 倍，可考虑加量`)
    const actions = []
    for (const row of zeroOrder.slice(0, 5)) actions.push({ level: 'critical', action: '止损', target: row.name, reason: `消耗 ${money(row.cost)} / 0 单` })
    for (const row of lowRoi.slice(0, 5)) actions.push({ level: 'warning', action: '检查', target: row.name, reason: `ROI ${row.roi} 低于目标 ${target}` })
    for (const row of star.slice(0, 5)) actions.push({ level: 'good', action: '扩量', target: row.name, reason: `ROI ${row.roi} / ${row.orders} 单` })
    const boardAlerts = (alertStore.state.active || []).filter((alert) => /^board\|/.test(alert.key || ''))
    const brief = [
      `# TikTok 广告巡检（${range.start} ~ ${range.end}）`,
      ...conclusions.map((line) => `- ${line}`),
      '',
      '## 建议动作',
      ...actions.map((item) => `- [${item.action}] ${item.target}：${item.reason}`),
      ...(boardAlerts.length ? ['', '## 盯盘告警', ...boardAlerts.slice(0, 8).map((alert) => `- ${alert.message}`)] : []),
      '',
      '## 分账户',
      ...(desk.accounts || []).map((account) => `- ${account.name}：消耗 ${money(account.cost)} / ${account.orders} 单 / ROI ${account.roi}`),
    ].join('\n')
    return {
      range,
      totals,
      conclusions,
      actions,
      accounts: desk.accounts,
      zeroOrder: zeroOrder.slice(0, 10),
      lowRoi: lowRoi.slice(0, 10),
      star: star.slice(0, 10),
      boardAlerts,
      brief,
      generatedAt: new Date().toISOString(),
    }
  }

  /** 导出任务状态（同一时间只跑一个） */
  let exportJob = { running: false, startedAt: null, finishedAt: null, files: [], dir: '', log: [], error: null, range: null, progress: 0, totalDays: 1, currentDate: '' }

  /** 导出区间报表（复用 tools/daily-report.mjs，格式与桌面「每日广告订单」一致） */
  async function runExport({ start, end, out }) {
    if (exportJob.running) return { ok: false, message: '已有导出任务在跑', ...exportJob }
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(start)) ? start : formatDate(new Date(Date.now() - DAY_MS))
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(end)) ? end : startDate
    if (startDate > endDate) return { ok: false, message: '开始日期不能晚于结束日期' }
    // 导出目录：优先用配置/环境变量；默认桌面「每日广告订单」，桌面不存在时退到数据目录 exports。
    // 调用方传入的 out 必须落在允许的根目录内，避免任意路径写入。
    const desktopDefault = path.join(os.homedir(), 'Desktop', '广告', '每日广告订单')
    const configured = typeof config.exportDir === 'string' && config.exportDir.trim()
      ? path.resolve(config.exportDir)
      : (fs.existsSync(path.join(os.homedir(), 'Desktop')) ? desktopDefault : path.join(dataDir, 'exports'))
    fs.mkdirSync(configured, { recursive: true })
    const requested = typeof out === 'string' && out.trim() ? path.resolve(out) : configured
    const outDir = requested === configured || requested.startsWith(configured + path.sep) ? requested : configured
    const totalDays = Math.max(1, Math.round((new Date(endDate + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000) + 1)
    const script = fileURLToPath(new URL('../tools/daily-report.mjs', import.meta.url))
    exportJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, files: [], dir: outDir, log: [], error: null, range: { start: startDate, end: endDate }, progress: 0, totalDays, currentDate: startDate }
    try {
      const runOnce = (command, args) => new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: path.dirname(script),
          windowsHide: true,
        })
        const onData = (chunk) => {
          const line = String(chunk).trim()
          if (!line) return
          exportJob.log.push(line.slice(0, 300))
          const match = /\[(\d{4}-\d{2}-\d{2})\]/.exec(line)
          if (match) exportJob.currentDate = match[1]
          if (line.includes('✓') || line.includes('xlsx 已生成')) exportJob.progress += 1
          if (exportJob.log.length > 200) exportJob.log = exportJob.log.slice(-120)
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('error', (error) => {
          exportJob.error = error.code === 'ENOENT' ? `找不到 node 可执行文件（${command}）` : error.message
          resolve()
        })
        child.on('close', (code) => {
          if (code !== 0 && !exportJob.error) exportJob.error = `导出进程退出码 ${code}`
          resolve()
        })
      })
      exportJob.error = null
      const baseArgs = (date) => date
        ? [script, '--date', date, '--days', '1', '--flat', '--out', outDir]
        : [script, '--start', startDate, '--end', endDate, '--per-day', '--flat', '--out', outDir]
      const runWithFallback = async (date) => {
        await runOnce(process.execPath, baseArgs(date))
        if (exportJob.error && /找不到 node|ENOENT/.test(exportJob.error)) {
          exportJob.error = null
          await runOnce('node', baseArgs(date))
        }
      }
      if (totalDays > 1) {
        // 多天并行（每天一个独立进程，并发 2），比脚本内部串行快一倍左右
        const dates = []
        const cursor = new Date(startDate + 'T00:00:00')
        while (dates.length < totalDays) {
          dates.push(formatDate(cursor))
          cursor.setDate(cursor.getDate() + 1)
        }
        let index = 0
        const workers = Array.from({ length: Math.min(2, dates.length) }, async () => {
          while (index < dates.length) {
            const date = dates[index++]
            exportJob.currentDate = date
            await runWithFallback(date)
          }
        })
        await Promise.all(workers)
      } else {
        await runWithFallback('')
      }
    } finally {
      exportJob.running = false
      exportJob.finishedAt = new Date().toISOString()
      try {
        const prefix = startDate
        exportJob.files = fs.readdirSync(outDir)
          .filter((name) => /^\d{4}-\d{2}-\d{2}\.xlsx$/.test(name))
          .filter((name) => name.slice(0, 10) >= startDate && name.slice(0, 10) <= endDate)
          .sort()
          .map((name) => ({ name, path: path.join(outDir, name), size: fs.statSync(path.join(outDir, name)).size }))
        void prefix
      } catch (error) {
        exportJob.error = exportJob.error || error.message
      }
    }
    return { ok: !exportJob.error, ...exportJob }
  }

  const money = (value) => `$${Number(value || 0).toFixed(2)}`

  /**
   * 诊断：素材赛马场（待删/观察/加热）+ SKU 作战室（红/黄/绿）。
   * 全部由投放数据本地计算，不依赖 AI。
   * @param {{ days?: number, today?: boolean, start?: string, end?: string }} query
   * @param {string[]} [accountIds]
   */
  async function computeDiagnosis(query, accountIds) {
    const range = resolveRange(query)
    const accounts = await pickAccounts(accountIds)
    {
      const threshold = config.creativeSpendThreshold
      const target = config.rules.roiTarget
      const ratio = config.rules.roiRatio
      const creatives = []
      const skus = []
      const byAccount = []
      for (const account of accounts) {
        const base = {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          page_size: 1000,
        }
        let campaignIds = []
        try {
          const campaignReport = await callTool('gmv_max_report_get', {
            ...base,
            metrics: ['cost', 'orders', 'gross_revenue'],
            dimensions: ['campaign_id'],
          })
          campaignIds = (campaignReport.data?.list || [])
            .filter((row) => toNumber(row.metrics?.cost) > 0)
            .map((row) => String(row.dimensions?.campaign_id || ''))
            .filter(Boolean)
        } catch (error) {
          log(`诊断：${account.label} 广告组失败 ${error.message}`)
          continue
        }
        if (!campaignIds.length) continue

        // ---- SKU 级（账户一把梭，不再按广告组循环）----
        let spuIds = []
        try {
          const spuReport = await callTool('gmv_max_report_get', {
            ...base,
            dimensions: ['item_group_id'],
            metrics: ['cost', 'orders', 'gross_revenue'],
            filtering: { campaign_ids: campaignIds },
          })
          for (const row of spuReport.data?.list || []) {
            const spu = String(row.dimensions?.item_group_id || '')
            if (!spu) continue
            if (toNumber(row.metrics?.cost) > 0 || toNumber(row.metrics?.orders) > 0) spuIds.push(spu)
            const cost = toNumber(row.metrics?.cost)
            const orders = toNumber(row.metrics?.orders)
            const revenue = toNumber(row.metrics?.gross_revenue)
            const roi = cost > 0 ? revenue / cost : 0
            const product = productLookup(spu)
            let status = 'ok'
            let advice = '保持'
            if (cost >= threshold && orders === 0) {
              status = 'kill'
              advice = '止损：直接关停或降价'
            } else if (roi >= target * 1.2 && cost >= threshold) {
              status = 'scale'
              advice = '扩量：加预算 / 加热'
            } else if (roi > 0 && roi < target * ratio) {
              status = 'fix'
              advice = '检查：价格 / 落地页 / 素材'
            } else if (cost < threshold) {
              status = 'watch'
              advice = '观察：样本不足'
            }
            skus.push({
              account: account.storeName,
              advertiserId: account.advertiserId,
              campaignId: '',
              campaignName: account.storeName,
              spu,
              sku: product.sku,
              name: product.name,
              cost: round2(cost),
              orders,
              revenue: round2(revenue),
              roi: round2(roi),
              aov: orders > 0 ? round2(revenue / orders) : 0,
              loss: status === 'kill' ? round2(cost) : 0,
              status,
              advice,
            })
          }
        } catch (error) {
          log(`诊断：${account.label} SKU 失败 ${error.message}`)
        }

        // ---- 素材级（账户级 item 报表，分页；不逐个广告组拉）----
        if (spuIds.length) {
          for (let page = 1; page <= 3; page++) {
            let rows = []
            try {
              const itemReport = await callTool('gmv_max_report_get', {
                ...base,
                metrics: ['cost', 'orders', 'gross_revenue', 'product_impressions', 'product_clicks'],
                dimensions: ['item_id'],
                filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
                page,
              })
              rows = itemReport.data?.list || []
              for (const row of rows) {
                const itemId = String(row.dimensions?.item_id || '')
                if (!itemId || itemId === '-1') continue
                const cost = toNumber(row.metrics?.cost)
                const orders = toNumber(row.metrics?.orders)
                const revenue = toNumber(row.metrics?.gross_revenue)
                const impressions = toNumber(row.metrics?.product_impressions)
                const clicks = toNumber(row.metrics?.product_clicks)
                if (cost === 0 && orders === 0 && revenue === 0) continue
                const roi = cost > 0 ? revenue / cost : 0
                const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0
                let bucket = 'watch'
                if (cost >= threshold && orders === 0) bucket = 'kill'
                else if (roi >= target * 1.2 && cost >= threshold) bucket = 'scale'
                creatives.push({
                  account: account.storeName,
                  advertiserId: account.advertiserId,
                  campaignId: '',
                  campaignName: account.storeName,
                  itemId,
                  cost: round2(cost),
                  orders,
                  revenue: round2(revenue),
                  roi: round2(roi),
                  impressions,
                  clicks,
                  ctr: Number(ctr.toFixed(2)),
                  cpc: clicks > 0 ? round2(cost / clicks) : 0,
                  cvr: clicks > 0 ? Number(((orders / clicks) * 100).toFixed(2)) : 0,
                  ecpm: impressions > 0 ? round2((cost / impressions) * 1000) : 0,
                  aov: orders > 0 ? round2(revenue / orders) : 0,
                  rpc: clicks > 0 ? round2(revenue / clicks) : 0,
                  bucket,
                })
              }
            } catch (error) {
              log(`诊断：${account.label} 素材失败 ${error.message}`)
              break
            }
            if (rows.length < base.page_size) break
          }
        }
        byAccount.push({
          store: account.storeName,
          advertiserId: account.advertiserId,
          cost: round2(skus.filter((row) => row.advertiserId === account.advertiserId).reduce((sum, row) => sum + row.cost, 0)),
          orders: skus.filter((row) => row.advertiserId === account.advertiserId).reduce((sum, row) => sum + row.orders, 0),
          revenue: round2(skus.filter((row) => row.advertiserId === account.advertiserId).reduce((sum, row) => sum + row.revenue, 0)),
          roi: 0,
        })
      }
      const bucketOf = (list, name) => list.filter((row) => row.bucket === name || row.status === name)
      return {
        range,
        creative: {
          all: creatives.length,
          kill: bucketOf(creatives, 'kill').sort((left, right) => right.cost - left.cost),
          watch: bucketOf(creatives, 'watch').sort((left, right) => right.cost - left.cost),
          scale: bucketOf(creatives, 'scale').sort((left, right) => right.cost - left.cost),
          wasted: round2(creatives.filter((row) => row.bucket === 'kill').reduce((sum, row) => sum + row.cost, 0)),
        },
        sku: {
          all: skus.length,
          kill: bucketOf(skus, 'kill').sort((left, right) => right.cost - left.cost),
          fix: bucketOf(skus, 'fix').sort((left, right) => right.cost - left.cost),
          scale: bucketOf(skus, 'scale').sort((left, right) => right.cost - left.cost),
          watch: bucketOf(skus, 'watch').sort((left, right) => right.cost - left.cost),
          wasted: round2(skus.filter((row) => row.status === 'kill').reduce((sum, row) => sum + row.cost, 0)),
        },
        accounts: byAccount,
      }
    }
  }

  /** 诊断缓存：首次计算慢（账户级多次拉数），用「后台算 + 前端轮询」避免卡界面。 */
  let diagCache = { at: 0, payload: null, pending: null, error: null }

  const diagStart = (query, accountIds) => {
    if (diagCache.pending) return diagCache.pending
    diagCache.error = null
    diagCache.pending = computeDiagnosis(query, accountIds)
      .then((payload) => {
        diagCache = { at: Date.now(), payload, pending: null, error: null }
        return payload
      })
      .catch((error) => {
        diagCache.pending = null
        diagCache.error = String(error?.message || error)
        throw error
      })
    return diagCache.pending
  }

  /**
   * 诊断数据（stale-while-revalidate）：有旧结果先给旧的，同时后台重算；首次返回 { loading: true }。
   */
  async function getDiagnosis(query, accountIds) {
    const age = Date.now() - diagCache.at
    if (diagCache.payload && age < 300_000) return diagCache.payload
    if (diagCache.payload) {
      diagStart(query, accountIds).catch((error) => log(`诊断后台刷新失败 ${error.message}`))
      return { ...diagCache.payload, stale: true }
    }
    diagStart(query, accountIds).catch((error) => log(`诊断失败 ${error.message}`))
    return { loading: true, range: resolveRange(query), startedAt: new Date().toISOString() }
  }

  /**
   * 单条趋势（素材 / SKU / 广告组 / 账户），用于「点击看涨幅」。
   * @param {{ days: number, advertiserId: string, campaignId?: string, spu?: string, itemId?: string }} query
   */
  async function getTrend({ days, today, start, end, advertiserId, campaignId, spu, itemId }) {
    const range = resolveRange({ days, today, start, end })
    const accounts = await listAccounts()
    const account = accounts.find((candidate) => candidate.advertiserId === String(advertiserId))
    if (!account) throw new Error(`未知广告账户 ${advertiserId}`)
    const key = `trend:${range.days}:${range.start || ''}:${range.end || ''}:${account.advertiserId}:${campaignId || '-'}:${spu || '-'}:${itemId || '-'}`
    return cached(key, 60_000, async () => {
      const base = {
        advertiser_id: account.advertiserId,
        store_ids: [account.storeId],
        start_date: range.start,
        end_date: range.end,
        metrics: ['cost', 'orders', 'gross_revenue'],
        page_size: 1000,
      }
      if (itemId) {
        // 素材级报表必须同时带 campaign_ids 和 item_group_ids；
        // 调用方只给了 itemId 时先查出这条广告组的 SPU 列表当锚点。
        let spuIds = spu ? [spu] : []
        if (!spuIds.length && campaignId) {
          try {
            const spuReport = await callTool('gmv_max_report_get', {
              ...base,
              dimensions: ['item_group_id'],
              metrics: ['cost', 'orders'],
              filtering: { campaign_ids: [campaignId] },
            })
            spuIds = (spuReport.data?.list || [])
              .filter((row) => toNumber(row.metrics?.cost) > 0 || toNumber(row.metrics?.orders) > 0)
              .map((row) => String(row.dimensions?.item_group_id || ''))
              .filter(Boolean)
          } catch (error) {
            log(`素材趋势：补 SPU 失败 ${error.message}`)
          }
        }
        const rows = []
        let page = 1
        for (;;) {
          const data = await callTool('gmv_max_report_get', {
            ...base,
            dimensions: ['item_id', 'stat_time_day'],
            filtering: { campaign_ids: campaignId ? [campaignId] : undefined, item_group_ids: spuIds.length ? spuIds : undefined },
            page,
          })
          const list = data.data?.list || []
          rows.push(...list.filter((row) => String(row.dimensions?.item_id || '') === String(itemId)))
          const totalPage = Number(data.data?.page_info?.total_page) || 1
          if (list.length === 0 || page >= Math.min(totalPage, 6)) break
          page++
        }
        return { range, kind: 'creative', series: seriesRows(rows) }
      }
      if (spu) {
        const data = await callTool('gmv_max_report_get', {
          ...base,
          dimensions: ['item_group_id', 'stat_time_day'],
          filtering: campaignId ? { campaign_ids: [campaignId] } : undefined,
        })
        const rows = (data.data?.list || []).filter((row) => String(row.dimensions?.item_group_id || '') === String(spu))
        return { range, kind: 'sku', series: seriesRows(rows) }
      }
      if (campaignId) {
        const data = await callTool('gmv_max_report_get', {
          ...base,
          dimensions: ['campaign_id', 'stat_time_day'],
        })
        const rows = (data.data?.list || []).filter((row) => String(row.dimensions?.campaign_id || '') === String(campaignId))
        return { range, kind: 'campaign', series: seriesRows(rows) }
      }
      const data = await callTool('gmv_max_report_get', {
        ...base,
        dimensions: ['advertiser_id', 'stat_time_day'],
      })
      return { range, kind: 'account', series: seriesRows(data.data?.list || []) }
    })
  }

  /**
   * 盯盘：某个广告组 / 素材「今天」按小时的消耗、订单、GMV 曲线。
   * 缓存 20 秒，前端每分钟刷新即可获得近实时效果。
   * @param {{ advertiserId: string, campaignId?: string, itemId?: string }} target
   */
  async function getWatch({ advertiserId, campaignId, itemId }) {
    const range = rangeOf(1, true)
    const accounts = await listAccounts()
    const account = accounts.find((candidate) => candidate.advertiserId === String(advertiserId))
    if (!account) throw new Error(`未知广告账户 ${advertiserId}`)
    const key = `watch:${account.advertiserId}:${campaignId || '-'}:${itemId || '-'}`
    return cached(key, 20_000, async () => {
      const base = {
        advertiser_id: account.advertiserId,
        store_ids: [account.storeId],
        start_date: range.start,
        end_date: range.end,
        metrics: ['cost', 'orders', 'gross_revenue'],
        page_size: 1000,
      }
      let rows = []
      let sampled = false
      let label = account.label
      try {
        if (itemId) {
          // `item_id` needs campaign + SPU anchors; the item filter is applied client-side.
          const campaignIds = campaignId ? [campaignId] : []
          let spuIds = []
          if (campaignIds.length) {
            const spuReport = await callTool('gmv_max_report_get', {
              ...base,
              dimensions: ['item_group_id'],
              filtering: { campaign_ids: campaignIds },
              metrics: ['cost'],
            })
            spuIds = (spuReport.data?.list || [])
              .filter((row) => toNumber(row.metrics?.cost) > 0 || toNumber(row.metrics?.orders) > 0)
              .map((row) => String(row.dimensions?.item_group_id || ''))
              .filter(Boolean)
          }
          const data = await callTool('gmv_max_report_get', {
            ...base,
            dimensions: ['item_id'],
            filtering: { campaign_ids: campaignIds.length ? campaignIds : undefined, item_group_ids: spuIds.length ? spuIds : undefined },
          })
          rows = (data.data?.list || []).filter((row) => String(row.dimensions?.item_id || '') === String(itemId))
          label = '素材 ' + String(itemId).slice(-8)
          sampled = true
        } else if (campaignId) {
          const data = await callTool('gmv_max_report_get', {
            ...base,
            dimensions: ['campaign_id', 'stat_time_hour'],
          })
          rows = (data.data?.list || []).filter((row) => String(row.dimensions?.campaign_id || '') === String(campaignId))
          label = `广告组 ${campaignId}`
        } else {
          const data = await callTool('gmv_max_report_get', {
            ...base,
            dimensions: ['advertiser_id', 'stat_time_hour'],
          })
          rows = data.data?.list || []
        }
      } catch (error) {
        log(`盯盘失败：${label} ${error.message}`)
        throw error
      }
      const series = hourlyRows(rows)
      const sumOf = (list) => list.reduce(
        (acc, point) => ({ cost: acc.cost + point.cost, orders: acc.orders + point.orders, revenue: acc.revenue + point.revenue }),
        { cost: 0, orders: 0, revenue: 0 },
      )
      const sampledTotals = sampled
        ? sumOf(rows.map((row) => ({
          cost: toNumber(row.metrics?.cost),
          orders: toNumber(row.metrics?.orders),
          revenue: toNumber(row.metrics?.gross_revenue),
        })))
        : null
      const sampleKey = account.advertiserId + ':' + (campaignId || '-') + ':' + (itemId || '-')
      let samples = []
      if (sampled && sampledTotals) {
        const now = new Date()
        const stamp = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
        const history = watchSamples.get(sampleKey) || []
        const previous = history[history.length - 1]
        const point = {
          at: now.toISOString(),
          hour: stamp,
          date: stamp,
          cost: Number(sampledTotals.cost.toFixed(2)),
          orders: sampledTotals.orders,
          revenue: Number(sampledTotals.revenue.toFixed(2)),
          roi: sampledTotals.cost > 0 ? Number((sampledTotals.revenue / sampledTotals.cost).toFixed(2)) : 0,
          deltaCost: previous ? Number((sampledTotals.cost - previous.cost).toFixed(2)) : null,
          deltaOrders: previous ? sampledTotals.orders - previous.orders : null,
        }
        if (!previous || previous.cost !== point.cost || previous.orders !== point.orders) {
          history.push(point)
          watchSamples.set(sampleKey, history.slice(-240))
        } else if (history.length) {
          history[history.length - 1] = { ...history[history.length - 1], at: point.at }
        }
        samples = watchSamples.get(sampleKey) || []
      }
      const totalsSource = sampled && sampledTotals ? [sampledTotals] : series
      const totals = totalsSource.reduce(
        (acc, point) => ({ cost: acc.cost + point.cost, orders: acc.orders + point.orders, revenue: acc.revenue + point.revenue }),
        { cost: 0, orders: 0, revenue: 0 },
      )
      const meaningful = series.filter((point) => point.cost > 0 || point.orders > 0)
      const last = meaningful.length ? meaningful[meaningful.length - 1] : series.length ? series[series.length - 1] : null
      return {
        range,
        label,
        account: { advertiserId: account.advertiserId, name: account.label, store: account.storeName },
        series,
        totals: {
          cost: Number(totals.cost.toFixed(2)),
          orders: totals.orders,
          revenue: Number(totals.revenue.toFixed(2)),
          roi: totals.cost > 0 ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
          costPerOrder: totals.orders > 0 ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
        },
        lastHour: last,
        sampled,
        samples,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * @param {{ notify?: boolean, accountIds?: string[] }} [options]
   *        accountIds restricts the scan (empty/omitted = the configured watch list,
   *        or every account when watchAll is on).
   */
  async function runScan({ notify = true, accountIds } = {}) {
    if (scanInFlight) return scanInFlight
    scanInFlight = (async () => {
      const rules = config.rules
      const range = rangeOf(rules.windowDays)
      const requested = Array.isArray(accountIds) && accountIds.length
        ? accountIds
        : config.watchAll ? [] : config.watchAccounts
      const targets = await listTargets(requested)
      const findings = []
      const errors = []
      for (const target of targets) {
        try {
          const found = await scanStore({
            callTool,
            advertiserId: target.advertiserId,
            advertiserName: target.advertiserName,
            storeId: target.storeId,
            storeName: target.storeName,
            startDate: range.start,
            endDate: range.end,
            rules,
          })
          findings.push(...found)
        } catch (error) {
          errors.push(`${target.storeName}: ${error.message}`)
          log(`监控：${target.storeName} 扫描失败：${error.message}`)
        }
      }
      try {
        const boardFindings = await board.alertFindings()
        const scope = targets.map((target) => target.advertiserId)
        findings.push(...boardFindings.filter((finding) => !scope.length || scope.includes(String(finding.advertiserId || ''))))
      } catch (error) {
        log(`监控：看板告警合并失败 ${error.message}`)
      }
      const { fresh, resolved, active } = alertStore.reconcile(findings)
      lastScan = {
        at: new Date().toISOString(),
        fresh: fresh.length,
        resolved: resolved.length,
        scannedStores: targets.length,
        scope: targets.map((target) => target.advertiserId),
        errors,
      }
      if (notify && config.feishuWebhook && fresh.length) {
        try {
          await sendFeishu(config.feishuWebhook, formatFindings(fresh))
          log(`监控：已推送 ${fresh.length} 条告警到飞书`)
        } catch (error) {
          log(`监控：飞书推送失败：${error.message}`)
        }
      }
      return { ...lastScan, active: active.length }
    })()
    try {
      return await scanInFlight
    } finally {
      scanInFlight = null
    }
  }

  function scheduleScans() {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      runScan().catch((error) => log(`监控：定时扫描失败 ${error.message}`))
    }, Math.max(5, config.monitorIntervalMinutes) * 60_000)
    timer.unref?.()
  }

  let stopped = false
  async function start() {
    stopped = false
    if (settings.dashboardEnabled) {
      try {
        dashboard = await startDashboard(
          {
            getStatus,
            getSettings: async () => ({
              rules: config.rules,
              monitorIntervalMinutes: config.monitorIntervalMinutes,
              feishuWebhook: config.feishuWebhook,
              watchAll: config.watchAll,
              watchAccounts: config.watchAccounts,
              creativeSpendThreshold: config.creativeSpendThreshold,
              boardSpeedThreshold: config.boardSpeedThreshold,
              boardStallMinutes: config.boardStallMinutes,
            }),
            saveSettings: async (patch) => {
              // Merge over the IN-MEMORY config (not the file): reading from disk
              // here would let the stored old value override the new one.
              config = {
                rules: normalizeRules({ ...config.rules, ...(patch.rules || {}) }),
                monitorIntervalMinutes: Number(patch.monitorIntervalMinutes) || config.monitorIntervalMinutes,
                feishuWebhook: typeof patch.feishuWebhook === 'string' ? patch.feishuWebhook : config.feishuWebhook,
                watchAll: typeof patch.watchAll === 'boolean' ? patch.watchAll : config.watchAll,
                watchAccounts: Array.isArray(patch.watchAccounts)
                  ? patch.watchAccounts.map(String).filter(Boolean)
                  : config.watchAccounts,
                creativeSpendThreshold: Number(patch.creativeSpendThreshold) > 0 ? Number(patch.creativeSpendThreshold) : config.creativeSpendThreshold,
                boardSpeedThreshold: Number(patch.boardSpeedThreshold) > 0 ? Number(patch.boardSpeedThreshold) : config.boardSpeedThreshold,
                boardStallMinutes: Number(patch.boardStallMinutes) > 0 ? Number(patch.boardStallMinutes) : config.boardStallMinutes,
              }
              savePanelConfig(dataDir, config)
              scheduleScans()
              return {
                rules: config.rules,
                monitorIntervalMinutes: config.monitorIntervalMinutes,
                feishuWebhook: config.feishuWebhook,
                watchAll: config.watchAll,
                watchAccounts: config.watchAccounts,
                creativeSpendThreshold: config.creativeSpendThreshold,
              boardSpeedThreshold: config.boardSpeedThreshold,
                boardStallMinutes: config.boardStallMinutes,
              }
            },
            getDesk,
            getCampaigns,
            getCampaignDetail,
            getTrend,
            getWatch,
            getDiagnosis,
            getInspect,
    getTimezones,
    getCreativeBoard,
    setGlobalCreativeMeta: (itemId, patch) => board.setGlobalCreativeMeta(itemId, patch),
    expandedCreatives: (moduleId, compare) => board.expandedCreatives(moduleId, compare),
    setCreativeMeta: (moduleId, itemId, patch) => board.setCreativeMeta(moduleId, itemId, patch),
    importProducts: async (base64, meta) => {
      const result = await products.import(base64, meta)
      if (result.ok) productLookup = loadProductLookup(dataDir)
      return result
    },
    listProducts: () => products.list(),
    productAdsJoin: async (query, accountIds) => {
      const accounts = await pickAccounts(accountIds)
      return products.joinWithAds(query, accounts, callTool, resolveRange)
    },
    getInspect,
            runExport,
            exportStatus: () => {
      // 空闲时也返回目录里已生成的 xlsx，方便随时下载
      if (!exportJob.files.length) {
        const dir = exportJob.dir || path.join(os.homedir(), 'Desktop', '广告', '每日广告订单')
        try {
          exportJob.dir = dir
          exportJob.files = fs.readdirSync(dir)
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.xlsx$/.test(name))
            .sort()
            .slice(-30)
            .map((name) => ({ name, path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size }))
        } catch { /* 目录还不存在 */ }
      }
      return exportJob
    },
            board,
            listAccounts,
            getAlerts: async () => ({
              active: alertStore.state.active,
              history: alertStore.state.history,
              lastScanAt: alertStore.state.lastScanAt,
              lastScan,
            }),
            runScan: (options) => runScan(options),
          },
          { port: settings.dashboardPort },
        )
        log(`面板已启动：${dashboard.url}`)
      } catch (error) {
        log(`面板启动失败（端口 ${settings.dashboardPort}）：${error.message}`)
      }
    }
    scheduleScans()
    return { dashboardUrl: dashboard?.url || null }
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    dashboard?.close()
    dashboard = null
  }

  return {
    start,
    stop,
    runScan,
    getDesk,
    getCampaigns,
    getCampaignDetail,
    getTrend,
    getWatch,
    getDiagnosis,
    getInspect,
    getTimezones,
    getCreativeBoard,
    setGlobalCreativeMeta: (itemId, patch) => board.setGlobalCreativeMeta(itemId, patch),
    expandedCreatives: (moduleId, compare) => board.expandedCreatives(moduleId, compare),
    setCreativeMeta: (moduleId, itemId, patch) => board.setCreativeMeta(moduleId, itemId, patch),
    importProducts: async (base64, meta) => {
      const result = await products.import(base64, meta)
      if (result.ok) productLookup = loadProductLookup(dataDir)
      return result
    },
    listProducts: () => products.list(),
    productAdsJoin: async (query, accountIds) => {
      const accounts = await pickAccounts(accountIds)
      return products.joinWithAds(query, accounts, callTool, resolveRange)
    },
    getInspect,
    runExport,
    exportStatus: () => {
      // 空闲时也返回目录里已生成的 xlsx，方便随时下载
      if (!exportJob.files.length) {
        const dir = exportJob.dir || path.join(os.homedir(), 'Desktop', '广告', '每日广告订单')
        try {
          exportJob.dir = dir
          exportJob.files = fs.readdirSync(dir)
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.xlsx$/.test(name))
            .sort()
            .slice(-30)
            .map((name) => ({ name, path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size }))
        } catch { /* 目录还不存在 */ }
      }
      return exportJob
    },
    board,
    listAccounts,
    getConfig: () => config,
    setConfig: (patch) => {
      // 只覆盖 patch 里出现的字段：早期实现会重建对象，把阈值/监控范围全部清空
      const next = { ...config }
      if (patch.rules) next.rules = normalizeRules({ ...config.rules, ...patch.rules })
      if (Number(patch.monitorIntervalMinutes) > 0) next.monitorIntervalMinutes = Number(patch.monitorIntervalMinutes)
      if (typeof patch.feishuWebhook === 'string') next.feishuWebhook = patch.feishuWebhook
      if (typeof patch.watchAll === 'boolean') next.watchAll = patch.watchAll
      if (Array.isArray(patch.watchAccounts)) next.watchAccounts = patch.watchAccounts.map(String).filter(Boolean)
      if (Number(patch.creativeSpendThreshold) > 0) next.creativeSpendThreshold = Number(patch.creativeSpendThreshold)
      if (Number(patch.boardSpeedThreshold) > 0) next.boardSpeedThreshold = Number(patch.boardSpeedThreshold)
      if (Number(patch.boardStallMinutes) > 0) next.boardStallMinutes = Number(patch.boardStallMinutes)
      if (Number(patch.dashboardPort) > 0) next.dashboardPort = Number(patch.dashboardPort)
      config = next
      savePanelConfig(dataDir, config)
      scheduleScans()
      return config
    },
    alerts: () => ({ active: alertStore.state.active, history: alertStore.state.history, lastScanAt: alertStore.state.lastScanAt, lastScan }),
    get dashboardUrl() {
      return dashboard?.url || null
    },
  }
}
