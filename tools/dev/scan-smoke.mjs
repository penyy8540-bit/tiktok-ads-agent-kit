/**
 * 用真实 API 跑一次 scanStore，验证 spendSpike 路径不报错
 */
import { createAdsCore } from '../../lib/core.js'
import { scanStore, normalizeRules } from '../../lib/monitor.js'

const core = createAdsCore({ log: (m) => console.error(`[scan] ${m}`) })
const rules = normalizeRules({ windowDays: 3, spendThreshold: 30, roiTarget: 10, roiRatio: 0.7, spendSpikeRatio: 1.05, minCostForSpike: 1 })

const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
const pad = (n) => String(n).padStart(2, '0')
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const end = new Date(Date.now() - 86_400_000)
const start = new Date(end.getTime() - 2 * 86_400_000)

let total = 0
for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  let stores = []
  try {
    stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
  } catch { continue }
  const store = stores.find((row) => row.is_gmv_max_available === true)
  if (!store) continue
  try {
    const findings = await scanStore({
      callTool: (name, params) => core.callTool(name, params),
      advertiserId,
      advertiserName: String(account.advertiser_name || advertiserId),
      storeId: String(store.store_id),
      storeName: String(store.store_name || store.store_id),
      startDate: iso(start),
      endDate: iso(end),
      rules,
    })
    const byRule = findings.reduce((acc, finding) => {
      acc[finding.rule] = (acc[finding.rule] || 0) + 1
      return acc
    }, {})
    total += findings.length
    console.log(`${account.advertiser_name || advertiserId}: ${findings.length} 条 ${JSON.stringify(byRule)}`)
    for (const finding of findings.filter((item) => item.rule === 'spendSpike').slice(0, 2)) {
      console.log('  spike:', finding.message)
    }
  } catch (error) {
    console.log(`${account.advertiser_name || advertiserId}: 失败 ${error.message}`)
  }
}
console.log(`合计 ${total} 条`)
