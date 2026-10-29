/**
 * Probe how to turn GMV Max item_id (post) into a human-readable link/title.
 * 1) identity_get -> identities
 * 2) identity_video_info_get(item_ids) -> titles
 * 3) gmv_max_video_get(shop) -> post list
 *   node tools/probe-video.mjs [--date 2026-10-27]
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
  const data = JSON.parse(result.text)
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(`${name} code=${data.code} ${data.message || ''}`)
  return data
}

// item-level spend rows for the date
const campaigns = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['campaign_id'], page_size: 200,
})
const campaignIds = (campaigns.data?.list || []).filter((r) => Number(r.metrics?.cost) > 0).map((r) => String(r.dimensions.campaign_id))
const spu = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost'], dimensions: ['item_group_id'], filtering: { campaign_ids: campaignIds }, page_size: 500,
})
const spuIds = [...new Set((spu.data?.list || []).map((r) => String(r.dimensions.item_group_id)).filter(Boolean))]
const items = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId, store_ids: [storeId], start_date: date, end_date: date,
  metrics: ['cost', 'orders', 'gross_revenue', 'product_impressions', 'product_clicks'],
  dimensions: ['item_id'], filtering: { campaign_ids: campaignIds, item_group_ids: spuIds }, page_size: 1000,
})
const activeItems = (items.data?.list || []).filter((r) => Number(r.metrics?.cost) > 0)
console.log(`campaigns=${campaignIds.length} spus=${spuIds.length} items=${(items.data?.list || []).length} activeItems=${activeItems.length}`)
console.log('sample active item rows:')
for (const row of activeItems.slice(0, 8)) console.log(`  item=${row.dimensions.item_id} cost=${row.metrics.cost} orders=${row.metrics.orders} gmv=${row.metrics.gross_revenue}`)
const itemIds = activeItems.map((r) => String(r.dimensions.item_id))

console.log('\n=== identity_get ===')
let identities = []
try {
  const data = await exec('identity_get', { advertiser_id: advertiserId })
  identities = data.data?.identities || data.data?.list || []
  console.log(`  count=${identities.length}`)
  for (const identity of identities.slice(0, 6)) console.log(`  ${JSON.stringify(identity).slice(0, 300)}`)
} catch (error) {
  console.log(`  FAILED: ${error.message}`)
}

console.log('\n=== identity_video_info_get (sample item ids) ===')
for (const identity of identities.slice(0, 4)) {
  const identityId = identity.identity_id || identity.id
  const identityType = identity.identity_type || identity.type
  if (!identityId || !identityType) continue
  try {
    const params = { advertiser_id: advertiserId, identity_type: identityType, identity_id: String(identityId), item_ids: itemIds.slice(0, 10) }
    if (identityType === 'BC_AUTH_TT') params.identity_authorized_bc_id = bcId
    const data = await exec('identity_video_info_get', params)
    const list = data.data?.list || data.data?.videos || []
    console.log(`  identity=${identityId} type=${identityType} -> rows=${list.length}`)
    for (const row of list.slice(0, 3)) console.log(`    ${JSON.stringify(row).slice(0, 400)}`)
  } catch (error) {
    console.log(`  identity=${identityId} type=${identityType} FAILED: ${error.message.slice(0, 160)}`)
  }
}

console.log('\n=== gmv_max_video_get (shop posts) ===')
try {
  const data = await exec('gmv_max_video_get', {
    advertiser_id: advertiserId,
    store_id: storeId,
    store_authorized_bc_id: bcId,
    page_size: 5,
    sort_field: 'GMV',
    sort_type: 'DESC',
  })
  const list = data.data?.videos || data.data?.list || []
  console.log(`  rows=${list.length}`)
  for (const row of list.slice(0, 3)) console.log(`  ${JSON.stringify(row).slice(0, 500)}`)
} catch (error) {
  console.log(`  FAILED: ${error.message.slice(0, 200)}`)
}
