/**
 * TikTok Shop（Seller Center / Partner Center Open API）客户端。
 *
 * 和广告 API 完全是两套体系：
 *   - 授权：Partner Center 应用（app_key / app_secret）→ 商家授权拿 auth_code → 换 access_token
 *   - 调用：https://open-api.tiktokglobalshop.com + HMAC-SHA256 签名（x-sign / x-ts / x-app-key / x-shop-cipher）
 *
 * 用途：商品（含上架/更新时间）、订单、店铺信息等 Seller Center 数据。
 * 注意：短视频发布时间在 Shop Open API 里同样不一定有，先用通用 call 探测。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpRequest, parseProxy } from './transport.js'
import { resolveProxy } from './config.js'

// 不同区域的应用可能给出不同域名，可用环境变量覆盖
const AUTH_BASE = process.env.TIKTOK_SHOP_AUTH_BASE || 'https://auth.tiktok-shops.com'
const API_BASE = process.env.TIKTOK_SHOP_API_BASE || 'https://open-api.tiktokglobalshop.com'
const TOKEN_FILE = 'shop-auth.json'

const pad = (value) => String(value).padStart(2, '0')
const nowSeconds = () => Math.floor(Date.now() / 1000)

/** 环境变量 / 配置读取 */
export function shopConfig(raw = {}) {
  return {
    appKey: process.env.TIKTOK_SHOP_APP_KEY || raw.appKey || '',
    appSecret: process.env.TIKTOK_SHOP_APP_SECRET || raw.appSecret || '',
    redirectUri: process.env.TIKTOK_SHOP_REDIRECT_URI || raw.redirectUri || '',
    proxySetting: process.env.TIKTOK_SHOP_PROXY || raw.proxy || 'auto',
    dataDir: process.env.TIKTOK_SHOP_DATA_DIR || raw.dataDir || process.env.TIKTOK_ADS_DATA_DIR || '',
  }
}

/** TikTok Shop 签名：HMAC-SHA256(secret, secret + path + 排序参数拼接 + body + secret) */
export function signRequest({ path: apiPath, params = {}, body = '', appSecret }) {
  const keys = Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'access_token' && params[key] !== undefined && params[key] !== null)
    .sort()
  const joined = keys.map((key) => `${key}${params[key]}`).join('')
  const stringToSign = `${appSecret}${apiPath}${joined}${body}${appSecret}`
  return crypto.createHmac('sha256', appSecret).update(stringToSign).digest('hex')
}

export function createShopClient({ config = shopConfig(), log = () => {} } = {}) {
  const dataDir = config.dataDir || ''
  const tokenFile = dataDir ? path.join(dataDir, TOKEN_FILE) : ''

  let auth = null
  if (tokenFile) {
    try {
      auth = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    } catch { /* 未授权 */ }
  }
  const saveAuth = (next) => {
    auth = next
    if (!tokenFile) return
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tokenFile, JSON.stringify(next, null, 2), { mode: 0o600 })
    } catch (error) {
      log(`shop: 保存令牌失败 ${error.message}`)
    }
  }

  const proxy = () => {
    const resolved = resolveProxy(config.proxySetting)
    return parseProxy(resolved.proxy)
  }

  const requireCreds = () => {
    if (!config.appKey || !config.appSecret) {
      throw new Error('缺少 TikTok Shop 应用凭证：请设置环境变量 TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET（Partner Center → 应用详情）')
    }
  }

  /** 生成授权链接（商家在浏览器里同意后，回调地址会带 auth_code） */
  function authorizeUrl(state = crypto.randomBytes(8).toString('hex')) {
    requireCreds()
    const params = new URLSearchParams({ app_key: config.appKey, state })
    if (config.redirectUri) params.set('redirect_uri', config.redirectUri)
    return { url: `${AUTH_BASE}/oauth/authorize?${params.toString()}`, state }
  }

  /** 用 auth_code 换 token（商家授权后的 code，10 分钟内有效） */
  async function exchangeAuthCode(authCode) {
    requireCreds()
    const url = `${AUTH_BASE}/api/v2/token/get?app_key=${encodeURIComponent(config.appKey)}&app_secret=${encodeURIComponent(config.appSecret)}&auth_code=${encodeURIComponent(authCode)}&grant_type=authorized_code`
    const response = await httpRequest(url, { method: 'GET', proxy: proxy(), timeoutMs: 30_000 })
    const data = JSON.parse(response.text)
    if (data.code !== 0) throw new Error(`Shop 授权失败 code=${data.code}: ${data.message || ''}`)
    const record = {
      accessToken: data.data.access_token,
      accessTokenExpireAt: data.data.access_token_expire_in ? (Date.now() + data.data.access_token_expire_in * 1000) : null,
      refreshToken: data.data.refresh_token,
      refreshTokenExpireAt: data.data.refresh_token_expire_in ? (Date.now() + data.data.refresh_token_expire_in * 1000) : null,
      shopCipher: data.data.shop_cipher || '',
      sellerName: data.data.seller_name || '',
      shopId: data.data.shop_id || '',
      openId: data.data.open_id || '',
      authorizedAt: new Date().toISOString(),
    }
    saveAuth(record)
    return record
  }

  async function refreshToken() {
    requireCreds()
    if (!auth || !auth.refreshToken) throw new Error('尚未授权：请先完成 TikTok Shop 商家授权')
    const url = `${AUTH_BASE}/api/v2/token/refresh?app_key=${encodeURIComponent(config.appKey)}&app_secret=${encodeURIComponent(config.appSecret)}&refresh_token=${encodeURIComponent(auth.refreshToken)}&grant_type=refresh_token`
    const response = await httpRequest(url, { method: 'GET', proxy: proxy(), timeoutMs: 30_000 })
    const data = JSON.parse(response.text)
    if (data.code !== 0) throw new Error(`Shop 刷新令牌失败 code=${data.code}: ${data.message || ''}`)
    const next = {
      ...auth,
      accessToken: data.data.access_token,
      accessTokenExpireAt: data.data.access_token_expire_in ? (Date.now() + data.data.access_token_expire_in * 1000) : null,
      refreshToken: data.data.refresh_token || auth.refreshToken,
    }
    saveAuth(next)
    return next
  }

  async function accessToken() {
    if (!auth || !auth.accessToken) throw new Error('尚未授权：请先完成 TikTok Shop 商家授权（ads-cli shop login）')
    if (auth.accessTokenExpireAt && Date.now() > auth.accessTokenExpireAt - 60_000) {
      const next = await refreshToken()
      return next.accessToken
    }
    return auth.accessToken
  }

  /** 通用签名请求：自动补 app_key / timestamp / sign，带 access-token 与 shop-cipher */
  async function request(apiPath, { method = 'GET', query = {}, body = null, shopScoped = true } = {}) {
    requireCreds()
    const token = await accessToken()
    const params = { app_key: config.appKey, timestamp: nowSeconds(), ...query }
    if (shopScoped && auth.shopCipher) params.shop_cipher = auth.shopCipher
    const bodyText = body ? JSON.stringify(body) : ''
    const sign = signRequest({ path: apiPath, params, body: bodyText, appSecret: config.appSecret })
    const search = new URLSearchParams({ ...params, sign })
    const url = `${API_BASE}${apiPath}?${search.toString()}`
    const headers = {
      'x-tts-access-token': token,
      'x-app-key': config.appKey,
      'x-ts': String(params.timestamp),
      'x-sign': sign,
      'content-type': 'application/json',
    }
    if (shopScoped && auth.shopCipher) headers['x-shop-cipher'] = auth.shopCipher
    const response = await httpRequest(url, { method, headers, body: bodyText || undefined, proxy: proxy(), timeoutMs: 60_000 })
    const data = JSON.parse(response.text)
    if (data.code !== 0) {
      const message = data.message || JSON.stringify(data).slice(0, 200)
      throw new Error(`Shop API ${method} ${apiPath} code=${data.code}: ${message}`)
    }
    return data
  }

  return {
    config,
    authorizeUrl,
    exchangeAuthCode,
    refreshToken,
    request,
    status() {
      return {
        configured: Boolean(config.appKey && config.appSecret),
        authorized: Boolean(auth && auth.accessToken),
        sellerName: auth?.sellerName || '',
        shopId: auth?.shopId || '',
        shopCipher: auth?.shopCipher ? '已保存' : '',
        accessTokenExpireAt: auth?.accessTokenExpireAt ? new Date(auth.accessTokenExpireAt).toISOString() : null,
        redirectUri: config.redirectUri || '(未配置)',
      }
    },
    /** 常用接口封装 */
    async authorizedShops() {
      return request('/authorization/202309/shops')
    },
    async searchProducts({ pageSize = 20, pageToken = '' } = {}) {
      return request('/product/202309/products/search', {
        method: 'POST',
        query: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) },
        body: {},
      })
    },
    async searchOrders({ createTimeFrom, createTimeTo, pageSize = 20, pageToken = '' } = {}) {
      return request('/order/202309/orders/search', {
        method: 'POST',
        query: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) },
        body: {
          ...(createTimeFrom ? { create_time_ge: createTimeFrom } : {}),
          ...(createTimeTo ? { create_time_lt: createTimeTo } : {}),
        },
      })
    },
  }
}

export { pad }
