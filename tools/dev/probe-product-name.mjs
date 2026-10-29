/**
 * Try to obtain product metadata (name / SKU) for GMV Max SPU ids from the Ads
 * MCP, so 商品明细 can be labelled without a Seller Center export.
 *
 *   node tools/probe-product-name.mjs [--date 2026-10-27]
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
const settings = normalizeConfig({ proxy: 'auto' })
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
const bcId = argValue('--bc', '7662335243316985874')

async function exec(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 120_000 })
  return JSON.parse(result.text)
}
async function attempt(label, name, params) {
  try {
    const data = await exec(name, params)
    const body = data.data || {}
    const list = body.list || body.products || body.sessions || body.videos || []
    console.log(`✓ ${label}: rows=${Array.isArray(list) ? list.length : 'n/a'}`)
    if (Array.isArray(list) && list.length) console.log(`    sample=${JSON.stringify(list[0]).slice(0, 600)}`)
    return list
  } catch (error) {
    console.log(`✗ ${label}: ${String(error.message).slice(0, 200)}`)
    return null
  }
}

// campaign ids with spend today
const campaigns = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['campaign_id'], page_size: 200,
})
const campaignIds = (campaigns.data?.list || []).filter((r) => Number(r.metrics?.cost) > 0).map((r) => String(r.dimensions.campaign_id))
const spus = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['item_group_id'], filtering: { campaign_ids: campaignIds }, page_size: 500,
})
const spuIds = [...new Set((spus.data?.list || []).map((r) => String(r.dimensions.item_group_id)).filter(Boolean))]
console.log(`campaigns=${campaignIds.length} spus=${spuIds.length}\n`)

console.log('=== 1) report metrics with product metadata only ===')
for (const metrics of [
  ['product_name'],
  ['product_name', 'item_group_id'],
  ['product_name', 'product_status'],
  ['item_group_id'],
  ['product_name', 'product_image_url'],
]) {
  await attempt(`dim=[item_group_id] metrics=${metrics.join('+')}`, 'gmv_max_report_get', {
    advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
    metrics, dimensions: ['item_group_id'], filtering: { campaign_ids: campaignIds }, page_size: 500,
  })
}

console.log('\n=== 2) gmv_max session list (product level) ===')
await attempt('campaign_gmv_max_session_list_get', 'campaign_gmv_max_session_list_get', {
  advertiser_id: advertiserId,
  filtering: { campaign_ids: campaignIds.slice(0, 3) },
  page_size: 20,
})

console.log('\n=== 3) gmv_max_video_get with spu filter (posts carry product info?) ===')
await attempt('gmv_max_video_get spu', 'gmv_max_video_get', {
  advertiser_id: advertiserId,
  store_id: storeId,
  store_authorized_bc_id: bcId,
  spu_id_list: spuIds.slice(0, 3),
  page_size: 5,
})

console.log('\n=== 4) showcase / store products ===')
await attempt('gmv_max_store_list_get', 'gmv_max_store_list_get', { advertiser_id: advertiserId })
