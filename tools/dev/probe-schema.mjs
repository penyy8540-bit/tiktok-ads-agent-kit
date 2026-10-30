/**
 * 用 tool_get 查看工具 schema，并验证 identity_video_get / gmv_max_video_get 的正确参数
 */
import { createAdsCore } from '../../lib/core.js'

const core = createAdsCore({ log: (m) => console.error(`[probe] ${m}`) })

for (const name of ['gmv_max_video_get', 'identity_video_get', 'identity_get']) {
  try {
    const result = await core.callTool('tool_get', { tool_name: name })
    const text = JSON.stringify(result)
    console.log(`\n===== ${name} =====`)
    console.log(text.slice(0, 2600))
  } catch (error) {
    console.log(`\n===== ${name} 失败: ${String(error.message).slice(0, 200)}`)
  }
}
