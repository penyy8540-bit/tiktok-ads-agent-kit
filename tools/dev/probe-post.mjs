/**
 * Probe whether the Ads MCP can resolve a GMV Max item_id to something public
 * (video url / post id / author) — used to decide if "open post" links can work.
 *
 *   node tools/probe-post.mjs
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'

const settings = normalizeConfig({ proxy: 'auto' })
const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
let auth = readAuth(settings.dataDir)
if (!isTokenUsable(auth, settings.resourceUrl) && auth.refreshToken) {
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
  const tokens = await refreshAccessToken(metadata, { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl }, proxy)
  auth = updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || auth.refreshToken, expiresAt: tokens.expiresAt })
  console.log('token refreshed')
}
const session = new McpSession({ url: settings.resourceUrl, proxy, timeoutMs: 90_000, getToken: async () => auth.accessToken })
await session.connect()

const advertiserId = '7663409215079202836'
const campaignId = '1872854565522481'
const videoId = '7680253169372335393'

async function exec(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 200_000, timeoutMs: 120_000 })
  return JSON.parse(result.text)
}

async function attempt(label, name, params) {
  try {
    const data = await exec(name, params)
    const text = JSON.stringify(data).slice(0, 500)
    console.log(`✓ ${label}: ${text}`)
    return data
  } catch (error) {
    console.log(`✗ ${label}: ${String(error.message).slice(0, 300)}`)
    return null
  }
}

console.log('=== 原生工具里跟 video/creative 相关的 ===')
console.log(session.tools.map((tool) => tool.name).filter((name) => /video|creative|item|post/i.test(name)).join(', '))

console.log('\n=== gmv_max_video_get（store_id 单数）===')
const video = await attempt('+bc', 'gmv_max_video_get', { advertiser_id: advertiserId, store_id: '7494178074073728795', store_authorized_bc_id: '7662335243316985874' })
if (video) console.log('FULL:', JSON.stringify(video).slice(0, 2500))
await attempt('+campaign', 'gmv_max_video_get', { advertiser_id: advertiserId, store_id: '7494178074073728795', store_authorized_bc_id: '7662335243316985874', campaign_ids: [campaignId] })
await attempt('+item', 'gmv_max_video_get', { advertiser_id: advertiserId, store_id: '7494178074073728795', store_authorized_bc_id: '7662335243316985874', item_ids: [videoId] })

console.log('\n=== tt_video_info_get 各种参数 ===')
await attempt('video_ids', 'tt_video_info_get', { advertiser_id: advertiserId, video_ids: [videoId] })
await attempt('item_ids', 'tt_video_info_get', { advertiser_id: advertiserId, item_ids: [videoId] })
await attempt('bc_id', 'tt_video_info_get', { bc_id: '7662335243316985874', video_ids: [videoId] })

process.exit(0)
