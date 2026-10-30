/**
 * 探测素材元信息：identity_get → identity_video_get（发布时间/达人）
 * 以及 gmv_max_video_get（需要 store_authorized_bc_id）
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
  picked = { advertiserId, storeId: String(store.store_id), storeName: store.store_name, accountName: account.advertiser_name }
  break
}
if (!picked) process.exit(0)
console.log(`账户 ${picked.advertiserId} (${picked.accountName}) 店铺 ${picked.storeId} ${picked.storeName}`)

// 1) identity_get：拿发布身份（达人）
try {
  const identities = await core.callTool('identity_get', { advertiser_id: picked.advertiserId })
  const list = identities.data?.identity_list || identities.data?.list || []
  console.log('\n=== identity_get ===')
  console.log('数量:', list.length)
  for (const row of list.slice(0, 8)) {
    console.log(JSON.stringify({
      identity_id: row.identity_id || row.id,
      identity_type: row.identity_type,
      display_name: row.display_name,
      profile_image: row.profile_image,
      handle: row.handle || row.username,
    }))
  }
  const ttUser = list.find((row) => String(row.identity_type || '').includes('TT_USER')) || list[0]
  if (ttUser) {
    const identityId = String(ttUser.identity_id || ttUser.id)
    console.log(`\n=== identity_video_get (identity ${identityId}) ===`)
    try {
      const videos = await core.callTool('identity_video_get', { advertiser_id: picked.advertiserId, identity_id: identityId, item_type: 'VIDEO' })
      const videoList = videos.data?.video_list || videos.data?.list || []
      console.log('视频数:', videoList.length)
      for (const video of videoList.slice(0, 5)) {
        console.log(JSON.stringify({
          item_id: video.item_id || video.id,
          create_time: video.create_time,
          title: String(video.title || '').slice(0, 40),
          liked: video.liked_count,
          views: video.view_count,
        }))
      }
    } catch (error) {
      console.log('identity_video_get 失败:', String(error.message).slice(0, 200))
    }
  }
} catch (error) {
  console.log('identity_get 失败:', String(error.message).slice(0, 200))
}

// 2) gmv_max_video_get 带 BC ID
const bcIds = ['7662335243316985874']
for (const bcId of bcIds) {
  try {
    const result = await core.callTool('gmv_max_video_get', {
      advertiser_id: picked.advertiserId,
      store_id: picked.storeId,
      store_authorized_bc_id: bcId,
      item_ids: ['7701632348294548758'],
      start_date: date,
      end_date: date,
    })
    console.log('\n=== gmv_max_video_get OK ===')
    console.log(JSON.stringify(result).slice(0, 1500))
  } catch (error) {
    console.log('\ngmv_max_video_get 失败:', String(error.message).slice(0, 200))
  }
}
