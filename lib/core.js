/**
 * Framework-agnostic core for TikTok Ads.
 *
 * 这一层不依赖 DeepSeek Harness，也不依赖面板：
 *  - OAuth 授权（自动注册客户端 + PKCE + 本地回调）
 *  - MCP 会话管理（layer 约 40 工具 / flat 约 400 工具）
 *  - 统一 callTool()（走 tool_execute），返回值已解析
 *
 * 三个入口共用它：
 *  - lib/index.js     DSH 插件（注册 6 个原生工具）
 *  - tools/ads-cli.mjs  命令行（任何能执行命令的 AI 都能用）
 *  - tools/mcp-server.mjs  stdio MCP server（任何支持 MCP 的 AI 客户端都能接）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MODES, normalizeConfig, redactProxy, resolveProxy } from './config.js'
import net from 'node:net'
import { parseProxy } from './transport.js'
import { McpSession } from './mcp.js'
import {
  buildAuthorizeUrl,
  discoverMetadata,
  exchangeCode,
  openExternal,
  pkcePair,
  randomState,
  refreshAccessToken,
  registerClient,
  startCallbackServer,
} from './oauth.js'
import { clearAuth, isTokenUsable, readAuth, updateAuth, writeAuth } from './store.js'
import { revokeToken } from './oauth.js'
import { readCache, searchTools, writeCache } from './registry.js'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

export { MODES }

/**
 * 环境变量覆盖（方便任何 AI / 容器部署）：
 *   TIKTOK_ADS_DATA_DIR   数据目录（默认 ~/.dsh/plugin-data/tiktok-ads）
 *   TIKTOK_ADS_MODE       layer | flat
 *   TIKTOK_ADS_PROXY      auto | off | http://127.0.0.1:7890
 *   TIKTOK_ADS_RESOURCE   自定义 MCP 端点
 */
export function configFromEnv(overrides = {}) {
  const raw = {
    mode: process.env.TIKTOK_ADS_MODE || 'layer',
    proxy: process.env.TIKTOK_ADS_PROXY || 'auto',
    ...(process.env.TIKTOK_ADS_DATA_DIR ? { dataDir: process.env.TIKTOK_ADS_DATA_DIR } : {}),
    ...overrides,
  }
  const settings = normalizeConfig(raw)
  if (process.env.TIKTOK_ADS_RESOURCE) settings.resourceUrl = process.env.TIKTOK_ADS_RESOURCE
  return settings
}

/**
 * @param {{ settings?: Record<string, unknown>, log?: (message: string) => void }} [options]
 */
/** 常见的本地代理端口：系统代理没配置或端口没人监听时，按顺序探测 */
export const LOCAL_PROXY_PORTS = [7890, 7891, 7897, 10809, 10808, 1080, 2080, 8889]

export function createAdsCore(options = {}) {
  const settings = options.settings && options.settings.resourceUrl ? options.settings : configFromEnv(options.settings || {})
  const log = options.log || (() => {})

  let proxyUrl = null
  let proxySource = 'none'
  let proxyResolved = false
  let proxyCheckedAt = 0
  let proxyOk = false

  function getProxy() {
    if (!proxyResolved) {
      const resolved = resolveProxy(settings.proxySetting)
      proxyUrl = parseProxy(resolved.proxy)
      proxySource = resolved.source
      proxyResolved = true
    }
    return { proxy: proxyUrl, source: proxySource }
  }

  /** TCP 探测本地端口是否有人监听（只握手，不发数据） */
  function portAlive(host, port, timeoutMs = 600) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port })
      const done = (value) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
  }

  /**
   * 解析并「验证」代理：优先 env / 系统代理，端口没人监听时再到常见端口里找一个。
   * 结果缓存 30 秒——用户中途打开代理，下一次请求就能自动用上，不用重启插件。
   */
  async function refreshProxy({ force = false } = {}) {
    const now = Date.now()
    if (!force && proxyOk && now - proxyCheckedAt < 30_000) return getProxy()
    if (!force && now - proxyCheckedAt < 15_000) return getProxy()

    const current = getProxy()
    if (settings.proxySetting && settings.proxySetting !== 'auto' && settings.proxySetting !== '') {
      // 显式配置的代理：尊重用户，不再探测（否则配置写错会静默走别的代理）
      proxyCheckedAt = now
      proxyOk = Boolean(current.proxy)
      return current
    }
    if (current.proxy) {
      const alive = await portAlive(current.proxy.host, Number(current.proxy.port))
      if (alive) {
        proxyCheckedAt = now
        proxyOk = true
        return current
      }
    }
    for (const port of LOCAL_PROXY_PORTS) {
      if (await portAlive('127.0.0.1', port)) {
        // 探测到的端口如果就是系统代理配的那个，说明刚才只是慢了一拍，保留原来源标签
        const sameAsSystem = current.proxy && Number(current.proxy.port) === port && /127\.0\.0\.1|localhost/.test(current.proxy.host || '')
        proxyUrl = parseProxy(`http://127.0.0.1:${port}`)
        proxySource = sameAsSystem ? current.source : current.proxy ? 'auto-detected(替代失效的系统代理)' : 'auto-detected'
        proxyCheckedAt = now
        proxyOk = true
        log(`检测到本地代理 127.0.0.1:${port}（${proxySource}），本次会话使用它`)
        return getProxy()
      }
    }
    proxyCheckedAt = now
    proxyOk = false
    return current
  }

  /** 供面板 / status 展示：当前代理是否可用 + 下一步建议 */
  async function probeProxy({ force = false } = {}) {
    const { proxy, source } = await refreshProxy({ force })
    if (proxy && proxyOk) return { ok: true, proxy: redactProxy(proxy), source, hint: '' }
    return {
      ok: false,
      proxy: proxy ? redactProxy(proxy) : '未配置',
      source,
      hint: '没有检测到可用的本地代理（系统代理关闭，' + LOCAL_PROXY_PORTS.join('/') + ' 端口都没有监听）。请先启动 Clash / v2rayN 之类的代理客户端。',
    }
  }

  let metadataCache = null
  async function getMetadata(signal) {
    if (metadataCache) return metadataCache
    const { proxy } = await refreshProxy()
    metadataCache = await discoverMetadata(settings.resourceUrl, { proxy, signal, timeoutMs: settings.requestTimeoutMs })
    return metadataCache
  }

  let session = null
  let refreshInFlight = null

  async function getAccessToken({ force = false, signal } = {}) {
    const record = readAuth(settings.dataDir)
    if (!force && isTokenUsable(record, settings.resourceUrl)) return record.accessToken
    if (!record.refreshToken || !record.clientId) {
      throw new Error('尚未完成 TikTok 授权：请先运行 `ads-cli login`（或调用 connect 工具）完成浏览器授权。')
    }
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const metadata = await getMetadata(signal)
        const { proxy } = await refreshProxy()
        const tokens = await refreshAccessToken(
          metadata,
          { clientId: record.clientId, refreshToken: record.refreshToken, resource: settings.resourceUrl },
          proxy,
          signal,
          settings.requestTimeoutMs,
        )
        const next = updateAuth(settings.dataDir, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || record.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope || record.scope,
          resource: settings.resourceUrl,
          mode: settings.mode,
        })
        return next.accessToken
      })().finally(() => {
        refreshInFlight = null
      })
    }
    return refreshInFlight
  }

  function persistCatalog(active) {
    writeCache(settings.dataDir, {
      resource: settings.resourceUrl,
      syncedAt: active.lastSyncedAt || Date.now(),
      tools: active.tools,
    })
  }

  async function ensureSession({ signal, force = false } = {}) {
    if (session && session.initialized && !force) return session
    session = null
    const { proxy } = await refreshProxy()
    const next = new McpSession({
      url: settings.resourceUrl,
      proxy,
      timeoutMs: settings.requestTimeoutMs,
      getToken: () => getAccessToken({ signal }),
      onUnauthorized: async (reason) => {
        log(`token rejected (${reason}); refreshing`)
        await getAccessToken({ force: true, signal })
      },
    })
    await next.connect({ signal })
    session = next
    persistCatalog(next)
    return next
  }

  /** 调用任意 TikTok MCP 工具（名字来自 tiktok_ads_tools / tools 列表）。 */
  async function callTool(name, params = {}, { signal, timeoutMs } = {}) {
    const record = readAuth(settings.dataDir)
    if (!isTokenUsable(record, settings.resourceUrl) && !record.refreshToken) {
      throw new Error('尚未授权：请先运行 `ads-cli login` 完成 TikTok 授权。')
    }
    const active = await ensureSession({ signal })
    const result = await active.callTool('tool_execute', { tool_name: name, params }, {
      limit: 400_000,
      timeoutMs: timeoutMs || 180_000,
    })
    const data = JSON.parse(result.text)
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`${name} 返回 code=${data.code}: ${data.message || ''}`)
    }
    return data
  }

  /** 工具目录检索（优先用本地缓存，不用每次连网）。 */
  function listTools(query = '', limitOrOptions = 25, offsetArg = 0) {
    const options = typeof limitOrOptions === 'object' && limitOrOptions !== null ? limitOrOptions : { limit: limitOrOptions, offset: offsetArg }
    const cache = readCache(settings.dataDir, settings.resourceUrl)
    const tools = cache?.tools || []
    const result = searchTools(tools, {
      query,
      limit: Math.max(1, Math.min(100, Number(options.limit) || 25)),
      offset: Math.max(0, Number(options.offset) || 0),
    })
    return { total: result.total, matched: result.matchedCount, offset: result.offset, limit: result.limit, tools: result.tools }
  }

  /** 本地缓存的完整工具清单（可能为空）。 */
  function cachedCatalog() {
    const cache = readCache(settings.dataDir, settings.resourceUrl)
    return cache?.tools || []
  }

  /** 需要完整目录时用：优先缓存，refresh=true 或缓存为空时连网同步。 */
  async function getCatalog({ refresh = false, signal } = {}) {
    if (!refresh) {
      const cached = cachedCatalog()
      if (cached.length) return cached
    }
    const active = await ensureSession({ signal, force: refresh })
    return active.tools
  }

  /** 清除本地令牌并尽力通知服务端撤销。 */
  async function disconnect() {
    const record = readAuth(settings.dataDir)
    let revoked = false
    if (record.accessToken && record.clientId) {
      try {
        const metadata = await getMetadata()
        const { proxy } = getProxy()
        revoked = await revokeToken(metadata, { clientId: record.clientId, token: record.accessToken }, proxy)
      } catch { /* revoke 尽力而为 */ }
    }
    clearAuth(settings.dataDir)
    session = null
    metadataCache = null
    return { ok: true, revoked }
  }

  function status() {
    const record = readAuth(settings.dataDir)
    const { proxy, source } = getProxy()
    const cache = readCache(settings.dataDir, settings.resourceUrl)
    const authorized = isTokenUsable(record, settings.resourceUrl)
    return {
      ok: true,
      authorized,
      mode: settings.mode,
      expose: settings.expose,
      resource: settings.resourceUrl,
      proxy: redactProxy(proxy),
      proxySource: source,
      proxyOk,
      ...(proxyOk ? {} : { proxyHint: '未检测到可用本地代理：请先启动 Clash / v2rayN（常见端口 ' + LOCAL_PROXY_PORTS.join('/') + '）' }),
      dataDir: settings.dataDir,
      cachedTools: cache?.tools?.length || 0,
      lastSyncedAt: cache?.syncedAt ? new Date(cache.syncedAt).toISOString() : null,
      tokenExpiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      hasRefreshToken: Boolean(record.refreshToken),
      next: authorized
        ? '已授权，可直接调用工具（如 gmv_max_report_get / campaign_get）。'
        : '未授权：运行 `ads-cli login` 或调用 connect 工具完成浏览器授权。',
    }
  }

  /** 生成授权链接并在本机起回调服务器；返回链接，等待浏览器授权后自动写入令牌。 */
  async function beginLogin({ signal, wait = false, openBrowser = true } = {}) {
    const existing = readAuth(settings.dataDir)
    const metadata = await getMetadata(signal)
    const { proxy } = await refreshProxy()
    const callback = await startCallbackServer({ port: settings.callbackPort, timeoutMs: settings.authTimeoutMs, signal })
    let clientId = existing.clientId
    let state = ''
    let pkce = null
    let url = ''
    try {
      if (!clientId || existing.redirectUri !== callback.redirectUri) {
        const registration = await registerClient(metadata, {
          redirectUri: callback.redirectUri,
          proxy,
          signal,
          timeoutMs: settings.requestTimeoutMs,
        })
        clientId = registration.clientId
        writeAuth(settings.dataDir, {
          ...existing,
          clientId,
          redirectUri: callback.redirectUri,
          accessToken: undefined,
          refreshToken: undefined,
          expiresAt: undefined,
        })
      }
      pkce = pkcePair()
      state = randomState()
      url = buildAuthorizeUrl(metadata, {
        clientId,
        redirectUri: callback.redirectUri,
        challenge: pkce.challenge,
        state,
        scope: settings.oauthScopes,
        resource: settings.resourceUrl,
      })
    } catch (error) {
      // 注册客户端 / 构造授权链接失败时，必须把已经监听的端口释放掉，
      // 否则下一次 login 会直接 EADDRINUSE。
      callback.close()
      throw error
    }
    try {
      fs.mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(settings.dataDir, 'pending-auth-url.txt'), `${url}\n`, { mode: 0o600 })
    } catch { /* ignore */ }
    if (openBrowser) {
      try {
        openExternal(url)
      } catch { /* 用户可手动打开 */ }
    }
    const settle = (async () => {
      try {
        const code = await callback.waitForCode(state)
        const tokens = await exchangeCode(
          metadata,
          { clientId, code, redirectUri: callback.redirectUri, codeVerifier: pkce.verifier, resource: settings.resourceUrl },
          proxy,
          signal,
          settings.requestTimeoutMs,
        )
        writeAuth(settings.dataDir, {
          clientId,
          redirectUri: callback.redirectUri,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope || settings.oauthScopes,
          resource: settings.resourceUrl,
          mode: settings.mode,
          authorizedAt: Date.now(),
        })
        let toolCount = 0
        try {
          const active = await ensureSession({ signal, force: true })
          toolCount = active.tools.length
        } catch (error) {
          log(`授权已保存，但工具同步失败：${messageOf(error)}`)
        }
        return { ok: true, authorized: true, toolCount }
      } finally {
        callback.close()
      }
    })()
    if (!wait) {
      // 不等待时也要挂一个空的 catch，避免授权超时之类变成 unhandledRejection
      settle.catch(() => {})
      return { ok: true, url, waiting: true, settle }
    }
    return settle
  }

  return {
    settings,
    status,
    probeProxy,
    listTools,
    cachedCatalog,
    getCatalog,
    disconnect,
    callTool,
    ensureSession,
    getAccessToken,
    beginLogin,
    homeDir: () => path.join(os.homedir()),
  }
}
