import test from 'node:test'
import assert from 'node:assert/strict'
import { scanStore, previousWindow, normalizeRules } from '../lib/monitor.js'

const rules = normalizeRules({
  windowDays: 1,
  spendThreshold: 30,
  roiTarget: 10,
  roiRatio: 0.7,
  spendSpikeRatio: 2,
  minCostForSpike: 20,
  maxCreatives: 10,
})

const current = '2026-10-29'
const previous = previousWindow(current, current)
const previousStart = previous.start

/** 假 callTool：按窗口 + 维度返回固定数据 */
function fakeCallTool({ currentRows, previousRows }) {
  const calls = []
  return {
    calls,
    async callTool(name, params) {
      calls.push({ name, params })
      assert.equal(name, 'gmv_max_report_get')
      const dims = params.dimensions || []
      if (dims.includes('item_group_id') || dims.includes('item_id')) {
        return { data: { list: [], page_info: { page: 1, page_size: 1000, total_number: 0, total_page: 0 } } }
      }
      const rows = params.start_date === previousStart ? previousRows : currentRows
      return { data: { list: rows, page_info: { page: 1, page_size: 200, total_number: rows.length, total_page: 1 } } }
    },
  }
}

test('previousWindow shifts back by the same number of days', () => {
  assert.deepEqual(previousWindow('2026-10-29', '2026-10-29'), { start: '2026-10-28', end: '2026-10-28', days: 1 })
  assert.deepEqual(previousWindow('2026-10-27', '2026-10-29'), { start: '2026-10-24', end: '2026-10-26', days: 3 })
})

test('scanStore raises spendSpike when spend jumps and orders do not grow', async () => {
  const core = fakeCallTool({
    currentRows: [
      { dimensions: { campaign_id: 'A' }, metrics: { campaign_name: 'spike', cost: '100', orders: '1', gross_revenue: '100' } },
      { dimensions: { campaign_id: 'B' }, metrics: { campaign_name: 'scaling', cost: '100', orders: '5', gross_revenue: '900' } },
      { dimensions: { campaign_id: 'C' }, metrics: { campaign_name: 'flat', cost: '50', orders: '2', gross_revenue: '500' } },
    ],
    previousRows: [
      { dimensions: { campaign_id: 'A' }, metrics: { campaign_name: 'spike', cost: '20', orders: '1' } },
      { dimensions: { campaign_id: 'B' }, metrics: { campaign_name: 'scaling', cost: '20', orders: '1' } },
      { dimensions: { campaign_id: 'C' }, metrics: { campaign_name: 'flat', cost: '40', orders: '2' } },
    ],
  })
  const findings = await scanStore({
    callTool: core.callTool.bind(core),
    advertiserId: 'adv-1',
    advertiserName: 'Store A',
    storeId: 'store-1',
    storeName: 'SUPERLEX UK',
    startDate: current,
    endDate: current,
    rules,
  })
  const spikes = findings.filter((finding) => finding.rule === 'spendSpike')
  assert.equal(spikes.length, 1)
  assert.equal(spikes[0].campaignId, 'A')
  assert.equal(spikes[0].key, 'spendSpike|adv-1|store-1|campaign|A')
  assert.match(spikes[0].message, /100/)
})

test('scanStore does not raise spendSpike when orders grew or the ratio is below the threshold', async () => {
  const core = fakeCallTool({
    currentRows: [
      { dimensions: { campaign_id: 'B' }, metrics: { campaign_name: 'scaling', cost: '100', orders: '5', gross_revenue: '900' } },
      { dimensions: { campaign_id: 'D' }, metrics: { campaign_name: 'mild', cost: '30', orders: '0', gross_revenue: '0' } },
    ],
    previousRows: [
      { dimensions: { campaign_id: 'B' }, metrics: { campaign_name: 'scaling', cost: '20', orders: '1' } },
      { dimensions: { campaign_id: 'D' }, metrics: { campaign_name: 'mild', cost: '20', orders: '0' } },
    ],
  })
  const findings = await scanStore({
    callTool: core.callTool.bind(core),
    advertiserId: 'adv-1',
    advertiserName: 'Store A',
    storeId: 'store-1',
    storeName: 'SUPERLEX UK',
    startDate: current,
    endDate: current,
    rules,
  })
  assert.equal(findings.filter((finding) => finding.rule === 'spendSpike').length, 0)
})

test('alert keys include advertiser and store so different accounts never dedupe each other', async () => {
  const core = fakeCallTool({
    currentRows: [{ dimensions: { campaign_id: 'X' }, metrics: { campaign_name: 'zero', cost: '100', orders: '0', gross_revenue: '0' } }],
    previousRows: [],
  })
  const findings = await scanStore({
    callTool: core.callTool.bind(core),
    advertiserId: 'adv-9',
    advertiserName: 'Store B',
    storeId: 'store-9',
    storeName: 'Youtop',
    startDate: current,
    endDate: current,
    rules,
  })
  const zero = findings.find((finding) => finding.rule === 'zeroOrder')
  assert.ok(zero, 'zeroOrder finding expected')
  assert.equal(zero.key, 'zeroOrder|adv-9|store-9|campaign|X')
})
