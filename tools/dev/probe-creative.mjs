/**
 * Probe creative/product level reporting for GMV Max: which dimensions return
 * which identifiers (post/item ids, SPU ids, titles, product names, SKUs).
 *
 *   node tools/probe-creative.mjs [--date 2026-10-27] [--proxy ...] [--advertiser id] [--store id]
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
console.log(`date=${date} server=${session.serverInfo?.name}`)

async function exec(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 120_000 })
  const data = JSON.parse(result.text)
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(`${name} code=${data.code} ${data.message || ''}`)
  return data
}

const advertiserId = argValue('--advertiser', '7663409215079202836')
const storeId = argValue('--store', '7494178074073728795')

console.log('\n=== 1) campaign level (find active campaigns) ===')
const campaigns = await exec('gmv_max_report_get', {
  advertiser_id: advertiserId,
  store_ids: [storeId],
  start_date: date,
  end_date: date,
  metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue'],
  dimensions: ['campaign_id'],
  page_size: 200,
})
const active = (campaigns.data?.list || []).filter((row) => Number(row.metrics?.cost) > 0)
for (const row of active) console.log(`  ${row.dimensions.campaign_id}  ${row.metrics.campaign_name}  cost=${row.metrics.cost} orders=${row.metrics.orders}`)
const campaignIds = active.map((row) => String(row.dimensions.campaign_id))
if (campaignIds.length === 0) {
  console.log('no active campaigns for this date')
  process.exit(0)
}

console.log('\n=== 2) item_group_id (SPU) with filtering.campaign_ids ===')
try {
  const spu = await exec('gmv_max_report_get', {
    advertiser_id: advertiserId,
    store_ids: [storeId],
    start_date: date,
    end_date: date,
    metrics: ['campaign_name', 'product_name', 'item_group_id', 'cost', 'orders', 'gross_revenue', 'roi'],
    dimensions: ['campaign_id', 'item_group_id'],
    filtering: { campaign_ids: campaignIds },
    page_size: 500,
  })
  const rows = spu.data?.list || []
  console.log(`  rows=${rows.length}`)
  for (const row of rows.slice(0, 12)) {
    console.log(`  camp=${row.dimensions.campaign_id} spu=${row.dimensions.item_group_id} product=${row.metrics?.product_name} cost=${row.metrics?.cost} orders=${row.metrics?.orders} gmv=${row.metrics?.gross_revenue}`)
  }
} catch (error) {
  console.log(`  FAILED: ${error.message}`)
}

console.log('\n=== 3) item_id (post) with filtering.campaign_ids + item_group_ids ===')
try {
  // First enumerate SPUs per campaign so we can satisfy the anchoring rule.
  const spu = await exec('gmv_max_report_get', {
    advertiser_id: advertiserId,
    store_ids: [storeId],
    start_date: date,
    end_date: date,
    metrics: ['campaign_name', 'product_name', 'item_group_id', 'cost', 'orders'],
    dimensions: ['campaign_id', 'item_group_id'],
    filtering: { campaign_ids: campaignIds },
    page_size: 500,
  })
  const pairs = new Map()
  for (const row of spu.data?.list || []) {
    const campaign = String(row.dimensions?.campaign_id)
    const spuId = String(row.dimensions?.item_group_id)
    if (!campaign || !spuId) continue
    if (!pairs.has(campaign)) pairs.set(campaign, new Set())
    pairs.get(campaign).add(spuId)
  }
  let printed = 0
  let total = 0
  for (const [campaign, spuSet] of pairs) {
    try {
      const items = await exec('gmv_max_report_get', {
        advertiser_id: advertiserId,
        store_ids: [storeId],
        start_date: date,
        end_date: date,
        metrics: ['campaign_name', 'item_id', 'title', 'item_group_id', 'product_name', 'tt_account_name', 'identity_id', 'shop_content_type', 'creative_delivery_status', 'cost', 'orders', 'gross_revenue', 'roi', 'product_impressions', 'product_clicks'],
        dimensions: ['item_id'],
        filtering: { campaign_ids: [campaign], item_group_ids: [...spuSet] },
        page_size: 500,
      })
      const rows = items.data?.list || []
      total += rows.length
      for (const row of rows) {
        if (printed < 15) {
          console.log(`  camp=${campaign} item=${row.dimensions?.item_id} title=${String(row.metrics?.title || '').slice(0, 40)} spu=${row.metrics?.item_group_id ?? row.dimensions?.item_group_id} product=${String(row.metrics?.product_name || '').slice(0, 30)} acct=${row.metrics?.tt_account_name} cost=${row.metrics?.cost} orders=${row.metrics?.orders} gmv=${row.metrics?.gross_revenue}`)
          printed++
        }
      }
    } catch (error) {
      console.log(`  camp=${campaign} FAILED: ${error.message}`)
    }
  }
  console.log(`  total item rows=${total}`)
} catch (error) {
  console.log(`  FAILED: ${error.message}`)
}

console.log('\n=== 4) catalog product/SKU shape (first catalog under BC) ===')
try {
  const bcId = '7662335243316985874'
  const catalogs = await exec('catalog_get', { bc_id: bcId })
  const list = catalogs.data?.list || catalogs.data?.catalogs || []
  console.log(`  catalogs=${list.length}`)
  const catalogId = list[0]?.catalog_id
  if (catalogId) {
    const products = await exec('catalog_product_get', { bc_id: bcId, catalog_id: catalogId, page_size: 3 })
    console.log(`  sample products: ${JSON.stringify(products.data?.products?.[0] || products.data?.list?.[0] || products.data).slice(0, 900)}`)
  }
} catch (error) {
  console.log(`  FAILED: ${error.message}`)
}
