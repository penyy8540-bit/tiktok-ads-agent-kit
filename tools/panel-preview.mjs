#!/usr/bin/env node
/**
 * Run the TikTok Ads dashboard + monitor WITHOUT DSH.
 *
 * Useful for verification and for keeping the panel up while DSH is closed.
 *
 *   node tools/panel-preview.mjs                # http://127.0.0.1:8790/
 *   node tools/panel-preview.mjs --port 8899 --no-scan
 */
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'
import { createPanel } from '../lib/panel.js'

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const has = (flag) => argv.includes(flag)

// 面板是常驻服务：单次网络抖动不应把进程带走（transport 已修，这里再加一层兜底）。
process.on('uncaughtException', (error) => {
  console.error('[panel] 未捕获异常（已忽略继续运行）：', error?.stack || error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[panel] 未处理的 Promise 拒绝（已忽略继续运行）：', reason?.stack || reason)
})

const settings = normalizeConfig({
  proxy: value('--proxy', 'auto'),
  dataDir: value('--data-dir', undefined),
  dashboardPort: Number(value('--port', '8790')),
  monitorIntervalMinutes: Number(value('--interval', '30')),
})

const proxy = parseProxy(resolveProxy(settings.proxySetting).proxy)
let auth = readAuth(settings.dataDir)
if (!auth.accessToken || !auth.clientId) {
  console.error(`未授权：${settings.dataDir} 缺少 auth.json（先运行 tools/verify.mjs --login）`)
  process.exit(1)
}
if (!isTokenUsable(auth, settings.resourceUrl)) {
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
  const tokens = await refreshAccessToken(metadata, { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl }, proxy)
  auth = updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || auth.refreshToken, expiresAt: tokens.expiresAt })
  console.log('令牌已续期')
}

let currentToken = auth.accessToken
const session = new McpSession({
  url: settings.resourceUrl,
  proxy,
  timeoutMs: 120_000,
  getToken: async () => currentToken,
  onUnauthorized: async () => {
    const record = readAuth(settings.dataDir)
    const metadata = await discoverMetadata(settings.resourceUrl, { proxy })
    const tokens = await refreshAccessToken(metadata, { clientId: record.clientId, refreshToken: record.refreshToken, resource: settings.resourceUrl }, proxy)
    updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || record.refreshToken, expiresAt: tokens.expiresAt })
    currentToken = tokens.accessToken
    console.log('令牌被拒绝，已续期')
  },
})
let connected = false
for (let attempt = 1; attempt <= 4 && !connected; attempt++) {
  try {
    await session.connect()
    connected = true
  } catch (error) {
    console.log(`连接失败（第 ${attempt} 次）：${String(error.message).slice(0, 120)}`)
    if (attempt === 4) throw error
    await new Promise((resolve) => setTimeout(resolve, 2500 * attempt))
  }
}
console.log(`已连接 ${session.serverInfo?.name}，工具 ${session.tools.length} 个`)

async function callTool(name, params) {
  const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 180_000 })
  const data = JSON.parse(result.text)
  if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`${name} code=${data.code}: ${data.message || ''}`)
  }
  return data
}

const panel = createPanel({
  settings,
  callTool,
  log: (message) => console.log(`[panel] ${message}`),
  getStatus: () => ({ authorized: isTokenUsable(readAuth(settings.dataDir), settings.resourceUrl), mode: settings.mode, resource: settings.resourceUrl }),
})
const state = await panel.start()
if (!state.dashboardUrl) {
  console.error('面板启动失败（端口可能被占用）')
  process.exit(1)
}
console.log(`面板：${state.dashboardUrl}`)
console.log(`规则：窗口 ${panel.getConfig().rules.windowDays} 天，消耗阈值 $${panel.getConfig().rules.spendThreshold}，ROI 目标 ${panel.getConfig().rules.roiTarget}`)
if (!has('--no-scan')) {
  try {
    const result = await panel.runScan({ notify: false })
    console.log(`首次扫描：${result.scannedStores} 个店铺，异常 ${result.active} 条（新增 ${result.fresh}）`)
  } catch (error) {
    console.log(`首次扫描失败：${error.message}`)
  }
}
console.log('按 Ctrl+C 退出')
setInterval(() => {}, 1 << 30)
