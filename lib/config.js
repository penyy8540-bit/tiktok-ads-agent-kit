/**
 * Plugin configuration: defaults, normalization, and proxy auto-detection.
 *
 * Configuration arrives from the profile's `cordis.patch.yml` row. Every field
 * is optional so the plugin works with a zero-config install.
 */
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const MODES = Object.freeze({
  layer: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer',
  flat: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat',
})

export const EXPOSE = Object.freeze(['meta', 'all'])

/** DSH home directory, following the host's own resolution order. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the plugin data directory.
 * @param {{ dataDir?: string }} config
 */
export function dataDir(config = {}) {
  const configured = typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : ''
  return configured || path.join(dshHome(), 'plugin-data', 'tiktok-ads')
}

/**
 * Read the Windows system proxy (WinINET) from the registry.
 * The DSH host process usually does not inherit `HTTPS_PROXY`, so this is the
 * only way to discover a locally running proxy on a typical Windows install.
 * @returns {string | null}
 */
export function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)
    if (!enabled) return null
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(output)
    if (!match) return null
    const raw = match[1].trim()
    // ProxyServer may be "host:port" or "http=host:port;https=host:port;...".
    if (raw.includes('=')) {
      const parts = Object.fromEntries(
        raw.split(';').map((entry) => {
          const index = entry.indexOf('=')
          return index > 0 ? [entry.slice(0, index).trim().toLowerCase(), entry.slice(index + 1).trim()] : ['', '']
        }),
      )
      return parts.https || parts.http || null
    }
    return raw
  } catch {
    return null
  }
}

/**
 * 隐藏代理里的用户名/密码：日志、状态、工具返回值都必须用它。
 * @param {URL | string | null | undefined} proxy
 */
export function redactProxy(proxy) {
  if (!proxy) return 'none'
  try {
    const url = typeof proxy === 'string' ? new URL(proxy) : new URL(proxy.href)
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname
    const auth = url.username || url.password ? '（含认证，已隐藏）' : ''
    return `${url.protocol}//${host}${auth}`
  } catch {
    return 'none'
  }
}

/**
 * Resolve the effective proxy string.
 * @param {'auto' | 'off' | string} setting
 * @returns {{ proxy: string | null, source: string }}
 */
export function resolveProxy(setting) {
  const value = typeof setting === 'string' ? setting.trim() : 'auto'
  if (!value || value === 'auto') {
    const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    if (fromEnv && fromEnv.trim()) return { proxy: fromEnv.trim(), source: 'env' }
    const fromSystem = readWindowsSystemProxy()
    if (fromSystem) return { proxy: fromSystem, source: 'windows-system' }
    return { proxy: null, source: 'none' }
  }
  if (value === 'off' || value === 'none' || value === 'direct') return { proxy: null, source: 'config-off' }
  return { proxy: value, source: 'config' }
}

/**
 * Normalize the raw cordis config row into a complete settings object.
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mode = String(source.mode ?? 'layer').toLowerCase()
  if (!(mode in MODES)) throw new Error(`tiktok-ads: mode 只能是 layer 或 flat（收到 ${JSON.stringify(source.mode)}）`)
  const expose = String(source.expose ?? 'meta').toLowerCase()
  if (!EXPOSE.includes(expose)) throw new Error(`tiktok-ads: expose 只能是 meta 或 all（收到 ${JSON.stringify(source.expose)}）`)
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }
  return {
    mode,
    resourceUrl: MODES[mode],
    expose,
    proxySetting: typeof source.proxy === 'string' ? source.proxy : 'auto',
    callbackPort: number(source.callbackPort, 43_113, 1024, 65_535),
    maxExposeAll: number(source.maxExposeAll, 100, 1, 400),
    requestTimeoutMs: number(source.requestTimeoutMs, 60_000, 5_000, 600_000),
    toolCallTimeoutMs: number(source.toolCallTimeoutMs, 120_000, 5_000, 900_000),
    authTimeoutMs: number(source.authTimeoutMs, 300_000, 30_000, 1_800_000),
    autoOpenBrowser: source.autoOpenBrowser !== false,
    dataDir: dataDir(source),
    oauthScopes: typeof source.oauthScopes === 'string' && source.oauthScopes.trim() ? source.oauthScopes.trim() : 'mcp:tt4b',
    // Dashboard + monitoring (see lib/dashboard.js, lib/monitor.js)
    dashboardEnabled: source.dashboardEnabled !== false,
    dashboardPort: number(source.dashboardPort, 8790, 1024, 65_535),
    monitorIntervalMinutes: number(source.monitorIntervalMinutes, 30, 5, 1440),
    feishuWebhook: typeof source.feishuWebhook === 'string' ? source.feishuWebhook.trim() : '',
    // Excel 导出目录；留空 = 桌面「广告/每日广告订单」（无桌面时用数据目录 exports）
    exportDir: typeof source.exportDir === 'string' ? source.exportDir.trim() : '',
    rules: {
      windowDays: number(source.rules?.windowDays, 3, 1, 30),
      spendThreshold: number(source.rules?.spendThreshold, 30, 0, 1_000_000),
      roiTarget: number(source.rules?.roiTarget, 10, 0.1, 1000),
      roiRatio: number(source.rules?.roiRatio, 0.7, 0.1, 1),
      spendSpikeRatio: number(source.rules?.spendSpikeRatio, 2, 1.1, 20),
      minCostForSpike: number(source.rules?.minCostForSpike, 20, 0, 1_000_000),
      maxCreatives: number(source.rules?.maxCreatives, 40, 1, 500),
    },
  }
}
