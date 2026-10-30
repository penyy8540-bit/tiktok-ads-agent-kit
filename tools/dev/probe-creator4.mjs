/**
 * 打印 identity_video_get 返回对象的完整字段，确认是否存在发布时间与 item_id
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })
const accounts = (await core.callTool('auth_advertiser_get', {})).data?.list || []

for (const account of accounts) {
  const advertiserId = String(account.advertiser_id)
  let identities = []
  try {
    identities = (await core.callTool('identity_get', { advertiser_id: advertiserId })).data?.identity_list || []
  } catch { continue }
  if (!identities.length) continue
  console.log(`\n账户 ${advertiserId} (${account.advertiser_name}) 达人 ${identities.length} 个`)
  const sample = identities[0]
  try {
    const result = await core.callTool('identity_video_get', {
      advertiser_id: advertiserId,
      identity_id: String(sample.identity_id),
      identity_type: String(sample.identity_type),
      item_type: 'VIDEO',
    })
    const list = result.data?.video_list || []
    console.log(`达人 ${sample.display_name} 视频数 ${list.length}`)
    if (list.length) {
      const video = list[0]
      console.log('字段:', Object.keys(video).join(', '))
      console.log('item_id:', video.item_id || video.id || video.video_id)
      console.log('create_time:', video.create_time || video.createTime || video.post_time || '(无)')
      console.log('完整对象(截断):', JSON.stringify(video).slice(0, 1200))
    }
  } catch (error) {
    console.log('失败:', String(error.message).slice(0, 160))
  }
  break
}
