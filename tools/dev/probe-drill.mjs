/**
 * Probe which drill-down dimensions the GMV Max report accepts, for the
 * redesigned dashboard (account → campaign → SKU / creative → daily trend).
 *
 *   node tools/probe-drill.mjs [--date 2026-10-27]
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const settings = normalizeConfig({ proxy: 'auto' })
const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
let auth = readAuth(settings.dataDir)
if (!isTokenUsable(auth, settings.resourceUrl)) {
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
  const tokens = await refreshAccessToken(metadata, { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl }, proxy)
  auth = updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || auth.refreshToken, expiresAt: tokens.expiresAt })
}
const session = new McpSession({ url: settings.resourceUrl, proxy, timeoutMs: 120_000, getToken: async () => auth.accessToken })
await session.connect()

const advertiserId = value('--advertiser', '7663409215079202836')
const storeId = value('--store', '7494178074073728795')
const end = value('--date', '2026-10-27')
const start = value('--start', '2026-10-21')

async function exec(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 180_000 })
  return JSON.parse(result.text)
}
async function attempt(label, params) {
  try {
    const data = await exec('gmv_max_report_get', params)
    const rows = data.data?.list || []
    console.log(`✓ ${label}: rows=${rows.length}`)
    if (rows.length) console.log(`    sample=${JSON.stringify(rows[0]).slice(0, 360)}`)
    return rows
  } catch (error) {
    console.log(`✗ ${label}: ${String(error.message).slice(0, 160)}`)
    return null
  }
}

const base = { advertiser_id: advertiserId, store_ids: [storeId], start_date: start, end_date: end, page_size: 1000 }
const campaigns = await exec('gmv_max_report_get', { ...base, metrics: ['cost'], dimensions: ['campaign_id'] })
const campaignIds = (campaigns.data?.list || []).filter((row) => Number(row.metrics?.cost) > 0).map((row) => String(row.dimensions.campaign_id))
console.log(`campaigns=${campaignIds.length}`)

const spus = await exec('gmv_max_report_get', { ...base, metrics: ['cost'], dimensions: ['item_group_id'], filtering: { campaign_ids: campaignIds } })
const spuIds = (spus.data?.list || []).slice(0, 20).map((row) => String(row.dimensions.item_group_id))
console.log(`spus=${spuIds.length}\n`)

console.log('=== 1) campaign + SPU（广告组 → SKU 一次拿）===')
await attempt('dim=[campaign_id, item_group_id]', { ...base, dimensions: ['campaign_id', 'item_group_id'], metrics: ['cost', 'orders', 'gross_revenue'] })
await attempt('dim=[item_group_id] filtering campaign', { ...base, dimensions: ['item_group_id'], metrics: ['cost', 'orders', 'gross_revenue'], filtering: { campaign_ids: campaignIds } })

console.log('\n=== 2) creative + day（素材 → 每天）===')
await attempt('dim=[item_id, stat_time_day]', {
  ...base,
  dimensions: ['item_id', 'stat_time_day'],
  metrics: ['cost', 'orders', 'gross_revenue'],
  filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
})
await attempt('dim=[item_id] 单日', {
  ...base, start_date: end, end_date: end,
  dimensions: ['item_id'],
  metrics: ['cost', 'orders', 'gross_revenue'],
  filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
})

console.log('\n=== 3) SPU + day（SKU → 每天）===')
await attempt('dim=[item_group_id, stat_time_day]', { ...base, dimensions: ['item_group_id', 'stat_time_day'], metrics: ['cost', 'orders', 'gross_revenue'], filtering: { campaign_ids: campaignIds } })

console.log('\n=== 4) campaign + day（广告组 → 每天）===')
await attempt('dim=[campaign_id, stat_time_day]', { ...base, dimensions: ['campaign_id', 'stat_time_day'], metrics: ['cost', 'orders', 'gross_revenue'] })

console.log('\n=== 5) creative 单条 + day（指定 item_id 过滤）===')
const items = await exec('gmv_max_report_get', {
  ...base, dimensions: ['item_id'], metrics: ['cost'],
  filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
})
const itemIds = (items.data?.list || []).filter((row) => Number(row.metrics?.cost) > 0).slice(0, 3).map((row) => String(row.dimensions.item_id))
console.log(`pick items=${itemIds.join(',')}`)
await attempt('dim=[item_id, stat_time_day] 单素材', {
  ...base,
  dimensions: ['item_id', 'stat_time_day'],
  metrics: ['cost', 'orders', 'gross_revenue'],
  filtering: { campaign_ids: campaignIds, item_group_ids: spuIds, item_ids: itemIds },
})
