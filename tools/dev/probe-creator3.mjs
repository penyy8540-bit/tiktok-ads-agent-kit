/**
 * 试探正确参数：identity_video_get（发布时间/达人）与 gmv_max_video_get
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []
let picked = null
for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
  const store = stores.find((row) => row.is_gmv_max_available === true)
  if (!store) continue
  const report = await core.callTool('gmv_max_report_get', {
    advertiser_id: advertiserId, store_ids: [String(store.store_id)], start_date: date, end_date: date,
    metrics: ['cost'], dimensions: ['campaign_id'], page_size: 20,
  }).catch(() => null)
  const hasSpend = (report?.data?.list || []).some((row) => Number(row.metrics?.cost) > 0)
  if (!hasSpend) continue
  picked = { advertiserId, storeId: String(store.store_id), storeName: store.store_name, accountName: account.advertiser_name }
  break
}
if (!picked) {
  console.log('没有有消耗的账户')
  process.exit(0)
}
console.log(`账户 ${picked.advertiserId} (${picked.accountName}) 店铺 ${picked.storeName}`)

// A. identity_get → 拿一个 AUTH_CODE 身份
const identities = (await core.callTool('identity_get', { advertiser_id: picked.advertiserId })).data?.identity_list || []
console.log(`\n达人身份数: ${identities.length}`)
const sample = identities.find((row) => row.identity_type === 'AUTH_CODE') || identities[0]
console.log('样例达人:', sample && { identity_id: sample.identity_id, identity_type: sample.identity_type, display_name: sample.display_name, tt_user_id: sample.tt_user_id, handle: sample.handle })

// B. identity_video_get 加 identity_type
if (sample) {
  for (const args of [
    { advertiser_id: picked.advertiserId, identity_id: String(sample.identity_id), identity_type: String(sample.identity_type), item_type: 'VIDEO' },
    { advertiser_id: picked.advertiserId, identity_id: String(sample.identity_id), identity_type: String(sample.identity_type) },
  ]) {
    try {
      const result = await core.callTool('identity_video_get', args)
      const list = result.data?.video_list || result.data?.list || []
      console.log(`\nidentity_video_get OK（${JSON.stringify(args).slice(0, 80)}）视频数=${list.length}`)
      for (const video of list.slice(0, 3)) {
        console.log(JSON.stringify(video).slice(0, 700))
      }
      break
    } catch (error) {
      console.log(`\nidentity_video_get 失败: ${String(error.message).slice(0, 160)}`)
    }
  }
}

// C. gmv_max_video_get 各种参数组合
const bcId = '7662335243316985874'
const attempts = [
  { advertiser_id: picked.advertiserId, store_id: picked.storeId, store_authorized_bc_id: bcId, start_date: date, end_date: date, page: 1, page_size: 10 },
  { advertiser_id: picked.advertiserId, store_id: picked.storeId, store_authorized_bc_id: bcId, page: 1, page_size: 10 },
  { advertiser_id: picked.advertiserId, store_ids: [picked.storeId], store_authorized_bc_id: bcId, start_date: date, end_date: date, page: 1, page_size: 10 },
]
for (const args of attempts) {
  try {
    const result = await core.callTool('gmv_max_video_get', args)
    const list = result.data?.item_list || []
    console.log(`\ngmv_max_video_get OK 参数=${Object.keys(args).join(',')} 条数=${list.length}`)
    if (list.length) console.log(JSON.stringify(list[0]).slice(0, 900))
    break
  } catch (error) {
    console.log(`\ngmv_max_video_get 失败(${Object.keys(args).join(',')}): ${String(error.message).slice(0, 160)}`)
  }
}
