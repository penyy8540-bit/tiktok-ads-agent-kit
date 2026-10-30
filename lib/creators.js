/**
 * 达人 / 素材归属：把 item_id 映射到发布它的达人昵称。
 *
 * 数据来源（TikTok Ads Open API）：
 *   identity_get(advertiser_id)            → 广告账户下的发布身份列表（达人）
 *   identity_video_get(advertiser_id, identity_id, identity_type, item_type) → 该达人的作品
 *
 * 注意：identity_video_get 返回里**没有发布时间**（只有授权起止 auth_info），
 * 所以这里只提供「达人昵称 + 是否授权 + 标题」。发布时间 TikTok 广告接口目前不暴露。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAP_FILE = 'creator-map.json'
const TTL_MS = 30 * 60_000

export function createCreators({ dataDir, callTool, listAccounts, log = () => {} }) {
  const file = path.join(dataDir, MAP_FILE)
  /** @type {{ at: number, items: Record<string, { author: string, identityId: string, authStart?: string, authEnd?: string, title?: string }> } | null} */
  let cache = null
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8')) || null
  } catch { /* first run */ }
  let building = null

  /** 增量构建：逐个账户 → 逐个达人 → 作品列表 */
  async function build(force = false) {
    if (!force && cache && Date.now() - cache.at < TTL_MS) return cache
    if (building) return building
    building = (async () => {
      const items = { ...((cache && cache.items) || {}) }
      const accounts = await listAccounts()
      let identities = 0
      let videos = 0
      for (const account of accounts) {
        let list = []
        try {
          list = (await callTool('identity_get', { advertiser_id: account.advertiserId })).data?.identity_list || []
        } catch (error) {
          log(`达人映射：${account.storeName} identity_get 失败 ${error.message}`)
          continue
        }
        identities += list.length
        for (const identity of list) {
          const identityId = String(identity.identity_id || '')
          const identityType = String(identity.identity_type || 'AUTH_CODE')
          const author = String(identity.display_name || '')
          if (!identityId || !author) continue
          try {
            const result = await callTool('identity_video_get', {
              advertiser_id: account.advertiserId,
              identity_id: identityId,
              identity_type: identityType,
              item_type: 'VIDEO',
            })
            const videoList = result.data?.video_list || []
            videos += videoList.length
            for (const video of videoList) {
              const itemId = String(video.item_id || '')
              if (!itemId) continue
              items[itemId] = {
                author,
                identityId,
                identityType,
                authStart: video.auth_info?.auth_start_time || '',
                authEnd: video.auth_info?.auth_end_time || '',
                title: String(video.title || video.text || '').slice(0, 80),
              }
            }
          } catch (error) {
            log(`达人映射：${author} 作品失败 ${error.message}`)
          }
        }
      }
      cache = { at: Date.now(), items }
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, JSON.stringify(cache))
      } catch { /* best effort */ }
      log(`达人映射完成：${identities} 个达人、${videos} 条作品、${Object.keys(items).length} 条映射`)
      return cache
    })().finally(() => {
      building = null
    })
    return building
  }

  return {
    /** 立即返回当前缓存（不阻塞），同时后台刷新 */
    lookup(itemId) {
      const entry = cache && cache.items ? cache.items[String(itemId)] : null
      return entry ? { author: entry.author, title: entry.title, authEnd: entry.authEnd } : null
    },
    build,
    status() {
      return {
        ready: Boolean(cache),
        count: cache ? Object.keys(cache.items).length : 0,
        builtAt: cache ? new Date(cache.at).toISOString() : null,
        building: Boolean(building),
      }
    },
    /** 给一批素材补达人名（不阻塞：缺映射时先返回，同时触发后台构建） */
    enrich(rows) {
      if (!cache) {
        build().catch(() => {})
      }
      return rows.map((row) => {
        const hit = cache && cache.items ? cache.items[String(row.itemId)] : null
        return hit ? { ...row, author: hit.author, authorTitle: hit.title } : row
      })
    },
  }
}
