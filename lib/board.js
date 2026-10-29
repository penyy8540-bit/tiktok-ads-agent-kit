/**
 * Watch board: a persisted list of "monitor modules".
 *
 * A module pins one object chain — 账户 › 广告组 › 素材（可多选）— and is rendered
 * as a card with a note, today's KPIs, a selectable dual-axis chart, and
 * module-level alerts (0-order spend / burn rate / stall).
 *
 * TikTok's GMV Max report supports `stat_time_hour` for advertiser/campaign level
 * only. Item modules therefore keep their own cumulative samples (persisted to
 * watch-samples.json); the hourly curve is derived by differencing those totals
 * per hour.
 */
import fs from 'node:fs'
import path from 'node:path'

const BOARD_FILE = 'watch-board.json'
const SAMPLES_FILE = 'watch-samples.json'
const DAY_MS = 86_400_000
const SAMPLE_TTL_MS = 30 * 60 * 60_000
const pad = (value) => String(value).padStart(2, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const todayRange = () => {
  const now = new Date()
  const date = formatDate(now)
  return { start: date, end: date, days: 1, today: true }
}
const toNumber = (value) => Number(value) || 0
const round2 = (value) => Number(Number(value || 0).toFixed(2))
let sequence = 0
const nextId = () => `m${Date.now().toString(36)}${(sequence++).toString(36)}`

const METRICS = ['cost', 'orders', 'revenue', 'roi', 'cpo']

/** 卡片上最多同时选两个指标：第一个画左轴，第二个画右轴。 */
export function normalizeMetrics(raw, fallback) {
  const list = Array.isArray(raw) ? raw.filter((metric) => METRICS.includes(metric)) : []
  const unique = [...new Set(list)].slice(0, 2)
  return unique.length ? unique : fallback
}

/**
 * @param {string} dataDir
 */
export function loadBoard(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, BOARD_FILE), 'utf8'))
    if (Array.isArray(parsed.modules)) return { modules: parsed.modules.map(normalizeModule).filter(Boolean) }
  } catch { /* first run */ }
  return { modules: [] }
}

/**
 * @param {string} dataDir
 * @param {{ modules: object[] }} board
 */
export function saveBoard(dataDir, board) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dataDir, BOARD_FILE), JSON.stringify(board, null, 2))
  } catch { /* best effort */ }
  return board
}

/** @param {any} raw */
export function normalizeModule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const advertiserId = String(raw.advertiserId || '')
  if (!advertiserId) return null
  const itemIds = Array.isArray(raw.itemIds) ? raw.itemIds.map(String).filter(Boolean).slice(0, 8) : []
  const campaignId = raw.campaignId ? String(raw.campaignId) : ''
  const kind = campaignId ? (itemIds.length ? 'items' : 'campaign') : 'account'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nextId(),
    kind,
    advertiserId,
    accountName: String(raw.accountName || ''),
    storeName: String(raw.storeName || ''),
    campaignId,
    campaignName: String(raw.campaignName || ''),
    itemIds,
    note: String(raw.note || ''),
    leftMetric: raw.leftMetric === 'revenue' ? 'revenue' : 'cost',
    metrics: normalizeMetrics(raw.metrics, raw.leftMetric === 'revenue' ? ['revenue', 'orders'] : ['cost', 'orders']),
    width: raw.width === 'half' ? 'half' : 'full',
    tz: typeof raw.tz === 'string' ? raw.tz : 'account',
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    createdAt: new Date(raw.createdAt || Date.now()).toISOString(),
  }
}

/** Aggregate hourly rows reported by TikTok (advertiser / campaign level). */
export function hourlySeries(rows) {
  const map = new Map()
  for (const row of rows) {
    const stamp = String(row.dimensions?.stat_time_hour || '')
    if (!stamp) continue
    const hour = stamp.slice(11, 16)
    const bucket = map.get(hour) || { hour, stamp, cost: 0, orders: 0, revenue: 0 }
    bucket.cost += toNumber(row.metrics?.cost)
    bucket.orders += toNumber(row.metrics?.orders)
    bucket.revenue += toNumber(row.metrics?.gross_revenue)
    map.set(hour, bucket)
  }
  return [...map.values()]
    .sort((left, right) => left.stamp.localeCompare(right.stamp))
    .map((row) => ({
      hour: row.hour,
      date: row.hour,
      cost: round2(row.cost),
      orders: row.orders,
      revenue: round2(row.revenue),
      roi: row.cost > 0 ? Number((row.revenue / row.cost).toFixed(2)) : 0,
    }))
}

/** Drop hours in the future (and after the last hour with data). */
export function trimSeries(series) {
  if (!series.length) return series
  const currentHour = new Date().getHours()
  const lastWithData = series.reduce((last, point, index) => (point.cost > 0 || point.orders > 0 ? index : last), -1)
  const cutoff = Math.max(currentHour, lastWithData)
  const index = series.findIndex((point) => Number(point.hour.slice(0, 2)) > cutoff)
  return index < 0 ? series : series.slice(0, index)
}

/**
 * Build an hourly series from cumulative snapshots (one list per item).
 * For each hour: value = max(cumulative inside that hour) − max(cumulative of the
 * previous hour that has samples, or 0).
 *
 * @param {Array<Array<{ at: string, cost: number, orders: number, revenue: number }>>} perItemSamples
 */
export function seriesFromSamples(perItemSamples) {
  /** @type {Map<string, { hour: string, last: { cost: number, orders: number, revenue: number } | null }>} */
  const byHour = new Map()
  for (const samples of perItemSamples) {
    for (const sample of samples) {
      const date = new Date(sample.at)
      if (Number.isNaN(date.getTime())) continue
      const hour = `${pad(date.getHours())}:00`
      const bucket = byHour.get(hour) || { hour, last: null }
      if (!bucket.last || sample.cost >= bucket.last.cost) bucket.last = sample
      byHour.set(hour, bucket)
    }
  }
  const hours = [...byHour.values()].sort((left, right) => left.hour.localeCompare(right.hour))
  let previous = { cost: 0, orders: 0, revenue: 0 }
  return hours.map((entry) => {
    const last = entry.last || { cost: 0, orders: 0, revenue: 0 }
    const point = {
      hour: entry.hour,
      date: entry.hour,
      cost: round2(Math.max(0, last.cost - previous.cost)),
      orders: Math.max(0, last.orders - previous.orders),
      revenue: round2(Math.max(0, last.revenue - previous.revenue)),
    }
    point.roi = point.cost > 0 ? Number((point.revenue / point.cost).toFixed(2)) : 0
    previous = last
    return point
  })
}

/**
 * Build the watch board runtime.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(name: string, params: Record<string, unknown>) => Promise<any>} options.callTool
 * @param {() => Promise<Array<{ advertiserId: string, advertiserName: string, storeId: string, storeName: string }>>} options.listAccounts
 * @param {() => { spendThreshold?: number, speedThreshold?: number, stallMinutes?: number }} [options.getRules]
 * @param {(message: string) => void} [options.log]
 */
export function createBoard({ dataDir, callTool, listAccounts, getRules = () => ({}), log = () => {} }) {
  let board = loadBoard(dataDir)
  /** @type {Map<string, Array<{ at: string, cost: number, orders: number, revenue: number }>>} */
  const sampleStore = new Map()
  /** @type {Map<string, { at: string, cost: number, orders: number }>} */
  const snapshotStore = new Map()

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, SAMPLES_FILE), 'utf8'))
    const cutoff = Date.now() - SAMPLE_TTL_MS
    for (const [key, value] of Object.entries(parsed || {})) {
      if (!Array.isArray(value)) continue
      const kept = value.filter((sample) => new Date(sample.at).getTime() >= cutoff)
      if (kept.length) sampleStore.set(key, kept)
    }
  } catch { /* first run */ }

  let flushTimer = null
  const flushSamples = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(dataDir, SAMPLES_FILE), JSON.stringify(Object.fromEntries(sampleStore)))
      } catch { /* best effort */ }
    }, 2000)
  }

  /** 素材收藏 / 备注（按模块 + itemId 存） */
  const CREATIVE_META_FILE = path.join(dataDir, 'watch-creatives.json')
  const GLOBAL_META_FILE = path.join(dataDir, 'watch-creatives-global.json')
  /** @type {Record<string, { favorite?: boolean, note?: string }>} */
  let globalMeta = {}
  try {
    globalMeta = JSON.parse(fs.readFileSync(GLOBAL_META_FILE, 'utf8')) || {}
  } catch { /* first run */ }
  const saveGlobalMeta = () => {
    try {
      fs.writeFileSync(GLOBAL_META_FILE, JSON.stringify(globalMeta, null, 2))
    } catch { /* best effort */ }
  }
  const globalMetaOf = (itemId) => globalMeta[String(itemId)] || {}
  /** @type {Record<string, Record<string, { favorite?: boolean, note?: string }>>} */
  let creativeMeta = {}
  try {
    creativeMeta = JSON.parse(fs.readFileSync(CREATIVE_META_FILE, 'utf8')) || {}
  } catch { /* first run */ }
  const saveCreativeMeta = () => {
    try {
      fs.writeFileSync(CREATIVE_META_FILE, JSON.stringify(creativeMeta, null, 2))
    } catch { /* best effort */ }
  }

  /** 整块看板数据的短缓存：切回盯盘要秒开，同时后台刷新。 */
  let dataCache = { at: 0, payload: null, pending: null }

  /** 每个模块最近一次成功的数据：限流/网络抖动时用它兜底，别把卡片清空。 */
  const lastGood = new Map()
  const LAST_GOOD_FILE = path.join(dataDir, 'watch-last.json')
  try {
    const saved = JSON.parse(fs.readFileSync(LAST_GOOD_FILE, 'utf8'))
    for (const [id, value] of Object.entries(saved || {})) {
      if (value && value.totals) lastGood.set(id, { ...value, fetchedAt: value.fetchedAt || Date.now() })
    }
  } catch { /* first run */ }
  const flushLastGood = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(LAST_GOOD_FILE, JSON.stringify(Object.fromEntries(lastGood)))
    } catch { /* best effort */ }
  }

  /** 最近一次 data() 的结果，供告警复用（5 分钟内有效）。 */
  let lastData = { at: 0, modules: [] }

  const moduleLabel = (module) => {
    const parts = [module.storeName || module.accountName || module.advertiserId]
    if (module.campaignName || module.campaignId) parts.push(module.campaignName || module.campaignId)
    if (module.itemIds.length) {
      parts.push(module.itemIds.length === 1 ? `素材 ${module.itemIds[0].slice(-8)}` : `素材 ${module.itemIds.map((id) => id.slice(-6)).join(' + ')}`)
    }
    return parts.filter(Boolean).join(' › ')
  }

  const recordSample = (key, sample) => {
    const history = sampleStore.get(key) || []
    const last = history[history.length - 1]
    if (!last || last.cost !== sample.cost || last.orders !== sample.orders || last.revenue !== sample.revenue) {
      history.push(sample)
      const cutoff = Date.now() - SAMPLE_TTL_MS
      sampleStore.set(key, history.filter((entry) => new Date(entry.at).getTime() >= cutoff).slice(-600))
      flushSamples()
    } else if (history.length) {
      history[history.length - 1] = sample
    }
  }

  const sumPoints = (series) => {
    const totals = series.reduce(
      (acc, point) => ({ cost: acc.cost + point.cost, orders: acc.orders + point.orders, revenue: acc.revenue + point.revenue }),
      { cost: 0, orders: 0, revenue: 0 },
    )
    return {
      cost: round2(totals.cost),
      orders: totals.orders,
      revenue: round2(totals.revenue),
      roi: totals.cost > 0 ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
      costPerOrder: totals.orders > 0 ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
    }
  }

  /** 「实时」信息：与上次快照的增量、折算速度、当前小时。 */
  const liveOf = (key, totals, series, sampled) => {
    const previous = snapshotStore.get(key)
    const at = new Date()
    snapshotStore.set(key, { at: at.toISOString(), cost: totals.cost, orders: totals.orders })
    const elapsedMs = previous ? at.getTime() - new Date(previous.at).getTime() : 0
    const deltaCost = previous ? round2(totals.cost - previous.cost) : null
    const deltaOrders = previous ? totals.orders - previous.orders : null
    const perHour = elapsedMs >= 20_000 && deltaCost !== null ? round2((deltaCost / elapsedMs) * 3_600_000) : null
    const hourLabel = `${pad(at.getHours())}:00`
    const currentHour = series.find((point) => point.hour === hourLabel) || null
    const withData = series.filter((point) => point.cost > 0 || point.orders > 0)
    const last = withData.length ? withData[withData.length - 1] : null
    return {
      deltaCost,
      deltaOrders,
      perHour,
      sinceMs: elapsedMs,
      currentHourCost: currentHour ? currentHour.cost : 0,
      currentHourOrders: currentHour ? currentHour.orders : 0,
      lastHour: last ? last.hour : null,
      lastHourCost: last ? last.cost : 0,
      sampled,
    }
  }

  /** Module-level alerts, evaluated on every refresh. */
  const alertsOf = (module, totals, series, live) => {
    const rules = { spendThreshold: 30, speedThreshold: 40, stallMinutes: 120, ...getRules() }
    const alerts = []
    const label = moduleLabel(module)
    if (totals.cost >= rules.spendThreshold && totals.orders === 0) {
      alerts.push({ level: 'critical', rule: 'zeroOrder', message: `${label}：今日消耗 $${totals.cost.toFixed(2)} 但 0 单` })
    }
    if (live.perHour !== null && live.perHour >= rules.speedThreshold && totals.orders === 0) {
      alerts.push({ level: 'warning', rule: 'burnRate', message: `${label}：当前速度 ≈ $${Math.round(live.perHour)}/小时 且 0 单` })
    }
    if (live.lastHour && totals.cost > 0) {
      const now = new Date()
      const [hour, minute] = live.lastHour.split(':').map(Number)
      const lastStamp = new Date(now)
      lastStamp.setHours(hour, minute || 0, 0, 0)
      const idleMinutes = Math.round((now.getTime() - lastStamp.getTime()) / 60_000)
      // 只在 6 小时以内停摆才算异常；更久通常是这个时段本来就不投，避免噪音
      if (idleMinutes >= rules.stallMinutes && idleMinutes <= 360) {
        alerts.push({ level: 'warning', rule: 'stalled', message: `${label}：最近 ${idleMinutes} 分钟没有新增消耗（最后一笔在 ${live.lastHour}）` })
      }
    }
    void series
    return alerts
  }

  const resolveAccount = async (advertiserId) => {
    const accounts = await listAccounts()
    return accounts.find((account) => account.advertiserId === String(advertiserId))
  }

  /** Hourly series + totals + live + alerts for one module. */
  async function moduleData(module) {
    const range = todayRange()
    const account = await resolveAccount(module.advertiserId)
    if (!account) throw new Error(`账户不可用：${module.advertiserId}`)
    const base = {
      advertiser_id: account.advertiserId,
      store_ids: [account.storeId],
      start_date: range.start,
      end_date: range.end,
      metrics: ['cost', 'orders', 'gross_revenue'],
      page_size: 1000,
    }

    if (module.kind === 'account' || module.kind === 'campaign') {
      const data = await callTool('gmv_max_report_get', {
        ...base,
        dimensions: module.kind === 'campaign' ? ['campaign_id', 'stat_time_hour'] : ['advertiser_id', 'stat_time_hour'],
      })
      let rows = data.data?.list || []
      if (module.kind === 'campaign') rows = rows.filter((row) => String(row.dimensions?.campaign_id || '') === module.campaignId)
      const series = trimSeries(hourlySeries(rows))
      const totals = sumPoints(series)
      const live = liveOf(module.id, totals, series, false)
      return {
        module: { ...module, label: moduleLabel(module) },
        label: moduleLabel(module),
        sampled: false,
        series,
        totals,
        live,
        alerts: alertsOf(module, totals, series, live),
        updatedAt: new Date().toISOString(),
      }
    }

    // ---- items: cumulative snapshots per item → hourly deltas ----
    const campaignIds = module.campaignId ? [module.campaignId] : []
    let spuIds = []
    if (campaignIds.length) {
      const spuReport = await callTool('gmv_max_report_get', {
        ...base,
        dimensions: ['item_group_id'],
        filtering: { campaign_ids: campaignIds },
      })
      spuIds = (spuReport.data?.list || [])
        .filter((row) => toNumber(row.metrics?.cost) > 0 || toNumber(row.metrics?.orders) > 0)
        .map((row) => String(row.dimensions?.item_group_id || ''))
        .filter(Boolean)
    }
    const data = await callTool('gmv_max_report_get', {
      ...base,
      dimensions: ['item_id'],
      filtering: {
        campaign_ids: campaignIds.length ? campaignIds : undefined,
        item_group_ids: spuIds.length ? spuIds : undefined,
      },
    })
    const rows = (data.data?.list || []).filter((row) => module.itemIds.includes(String(row.dimensions?.item_id || '')))
    const at = new Date().toISOString()
    const items = []
    const seen = new Set()
    for (const row of rows) {
      const itemId = String(row.dimensions?.item_id || '')
      if (!itemId || seen.has(itemId)) continue
      seen.add(itemId)
      const sample = {
        at,
        cost: toNumber(row.metrics?.cost),
        orders: toNumber(row.metrics?.orders),
        revenue: toNumber(row.metrics?.gross_revenue),
      }
      recordSample(`${account.advertiserId}:${itemId}`, sample)
      items.push({
        itemId,
        cost: round2(sample.cost),
        orders: sample.orders,
        revenue: round2(sample.revenue),
        roi: sample.cost > 0 ? Number((sample.revenue / sample.cost).toFixed(2)) : 0,
      })
    }
    for (const itemId of module.itemIds) {
      if (!seen.has(itemId)) recordSample(`${account.advertiserId}:${itemId}`, { at, cost: 0, orders: 0, revenue: 0 })
    }
    const perItemSamples = module.itemIds.map((itemId) => sampleStore.get(`${account.advertiserId}:${itemId}`) || [])
    let series = seriesFromSamples(perItemSamples)
    // TikTok 不提供素材级小时数据：采样点太少时，用所属广告组的小时曲线兜底，
    // 免得素材模块刚建时曲线几乎是空的。
    if (series.length < 3 && module.campaignId) {
      try {
        const hourly = await callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: todayRange().start,
          end_date: todayRange().end,
          metrics: ['cost', 'orders', 'gross_revenue'],
          dimensions: ['campaign_id'],
          filtering: { campaign_ids: [module.campaignId] },
          page_size: 500,
        })
        const fallback = (hourly.data?.list || [])
          .map((row) => ({
            hour: String(row.dimensions?.stat_time_hour || ''),
            cost: toNumber(row.metrics?.cost),
            orders: toNumber(row.metrics?.orders),
            revenue: toNumber(row.metrics?.gross_revenue),
          }))
          .filter((row) => row.hour)
        if (fallback.length >= 3) series = fallback
      } catch (error) {
        log(`素材模块兜底曲线失败 ${error.message}`)
      }
    }
    const totals = sumPoints(series)
    const live = liveOf(module.id, totals, series, true)
    return {
      module: { ...module, label: moduleLabel(module) },
      label: moduleLabel(module),
      sampled: true,
      series,
      totals,
      live,
      alerts: alertsOf(module, totals, series, live),
      items,
      updatedAt: at,
    }
  }

  /** 卡片内「素材实时」的短缓存：60 秒内重复展开不再重新拉数。 */
  const expandedCache = new Map()
  const expandedCacheGet = (key, ttl = 60_000) => {
    const hit = expandedCache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.value
    return null
  }
  const expandedCacheSet = (key, value) => {
    if (expandedCache.size > 40) expandedCache.clear()
    expandedCache.set(key, { at: Date.now(), value })
  }

  /** 拉某个模块下的素材（今天），可附带对比基线（指定日 / 近 N 天均值）。 */
  async function expandedCreatives(moduleId, compare) {
    const module = board.modules.find((item) => item.id === moduleId)
    if (!module) throw new Error('模块不存在')
    const account = await resolveAccount(module.advertiserId)
    if (!account) throw new Error('账户不可用')
    const today = todayRange()
    const mode = compare && compare.mode ? compare.mode : 'none'
    const cacheKey = [module.id, mode, (compare && compare.days) || 7, (compare && compare.date) || '', today.start].join('|')
    const cachedResult = expandedCacheGet(cacheKey)
    if (cachedResult) return cachedResult
    const baselineDays = Math.max(1, Number(compare && compare.days) || 7)
    const baselineDate = /^\d{4}-\d{2}-\d{2}$/.test(String(compare && compare.date)) ? compare.date : ''
    const yesterday = new Date(Date.now() - 86_400_000)
    const baselineRange = mode === 'day' && baselineDate
      ? { start: baselineDate, end: baselineDate, days: 1 }
      : {
        start: formatDate(new Date(yesterday.getTime() - (baselineDays - 1) * 86_400_000)),
        end: formatDate(yesterday),
        days: baselineDays,
      }

    const collect = async (range) => {
      const rows = new Map()
      let campaignList = []
      if (module.campaignId) {
        campaignList = [{ campaignId: module.campaignId }]
      } else {
        try {
          const report = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost'],
            dimensions: ['campaign_id'],
            page_size: 200,
          })
          campaignList = (report.data?.list || [])
            .filter((row) => toNumber(row.metrics?.cost) > 0)
            .sort((left, right) => toNumber(right.metrics?.cost) - toNumber(left.metrics?.cost))
            .slice(0, 3)
            .map((row) => ({ campaignId: String(row.dimensions?.campaign_id || '') }))
            .filter((row) => row.campaignId)
        } catch (error) {
          log(`展开明细：广告组列表失败 ${error.message}`)
        }
      }
      for (const campaign of campaignList) {
        try {
          const spuReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders'],
            dimensions: ['item_group_id'],
            filtering: { campaign_ids: [campaign.campaignId] },
            page_size: 500,
          })
          const spuIds = (spuReport.data?.list || [])
            .filter((row) => toNumber(row.metrics?.cost) > 0 || toNumber(row.metrics?.orders) > 0)
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
            filtering: { campaign_ids: [campaign.campaignId], item_group_ids: spuIds },
            page_size: 1000,
          })
          for (const row of itemReport.data?.list || []) {
            const itemId = String(row.dimensions?.item_id || '')
            if (!itemId || itemId === '-1') continue
            const bucket = rows.get(itemId) || { itemId, cost: 0, orders: 0, revenue: 0, clicks: 0 }
            bucket.cost += toNumber(row.metrics?.cost)
            bucket.orders += toNumber(row.metrics?.orders)
            bucket.revenue += toNumber(row.metrics?.gross_revenue)
            bucket.clicks += toNumber(row.metrics?.product_clicks)
            rows.set(itemId, bucket)
          }
        } catch (error) {
          log(`展开明细：${campaign.campaignId} 失败 ${error.message}`)
        }
      }
      return rows
    }

    const todayRows = await collect(today)
    let baselineRows = new Map()
    if (mode === 'day' || mode === 'avg') baselineRows = await collect(baselineRange)
    const meta = creativeMeta[module.id] || {}
    const rows = [...todayRows.values()].filter((row) => row.cost > 0 || row.orders > 0).map((row) => {
      const base = baselineRows.get(row.itemId)
      const baseCost = base ? (mode === 'avg' ? base.cost / baselineRange.days : base.cost) : null
      const baseOrders = base ? (mode === 'avg' ? base.orders / baselineRange.days : base.orders) : null
      return {
        itemId: row.itemId,
        cost: round2(row.cost),
        orders: row.orders,
        revenue: round2(row.revenue),
        roi: row.cost > 0 ? Number((row.revenue / row.cost).toFixed(2)) : 0,
        clicks: row.clicks,
        baselineCost: baseCost === null ? null : round2(baseCost),
        baselineOrders: baseOrders === null ? null : Number(baseOrders.toFixed(1)),
        deltaCost: baseCost === null ? null : round2(row.cost - baseCost),
        favorite: Boolean(meta[row.itemId] && meta[row.itemId].favorite),
        note: (meta[row.itemId] && meta[row.itemId].note) || '',
      }
    })
    rows.sort((left, right) => {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1
      return right.cost - left.cost
    })
    const limited = rows.length > 120 ? rows.slice(0, 120) : rows
    const payload = {
      ok: true,
      module: { id: module.id, label: moduleLabel(module), kind: module.kind },
      compare: { mode, days: baselineRange.days, start: baselineRange.start, end: baselineRange.end },
      rows: limited,
      total: rows.length,
      updatedAt: new Date().toISOString(),
    }
    expandedCacheSet(cacheKey, payload)
    return payload
  }

  /** Findings shaped like monitor findings so alerts.json + Feishu work unchanged. */
  async function alertFindings() {
    const findings = []
    const fresh = Date.now() - lastData.at < 5 * 60_000 ? lastData.modules : null
    const source = fresh || (await this.data()).modules
    for (const entry of source) {
      try {
        const module = entry.module
        const data = entry
        for (const alert of data.alerts || []) {
          if (alert.rule === 'error') continue
          findings.push({
            key: `board|${alert.rule}|${module.id}`,
            rule: alert.rule,
            level: alert.level,
            advertiserId: module.advertiserId,
            scope: module.kind === 'items' ? 'creative' : 'campaign',
            store: module.storeName || module.accountName || module.advertiserId,
            campaignId: module.campaignId,
            campaignName: module.campaignName,
            targetId: module.itemIds.length ? module.itemIds.join(',') : module.campaignId || module.advertiserId,
            targetName: data.label,
            cost: data.totals.cost,
            orders: data.totals.orders,
            revenue: data.totals.revenue,
            roi: data.totals.roi,
            message: alert.message,
            detectedAt: new Date().toISOString(),
          })
        }
      } catch (error) {
        log(`盯盘告警：${(entry && entry.module && entry.module.id) || '?'} 失败 ${error.message}`)
      }
    }
    return findings
  }

  // ------------------------------------------------------------- search index
  /** @type {{ at: number, campaigns: Map<string, any>, items: Map<string, any>, building: Promise<any>|null, progress: string }} */
  const inventory = { at: 0, campaigns: new Map(), items: new Map(), building: null, progress: '' }

  async function buildInventory(days = 7) {
    if (inventory.building) return inventory.building
    inventory.building = (async () => {
      const accounts = await listAccounts()
      const end = new Date(Date.now() - DAY_MS)
      const start = new Date(end.getTime() - (days - 1) * DAY_MS)
      const base = { start_date: formatDate(start), end_date: formatDate(end), metrics: ['cost', 'orders', 'gross_revenue'], page_size: 1000 }
      const campaigns = new Map()
      const items = new Map()
      let index = 0
      for (const account of accounts) {
        index++
        inventory.progress = `正在建索引（${index}/${accounts.length}）：${account.storeName}`
        const scope = { ...base, advertiser_id: account.advertiserId, store_ids: [account.storeId] }
        let campaignRows = []
        try {
          const data = await callTool('gmv_max_report_get', {
            ...scope,
            metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue'],
            dimensions: ['campaign_id'],
          })
          campaignRows = data.data?.list || []
        } catch (error) {
          log(`搜索索引：${account.storeName} 广告组失败 ${error.message}`)
          continue
        }
        for (const row of campaignRows) {
          const campaignId = String(row.dimensions?.campaign_id || '')
          if (!campaignId) continue
          const metrics = row.metrics || {}
          const campaignName = metrics.campaign_name || campaignId
          campaigns.set(campaignId, {
            kind: 'campaign',
            advertiserId: account.advertiserId,
            storeName: account.storeName,
            accountName: account.advertiserName,
            campaignId,
            campaignName,
            cost: toNumber(metrics.cost),
            orders: toNumber(metrics.orders),
            revenue: toNumber(metrics.gross_revenue),
          })
          if (toNumber(metrics.cost) <= 0 && toNumber(metrics.orders) <= 0) continue
          try {
            const spuReport = await callTool('gmv_max_report_get', {
              ...scope,
              dimensions: ['item_group_id'],
              metrics: ['cost', 'orders'],
              filtering: { campaign_ids: [campaignId] },
            })
            const spuIds = (spuReport.data?.list || [])
              .filter((spuRow) => toNumber(spuRow.metrics?.cost) > 0 || toNumber(spuRow.metrics?.orders) > 0)
              .map((spuRow) => String(spuRow.dimensions?.item_group_id || ''))
              .filter(Boolean)
            if (!spuIds.length) continue
            const itemReport = await callTool('gmv_max_report_get', {
              ...scope,
              dimensions: ['item_id'],
              metrics: ['cost', 'orders', 'gross_revenue'],
              filtering: { campaign_ids: [campaignId], item_group_ids: spuIds },
            })
            for (const itemRow of itemReport.data?.list || []) {
              const itemId = String(itemRow.dimensions?.item_id || '')
              if (!itemId || itemId === '-1') continue
              const itemMetrics = itemRow.metrics || {}
              items.set(itemId, {
                kind: 'items',
                advertiserId: account.advertiserId,
                storeName: account.storeName,
                accountName: account.advertiserName,
                campaignId,
                campaignName,
                itemId,
                cost: toNumber(itemMetrics.cost),
                orders: toNumber(itemMetrics.orders),
                revenue: toNumber(itemMetrics.gross_revenue),
              })
            }
          } catch (error) {
            log(`搜索索引：${account.storeName}/${campaignId} 素材失败 ${error.message}`)
          }
        }
      }
      inventory.at = Date.now()
      inventory.campaigns = campaigns
      inventory.items = items
      inventory.progress = `已索引 ${campaigns.size} 个广告组、${items.size} 条素材`
      return inventory
    })()
    try {
      return await inventory.building
    } finally {
      inventory.building = null
    }
  }

  return {
    /** 增删改后清掉整块数据缓存，避免下一次读到旧的模块列表。 */
    invalidate() {
      dataCache = { at: 0, payload: null, pending: null }
    },
    list: () => board.modules.map((module) => ({ ...module, label: moduleLabel(module) })),
    add(raw) {
      const module = normalizeModule({ ...raw, id: nextId(), createdAt: new Date().toISOString(), order: board.modules.length })
      if (!module) throw new Error('盯盘对象无效：缺少账户')
      board.modules = [...board.modules, module]
      saveBoard(dataDir, board)
      dataCache = { at: 0, payload: null, pending: null }
      return { ...module, label: moduleLabel(module) }
    },
    update(id, patch) {
      board.modules = board.modules.map((module) => (module.id === id ? normalizeModule({ ...module, ...patch, id: module.id, createdAt: module.createdAt }) || module : module))
      saveBoard(dataDir, board)
      dataCache = { at: 0, payload: null, pending: null }
      const updated = board.modules.find((module) => module.id === id)
      return updated ? { ...updated, label: moduleLabel(updated) } : null
    },
    remove(id) {
      board.modules = board.modules.filter((module) => module.id !== id)
      saveBoard(dataDir, board)
      dataCache = { at: 0, payload: null, pending: null }
      return { ok: true }
    },
    reorder(ids) {
      const order = new Map(ids.map((id, index) => [String(id), index]))
      board.modules = board.modules
        .map((module) => ({ ...module, order: order.has(module.id) ? order.get(module.id) : module.order }))
        .sort((left, right) => left.order - right.order)
      saveBoard(dataDir, board)
      return board.modules.map((module) => ({ ...module, label: moduleLabel(module) }))
    },
    async computeData() {
      // Each module is independent; fetch them concurrently because the panel polls.
      const results = await Promise.all(board.modules.map(async (module) => {
        try {
          const data = await moduleData(module)
          lastGood.set(module.id, { ...data, fetchedAt: Date.now() })
          flushLastGood()
          return data
        } catch (error) {
          log(`盯盘模块失败 ${module.id}: ${error.message}`)
          const cached = lastGood.get(module.id)
          const rateLimited = /rate|limit|429|too many/i.test(String(error.message))
          if (cached) {
            return {
              ...cached,
              module: { ...cached.module, ...module, label: moduleLabel(module) },
              stale: true,
              staleSince: new Date(cached.fetchedAt).toISOString(),
              error: String(error.message),
              alerts: [
                {
                  level: 'warning',
                  rule: 'stale',
                  message: `${moduleLabel(module)}：${rateLimited ? '接口限流' : '拉取失败'}，显示 ${new Date(cached.fetchedAt).toLocaleTimeString('zh-CN')} 的数据`,
                },
              ],
            }
          }
          return {
            module: { ...module, label: moduleLabel(module) },
            label: moduleLabel(module),
            error: String(error.message),
            series: [],
            totals: { cost: 0, orders: 0, revenue: 0, roi: 0, costPerOrder: 0 },
            live: { deltaCost: null, deltaOrders: null, perHour: null, currentHourCost: 0, currentHourOrders: 0 },
            alerts: [{ level: 'warning', rule: 'error', message: `${moduleLabel(module)}：数据拉取失败（${error.message}）` }],
          }
        }
      }))
      lastData = { at: Date.now(), modules: results }
      return { modules: results, updatedAt: new Date().toISOString() }
    },
    /**
     * Cached board data. Fresh cache (<15s) returns immediately; a stale cache is
     * returned instantly while a background refresh runs, so switching tabs is
     * instant instead of waiting for 3 modules of API calls.
     */
    async data() {
      const age = Date.now() - dataCache.at
      if (dataCache.payload && age < 15_000) return dataCache.payload
      const refresh = () => {
        if (dataCache.pending) return dataCache.pending
        dataCache.pending = this.computeData()
          .then((payload) => {
            dataCache = { at: Date.now(), payload, pending: null }
            return payload
          })
          .catch((error) => {
            dataCache.pending = null
            throw error
          })
        return dataCache.pending
      }
      if (dataCache.payload) {
        refresh().catch((error) => log(`盯盘后台刷新失败 ${error.message}`))
        return { ...dataCache.payload, staleRefresh: true }
      }
      // 冷启动：先用磁盘里上次成功的数据渲染，别让用户等 30 秒
      const seeded = board.modules.map((module) => lastGood.get(module.id)).filter(Boolean)
      if (seeded.length) {
        const payload = { modules: seeded, updatedAt: new Date().toISOString(), fromDisk: true }
        dataCache = { at: Date.now() - 16_000, payload, pending: null }
        refresh().catch((error) => log(`盯盘后台刷新失败 ${error.message}`))
        return payload
      }
      return refresh()
    },
    expandedCreatives,
    creativeMeta: () => globalMeta,
    setGlobalCreativeMeta(itemId, patch) {
      if (!itemId) throw new Error('缺少素材 ID')
      const current = globalMeta[String(itemId)] || {}
      globalMeta[String(itemId)] = {
        ...current,
        ...(typeof patch.favorite === 'boolean' ? { favorite: patch.favorite } : {}),
        ...(typeof patch.note === 'string' ? { note: patch.note } : {}),
      }
      saveGlobalMeta()
      return globalMeta[String(itemId)]
    },
    setCreativeMeta(moduleId, itemId, patch) {
      if (!moduleId || !itemId) throw new Error('缺少模块或素材 ID')
      creativeMeta[moduleId] = creativeMeta[moduleId] || {}
      const current = creativeMeta[moduleId][itemId] || {}
      creativeMeta[moduleId][itemId] = {
        ...current,
        ...(typeof patch.favorite === 'boolean' ? { favorite: patch.favorite } : {}),
        ...(typeof patch.note === 'string' ? { note: patch.note } : {}),
      }
      saveCreativeMeta()
      return creativeMeta[moduleId][itemId]
    },
    alertFindings,
    async search(query, { rebuild = false } = {}) {
      const tokens = String(query || '')
        .split(/[\s,，;；]+/)
        .map((token) => token.trim())
        .filter((token) => /^\d{6,}$/.test(token))
        .slice(0, 20)
      if (!tokens.length) return { matches: [], note: '请输入数字 ID（素材ID 或 广告组ID）' }
      if (rebuild || Date.now() - inventory.at > 10 * 60_000 || (!inventory.campaigns.size && !inventory.items.size)) await buildInventory()
      const matches = []
      const missing = []
      for (const token of tokens) {
        if (inventory.campaigns.has(token)) matches.push(inventory.campaigns.get(token))
        else if (inventory.items.has(token)) matches.push(inventory.items.get(token))
        else missing.push(token)
      }
      return {
        matches,
        missing,
        indexed: { campaigns: inventory.campaigns.size, items: inventory.items.size },
        note: matches.length ? '' : '没有在最近 7 天有消耗的广告组/素材里找到这些 ID',
      }
    },
    sampleCount: () => [...sampleStore.values()].reduce((sum, list) => sum + list.length, 0),
  }
}
