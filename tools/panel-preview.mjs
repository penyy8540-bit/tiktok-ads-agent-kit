#!/usr/bin/env node
/**
 * Run the TikTok Ads dashboard + monitor WITHOUT DSH.
 *
 * Useful for verification and for keeping the panel up while DSH is closed.
 *
 *   node tools/panel-preview.mjs                # http://127.0.0.1:8790/
 *   node tools/panel-preview.mjs --port 8899 --no-scan
 */
import { normalizeConfig } from '../lib/config.js'
import { createAdsCore } from '../lib/core.js'
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

// 与 DSH 插件、CLI、MCP server 共用同一套 core（OAuth / 令牌 / MCP 会话都在里面）
const core = createAdsCore({ settings, log: (message) => console.log(`[core] ${message}`) })

const callTool = (name, params) => core.callTool(name, params)

const panel = createPanel({
  settings,
  callTool,
  log: (message) => console.log(`[panel] ${message}`),
  getStatus: async () => {
    const health = await core.probeProxy()
    const status = core.status()
    return {
      authorized: status.authorized,
      mode: status.mode,
      resource: status.resource,
      proxy: status.proxy,
      proxyOk: health.ok,
      proxyHint: health.hint,
    }
  },
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
// 后台探一次连接：只用来在控制台提示「代理是否可用」，不阻塞面板启动
core
  .ensureSession()
  .then((session) => console.log(`已连接 MCP，工具 ${session.tools.length} 个`))
  .catch((error) => {
    console.log(`⚠ 暂时连不上 TikTok（通常是代理没开）：${String(error.message).slice(0, 100)}`)
    console.log('  面板照常可用（显示上次缓存的数据）；代理恢复后点「刷新」即可。')
  })

console.log('按 Ctrl+C 退出')
setInterval(() => {}, 1 << 30)
