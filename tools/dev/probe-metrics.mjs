/**
 * Find which metric/dimension combinations the GMV Max report endpoint accepts
 * for product (SPU) and creative (post) level breakdowns.
 *
 *   node tools/probe-metrics.mjs [--date 2026-10-27] [--proxy ...]
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const pad = (n) => String(n).padStart(2, '0')
const date = argValue('--date', (() => { const d = new Date(Date.now() - 86_400_000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })())
const settings = normalizeConfig({ proxy: argValue('--proxy', 'auto') })
const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
let auth = readAuth(settings.dataDir)
if (!isTokenUsable(auth, settings.resourceUrl)) {
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
  const tokens = await refreshAccessToken(metadata, { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl }, proxy)
  auth = updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || auth.refreshToken, expiresAt: tokens.expiresAt })
}
const session = new McpSession({ url: settings.resourceUrl, proxy, timeoutMs: 90_000, getToken: async () => auth.accessToken })
await session.connect()

const advertiserId = argValue('--advertiser', '7663409215079202836')
const storeId = argValue('--store', '7494178074073728795')

async function exec(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 120_000 })
  return JSON.parse(result.text)
}
async function tryReport(label, params) {
  try {
    const data = await exec('gmv_max_report_get', params)
    const rows = data.data?.list || []
    console.log(`✓ ${label}: rows=${rows.length}`)
    if (rows.length) console.log(`    sample=${JSON.stringify(rows[0]).slice(0, 700)}`)
    return rows
  } catch (error) {
    console.log(`✗ ${label}: ${error.message.slice(0, 220)}`)
    return null
  }
}

// Active campaigns for the date
const campaigns = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['campaign_id'], page_size: 200,
})
const campaignIds = (campaigns.data?.list || []).filter((r) => Number(r.metrics?.cost) > 0).map((r) => String(r.dimensions.campaign_id))
console.log(`active campaigns=${campaignIds.length} (${date})`)

const base = { advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date, page_size: 500, filtering: { campaign_ids: campaignIds } }

// --- SPU level
const spuRows = await tryReport('dim=[item_group_id] metrics=[cost,orders,gross_revenue]', {
  ...base, dimensions: ['item_group_id'], metrics: ['cost', 'orders', 'gross_revenue', 'roi'],
})
for (const extra of [['product_name'], ['item_group_id'], ['product_name', 'item_group_id'], ['title'], ['campaign_name']]) {
  await tryReport(`dim=[item_group_id] metrics=base+${extra.join('+')}`, {
    ...base, dimensions: ['item_group_id'], metrics: ['cost', 'orders', 'gross_revenue', ...extra],
  })
}

// --- Creative (post) level: needs campaign_ids + item_group_ids
const spuIds = [...new Set((spuRows || []).map((row) => String(row.dimensions?.item_group_id)).filter(Boolean))]
console.log(`\nSPU ids found=${spuIds.length}`)
if (spuIds.length) {
  const itemBase = { ...base, filtering: { campaign_ids: campaignIds, item_group_ids: spuIds } }
  const itemRows = await tryReport('dim=[item_id] metrics=[cost,orders,gross_revenue]', {
    ...itemBase, dimensions: ['item_id'], metrics: ['cost', 'orders', 'gross_revenue', 'roi'],
  })
  for (const extra of [['title'], ['item_id'], ['product_name'], ['tt_account_name'], ['identity_id'], ['shop_content_type'], ['creative_delivery_status'], ['product_impressions', 'product_clicks'], ['product_name', 'title', 'tt_account_name']]) {
    await tryReport(`dim=[item_id] metrics=base+${extra.join('+')}`, {
      ...itemBase, dimensions: ['item_id'], metrics: ['cost', 'orders', 'gross_revenue', ...extra],
    })
  }
  void itemRows
}

// --- Also try item_group_id + item_id in one call
await tryReport('dim=[item_group_id,item_id] metrics=[cost,orders]', {
  ...base, dimensions: ['item_group_id', 'item_id'], metrics: ['cost', 'orders', 'gross_revenue'],
})
