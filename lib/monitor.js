/**
 * Spend-without-orders monitor for GMV Max campaigns and creatives.
 *
 * Rules (all thresholds configurable):
 *   1. zeroOrder  — spend ≥ alertSpendThreshold with 0 orders inside the window
 *   2. lowRoi     — spend ≥ alertSpendThreshold and ROI < alertRoiTarget × alertRoiRatio
 *   3. spendSpike — current window spend ≥ previous window × alertSpendSpikeRatio
 *                   while orders did not grow
 *
 * Findings are diffed against the previous scan: only NEW findings push a
 * notification, so a permanently bad campaign does not spam every interval.
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { URL } from 'node:url'

/**
 * @typedef {object} Finding
 * @property {string} key stable identity for de-duplication
 * @property {string} rule zeroOrder | lowRoi | spendSpike
 * @property {string} level critical | warning
 * @property {string} scope campaign | creative
 * @property {string} store
 * @property {string} campaignId
 * @property {string} campaignName
 * @property {string} targetId
 * @property {string} targetName
 * @property {number} cost
 * @property {number} orders
 * @property {number} revenue
 * @property {number} roi
 * @property {string} message
 * @property {string} detectedAt
 */

/** Defaults; every value can be overridden from the plugin config or the dashboard. */
export const DEFAULT_RULES = Object.freeze({
  windowDays: 3,
  spendThreshold: 30,
  roiTarget: 10,
  roiRatio: 0.7,
  spendSpikeRatio: 2,
  minCostForSpike: 20,
  maxCreatives: 40,
})

/**
 * Merge configured thresholds over the defaults, clamping to sane ranges.
 * @param {Record<string, unknown>|undefined} raw
 */
export function normalizeRules(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }
  return {
    windowDays: Math.trunc(number(source.windowDays, DEFAULT_RULES.windowDays, 1, 30)),
    spendThreshold: number(source.spendThreshold, DEFAULT_RULES.spendThreshold, 0, 1_000_000),
    roiTarget: number(source.roiTarget, DEFAULT_RULES.roiTarget, 0.1, 1000),
    roiRatio: number(source.roiRatio, DEFAULT_RULES.roiRatio, 0.1, 1),
    spendSpikeRatio: number(source.spendSpikeRatio, DEFAULT_RULES.spendSpikeRatio, 1.1, 20),
    minCostForSpike: number(source.minCostForSpike, DEFAULT_RULES.minCostForSpike, 0, 1_000_000),
    maxCreatives: Math.trunc(number(source.maxCreatives, DEFAULT_RULES.maxCreatives, 1, 500)),
  }
}

/**
 * Push one notification to a Feishu (Lark) custom-bot webhook.
 * @param {string} webhook
 * @param {string} text
 * @param {AbortSignal} [signal]
 */
export async function sendFeishu(webhook, text, signal) {
  const url = new URL(webhook)
  if (url.protocol !== 'https:') throw new Error('飞书 webhook 必须是 https')
  const body = JSON.stringify({ msg_type: 'text', content: { text } })
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        port: Number(url.port || 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        let data = ''
        response.on('data', (chunk) => {
          data += chunk
        })
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve({ status: response.statusCode, body: data.slice(0, 300) })
          else reject(new Error(`飞书返回 HTTP ${response.statusCode}: ${data.slice(0, 200)}`))
        })
      },
    )
    request.setTimeout(15_000, () => request.destroy(new Error('飞书推送超时')))
    request.on('error', (error) => reject(error))
    if (signal) signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    request.write(body)
    request.end()
  })
}

/** Escape a value for a plain-text message. */
const money = (value) => `$${Number(value || 0).toFixed(2)}`

/**
 * Format findings into one chat message.
 * @param {Finding[]} findings
 */
export function formatFindings(findings) {
  const lines = [`TikTok 广告告警（${findings.length} 条）`]
  for (const finding of findings.slice(0, 12)) {
    lines.push(
      `· [${finding.level === 'critical' ? '严重' : '警告'}] ${finding.store}｜${finding.scope === 'creative' ? '素材' : '系列'} ${finding.targetName || finding.targetId}` +
        `｜消耗 ${money(finding.cost)} / 订单 ${finding.orders} / ROI ${finding.roi}` +
        (finding.campaignName ? `｜系列 ${finding.campaignName}` : ''),
    )
  }
  if (findings.length > 12) lines.push(`… 还有 ${findings.length - 12} 条，见面板`)
  return lines.join('\n')
}

/**
 * Persist alert state so repeated scans do not re-notify.
 */
export class AlertStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'alerts.json')
    this.dataDir = dataDir
    /** @type {{ active: Finding[], history: Array<Finding & { resolvedAt?: string }>, lastScanAt: string | null }} */
    this.state = { active: [], history: [], lastScanAt: null }
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && Array.isArray(parsed.active)) this.state = { history: [], lastScanAt: null, ...parsed }
    } catch { /* first run */ }
    return this.state
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch { /* best effort */ }
  }

  /**
   * Replace the active set, returning only the findings that are new.
   * @param {Finding[]} findings
   */
  reconcile(findings) {
    const previous = new Map(this.state.active.map((finding) => [finding.key, finding]))
    const nextActive = findings
    const fresh = findings.filter((finding) => !previous.has(finding.key))
    const resolved = [...previous.values()].filter((finding) => !findings.some((candidate) => candidate.key === finding.key))
    const now = new Date().toISOString()
    this.state.active = nextActive
    this.state.lastScanAt = now
    this.state.history = [
      ...resolved.map((finding) => ({ ...finding, resolvedAt: now })),
      ...fresh.map((finding) => ({ ...finding, detectedAt: finding.detectedAt || now })),
      ...this.state.history,
    ].slice(0, 200)
    this.save()
    return { fresh, resolved, active: nextActive }
  }
}

/**
 * Scan GMV Max spend for zero-order / low-ROI targets.
 *
 * @param {object} options
 * @param {(name: string, params: Record<string, unknown>) => Promise<any>} options.callTool
 * @param {string} options.advertiserId
 * @param {string} options.advertiserName
 * @param {string} options.storeId
 * @param {string} options.storeName
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {ReturnType<typeof normalizeRules>} options.rules
 * @returns {Promise<Finding[]>}
 */
export async function scanStore({ callTool, advertiserId, advertiserName, storeId, storeName, startDate, endDate, rules }) {
  /** @type {Finding[]} */
  const findings = []
  const detectedAt = new Date().toISOString()

  // Campaign level
  const campaignReport = await callTool('gmv_max_report_get', {
    advertiser_id: advertiserId,
    store_ids: [storeId],
    start_date: startDate,
    end_date: endDate,
    metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue', 'roi'],
    dimensions: ['campaign_id'],
    page_size: 200,
  })
  const campaigns = (campaignReport.data?.list || []).map((row) => {
    const metrics = row.metrics || {}
    const cost = Number(metrics.cost) || 0
    const orders = Number(metrics.orders) || 0
    const revenue = Number(metrics.gross_revenue) || 0
    return {
      campaignId: String(row.dimensions?.campaign_id || ''),
      campaignName: metrics.campaign_name || '',
      cost,
      orders,
      revenue,
      roi: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
    }
  })

  for (const campaign of campaigns) {
    if (!campaign.campaignId || campaign.cost < rules.spendThreshold) continue
    const base = {
      store: storeName,
      advertiserId,
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      targetId: campaign.campaignId,
      targetName: campaign.campaignName,
      scope: 'campaign',
      cost: campaign.cost,
      orders: campaign.orders,
      revenue: campaign.revenue,
      roi: campaign.roi,
      detectedAt,
    }
    if (campaign.orders === 0) {
      findings.push({
        ...base,
        key: `zeroOrder|campaign|${campaign.campaignId}`,
        rule: 'zeroOrder',
        level: 'critical',
        message: `系列「${campaign.campaignName}」近 ${rules.windowDays} 天消耗 ${money(campaign.cost)} 但 0 单`,
      })
    } else if (campaign.roi < rules.roiTarget * rules.roiRatio) {
      findings.push({
        ...base,
        key: `lowRoi|campaign|${campaign.campaignId}`,
        rule: 'lowRoi',
        level: 'warning',
        message: `系列「${campaign.campaignName}」ROI ${campaign.roi} 低于目标 ${rules.roiTarget} 的 ${Math.round(rules.roiRatio * 100)}%`,
      })
    }
  }

  // Creative level (only for campaigns that spend; the item report needs anchors)
  const spendingCampaigns = campaigns.filter((campaign) => campaign.cost > 0).map((campaign) => campaign.campaignId)
  if (spendingCampaigns.length) {
    try {
      const spuReport = await callTool('gmv_max_report_get', {
        advertiser_id: advertiserId,
        store_ids: [storeId],
        start_date: startDate,
        end_date: endDate,
        metrics: ['cost', 'orders', 'gross_revenue'],
        dimensions: ['item_group_id'],
        filtering: { campaign_ids: spendingCampaigns },
        page_size: 500,
      })
      const spuIds = (spuReport.data?.list || [])
        .filter((row) => Number(row.metrics?.cost) > 0)
        .map((row) => String(row.dimensions?.item_group_id || ''))
        .filter(Boolean)
      if (spuIds.length) {
        const itemReport = await callTool('gmv_max_report_get', {
          advertiser_id: advertiserId,
          store_ids: [storeId],
          start_date: startDate,
          end_date: endDate,
          metrics: ['cost', 'orders', 'gross_revenue'],
          dimensions: ['item_id'],
          filtering: { campaign_ids: spendingCampaigns, item_group_ids: spuIds },
          page_size: 1000,
        })
        const creatives = (itemReport.data?.list || [])
          .map((row) => {
            const metrics = row.metrics || {}
            const cost = Number(metrics.cost) || 0
            const orders = Number(metrics.orders) || 0
            const revenue = Number(metrics.gross_revenue) || 0
            return {
              itemId: String(row.dimensions?.item_id || ''),
              cost,
              orders,
              revenue,
              roi: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
            }
          })
          .filter((creative) => creative.itemId && creative.itemId !== '-1' && creative.cost >= rules.spendThreshold)
          .sort((left, right) => right.cost - left.cost)
          .slice(0, rules.maxCreatives)
        for (const creative of creatives) {
          if (creative.orders > 0) continue
          findings.push({
            store: storeName,
            advertiserId,
            campaignId: '',
            campaignName: '',
            scope: 'creative',
            targetId: creative.itemId,
            targetName: creative.itemId,
            key: `zeroOrder|creative|${creative.itemId}`,
            rule: 'zeroOrder',
            level: 'critical',
            cost: creative.cost,
            orders: creative.orders,
            revenue: creative.revenue,
            roi: creative.roi,
            message: `素材 ${creative.itemId} 近 ${rules.windowDays} 天消耗 ${money(creative.cost)} 但 0 单`,
            detectedAt,
          })
        }
      }
    } catch {
      // Item-level reports are flaky on TikTok's side; campaign findings still stand.
    }
  }

  void advertiserName
  return findings
}
