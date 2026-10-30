import test from 'node:test'
import assert from 'node:assert/strict'
import { getCampaignReport, getCreativeReport, clearReportCache, REPORT_CACHE_TTL_MS } from '../lib/queries.js'

const range = { start: '2026-10-29', end: '2026-10-29' }

/** 假 core：记录调用次数，返回固定的一账户一广告组数据 */
function countingCore() {
  const calls = []
  return {
    calls,
    async callTool(name, params) {
      calls.push({ name, params })
      if (name === 'auth_advertiser_get') {
        return { data: { list: [{ advertiser_id: 'adv-1', advertiser_name: 'SUPERLEX UK' }] } }
      }
      if (name === 'gmv_max_store_list_get') {
        return { data: { store_list: [{ store_id: 'store-1', store_name: 'SUPERLEX UK', is_gmv_max_available: true }] } }
      }
      if (name === 'gmv_max_report_get') {
        const dims = params.dimensions || []
        if (dims.includes('item_group_id')) {
          return { data: { list: [{ dimensions: { item_group_id: 'spu-1' }, metrics: { cost: '10', orders: '1' } }] } }
        }
        return {
          data: {
            page_info: { page: 1, page_size: 1000, total_number: 1, total_page: 1 },
            list: [{ dimensions: { campaign_id: 'c-1', item_id: 'i-1' }, metrics: { campaign_name: '热卖', cost: '10', orders: '1', gross_revenue: '100', product_clicks: '5' } }],
          },
        }
      }
      return { data: {} }
    },
  }
}

test('report cache returns the same object without extra API calls', async () => {
  clearReportCache()
  const core = countingCore()
  const first = await getCampaignReport(core, range)
  const callsAfterFirst = core.calls.length
  assert.ok(callsAfterFirst > 0)
  const second = await getCampaignReport(core, range)
  assert.equal(core.calls.length, callsAfterFirst, 'second call must be served from cache')
  assert.deepEqual(second, first)
})

test('noCache bypasses the cache and refetches', async () => {
  clearReportCache()
  const core = countingCore()
  await getCampaignReport(core, range)
  const callsAfterFirst = core.calls.length
  await getCampaignReport(core, range, { noCache: true })
  assert.ok(core.calls.length > callsAfterFirst, 'noCache must hit the API again')
})

test('a different date range is a different cache entry', async () => {
  clearReportCache()
  const core = countingCore()
  await getCampaignReport(core, range)
  const callsAfterFirst = core.calls.length
  await getCampaignReport(core, { start: '2026-10-28', end: '2026-10-28' })
  assert.ok(core.calls.length > callsAfterFirst, 'different range must not reuse the entry')
})

test('clearReportCache forces a refetch and TTL is exported', async () => {
  clearReportCache()
  const core = countingCore()
  await getCampaignReport(core, range)
  const callsAfterFirst = core.calls.length
  clearReportCache()
  await getCampaignReport(core, range)
  assert.ok(core.calls.length > callsAfterFirst)
  assert.equal(typeof REPORT_CACHE_TTL_MS, 'number')
  assert.ok(REPORT_CACHE_TTL_MS > 0)
})

test('creative report is cached separately from campaign report', async () => {
  clearReportCache()
  const core = countingCore()
  await getCampaignReport(core, range)
  const callsAfterCampaign = core.calls.length
  await getCreativeReport(core, range)
  assert.ok(core.calls.length > callsAfterCampaign, 'creative report must not reuse the campaign entry')
  const callsAfterCreative = core.calls.length
  await getCreativeReport(core, range)
  assert.equal(core.calls.length, callsAfterCreative, 'second creative call must be cached')
})
