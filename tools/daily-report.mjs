#!/usr/bin/env node
/**
 * Daily TikTok ads report puller.
 *
 * Pulls GMV Max (Shop ads) and classic auction reports for every ad account the
 * stored OAuth token can manage, then writes CSV + JSON + XLSX into a dated dir.
 *
 *   node tools/daily-report.mjs                 # yesterday, all accounts
 *   node tools/daily-report.mjs --days 7        # last 7 days (incl. daily detail)
 *   node tools/daily-report.mjs --date 2026-10-26 --out "D:\reports"
 *   node tools/daily-report.mjs --accounts 7663409215079202836,7663412553150070804
 *   node tools/daily-report.mjs --no-xlsx       # CSV/JSON only
 *
 * Exit codes: 0 ok, 1 fatal (auth/network), 2 partial (some account failed).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import { discoverMetadata, refreshAccessToken } from '../lib/oauth.js'
import { isTokenUsable, readAuth, updateAuth } from '../lib/store.js'

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

const DAY_MS = 86_400_000
const pad = (n) => String(n).padStart(2, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const parseDate = (text) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

// Date range: --start/--end (inclusive) are the user-facing form; --date sets
// the end date and --days sets the span. Default is "yesterday".
const endArg = value('--end', '') || value('--date', '')
const endDate = endArg ? parseDate(endArg) : new Date(Date.now() - DAY_MS)
if (!endDate) {
  console.error('--date / --end 需要 YYYY-MM-DD 格式')
  process.exit(1)
}
const startArg = value('--start', '')
const startDate = startArg ? parseDate(startArg) : null
if (startArg && !startDate) {
  console.error('--start 需要 YYYY-MM-DD 格式')
  process.exit(1)
}
const days = startDate
  ? Math.max(1, Math.min(365, Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1))
  : Math.max(1, Math.min(365, Number(value('--days', '1')) || 1))
const startText = formatDate(startDate ?? new Date(endDate.getTime() - (days - 1) * DAY_MS))
const endText = formatDate(endDate)

const settings = normalizeConfig({
  mode: 'layer',
  proxy: value('--proxy', 'auto'),
  dataDir: value('--data-dir', undefined),
})
const outRoot = path.resolve(value('--out', path.join(os.homedir(), 'Desktop', '广告', '每日广告订单')))
// Single-day runs keep the plain date folder; multi-day runs name the range.
const rangeLabel = days > 1 ? `${startText}_${endText}` : endText
// --flat keeps the workbook directly in outRoot as <date>.xlsx (one file per day),
// which is the agreed standard; CSVs/JSON go to a side folder to keep it tidy.
const flatOutput = has('--flat')
const reportDir = flatOutput ? path.join(outRoot, '明细csv', rangeLabel) : path.join(outRoot, rangeLabel)
const xlsxTarget = flatOutput ? path.join(outRoot, `${rangeLabel}.xlsx`) : null
const wantXlsx = !has('--no-xlsx')
const requestedAccounts = (value('--accounts', '') || '').split(',').map((item) => item.trim()).filter(Boolean)
const classicEnabled = !has('--no-classic')

// ------------------------------------------------------------------- per day
// `--per-day` fans a date range out into one self-contained workbook per day by
// re-running this script for each date with --flat.
if (has('--per-day') && days > 1) {
  const dates = []
  const firstDay = parseDate(startText) || new Date(endDate.getTime() - (days - 1) * DAY_MS)
  for (let cursor = firstDay; cursor.getTime() <= endDate.getTime(); cursor = new Date(cursor.getTime() + DAY_MS)) {
    dates.push(formatDate(cursor))
  }
  fs.mkdirSync(outRoot, { recursive: true })
  const passthrough = []
  for (const flag of ['--proxy', '--data-dir', '--accounts', '--sku-sales', '--sku-sales-dir', '--sku-map', '--sku-overrides']) {
    const flagValue = value(flag, '')
    if (flagValue) passthrough.push(flag, flagValue)
  }
  for (const flag of ['--no-creative', '--no-classic', '--no-xlsx']) {
    if (has(flag)) passthrough.push(flag)
  }
  let failures = 0
  for (const date of dates) {
    const child = spawnSync(process.execPath, [process.argv[1], '--date', date, '--days', '1', '--flat', '--out', outRoot, ...passthrough], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const tail = String(child.stdout || '').trim().split(/\r?\n/).filter((line) => /完成：|合计：/.test(line)).join(' ')
    if (child.status === 0) console.log(`[per-day] ${date} ✓ ${tail.slice(0, 220)}`)
    else {
      failures++
      console.log(`[per-day] ${date} ✗ exit=${child.status} ${String(child.stderr || '').trim().slice(-200)}`)
    }
  }
  console.log(`[per-day] 完成 ${dates.length - failures}/${dates.length} 天 → ${outRoot}`)
  process.exit(failures ? 2 : 0)
}

// ------------------------------------------------------------------ logging
fs.mkdirSync(reportDir, { recursive: true })
const logFile = path.join(reportDir, 'run.log')
const logLine = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    fs.appendFileSync(logFile, `${line}\n`)
  } catch { /* non-fatal */ }
}

// ------------------------------------------------------------------- client
const resolvedProxy = resolveProxy(settings.proxySetting)
const proxy = parseProxy(resolvedProxy.proxy)
const auth = readAuth(settings.dataDir)
if (!auth.accessToken || !auth.refreshToken) {
  logLine(`未授权：缺少 access/refresh token（${settings.dataDir}）`)
  process.exit(1)
}
if (!isTokenUsable(auth, settings.resourceUrl)) {
  logLine('access token 即将过期，正在用 refresh_token 续期…')
  const metadata = await discoverMetadata(settings.resourceUrl, { proxy, timeoutMs: settings.requestTimeoutMs })
  const tokens = await refreshAccessToken(
    metadata,
    { clientId: auth.clientId, refreshToken: auth.refreshToken, resource: settings.resourceUrl },
    proxy,
    undefined,
    settings.requestTimeoutMs,
  )
  updateAuth(settings.dataDir, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || auth.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope || auth.scope,
  })
  logLine('续期完成')
}
let currentToken = readAuth(settings.dataDir).accessToken

const session = new McpSession({
  url: settings.resourceUrl,
  proxy,
  timeoutMs: settings.requestTimeoutMs,
  getToken: async () => currentToken,
  onUnauthorized: async () => {
    const record = readAuth(settings.dataDir)
    if (!record.refreshToken) throw new Error('令牌失效且无 refresh_token，需要重新授权')
    const metadata = await discoverMetadata(settings.resourceUrl, { proxy, timeoutMs: settings.requestTimeoutMs })
    const tokens = await refreshAccessToken(
      metadata,
      { clientId: record.clientId, refreshToken: record.refreshToken, resource: settings.resourceUrl },
      proxy,
      undefined,
      settings.requestTimeoutMs,
    )
    updateAuth(settings.dataDir, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || record.refreshToken, expiresAt: tokens.expiresAt })
    currentToken = tokens.accessToken
    logLine('令牌被拒绝，已重新续期')
  },
})
await session.connect()
logLine(`已连接 ${session.serverInfo?.name || '?'}，工具 ${session.tools.length} 个；代理 ${resolvedProxy.proxy ?? '直连'}（${resolvedProxy.source}）`)
logLine(`报表区间 ${startText} ~ ${endText}（${days} 天）`)

/**
 * Call one MCP tool through the dispatcher, retrying transient failures.
 * @param {string} name
 * @param {Record<string, unknown>} params
 */
async function callTool(name, params) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await session.callTool('tool_execute', { tool_name: name, params }, { limit: 400_000, timeoutMs: 180_000 })
      const data = JSON.parse(result.text)
      if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
        throw new Error(`${name} 返回 code=${data.code}: ${data.message || ''}`)
      }
      return data
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      // 51010 "Internal service timed out" is a transient TikTok-side timeout;
      // item-level GMV Max reports hit it often, so retry with backoff.
      const retryable = /timeout|timed out|time out|超时|ECONN|socket|network|50[234]|51010|internal (service|error)|rate|too many|try again|\b5\d{4}\b/i.test(message)
      if (!retryable || attempt === 3) throw error
      const wait = 1500 * (attempt + 1)
      logLine(`  … ${name} 瞬时失败（${message.slice(0, 90)}），${wait}ms 后重试`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}

// -------------------------------------------------------------- collect data
const summaryRows = []
const productRows = []
const productDailyRows = []
const creativeRows = []
// Set once TikTok keeps failing the item-level report, so later stores are
// skipped quickly instead of burning minutes on retries.
let creativeDisabled = false

/**
 * Optional product_id → { sku, name } map, built from a Seller Center product
 * export. Accepts sku-map.csv / sku-map.xlsx / sku-map.json in the plugin data
 * dir, or an explicit --sku-map path. An xlsx export is converted with the
 * bundled Python + openpyxl first, so the user can just drop in the raw export.
 * @returns {(productId: string) => { sku: string, name: string }}
 */
function createProductLookup() {
  const dataDir = settings.dataDir
  const cacheDir = path.join(dataDir, 'sku-map-cache')

  // Collect every usable product export: explicit --sku-map values, the default
  // file names, and anything dropped into the sku-maps/ folder. One TikTok Shop
  // export only covers ONE shop, so DE/FR/ES shops need their own file.
  const sources = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--sku-map' && argv[index + 1] && !argv[index + 1].startsWith('--')) sources.push(argv[index + 1])
  }
  if (sources.length === 0) {
    for (const name of ['sku-map.csv', 'sku-map.xlsx', 'sku-map.xlsm']) {
      const candidate = path.join(dataDir, name)
      if (fs.existsSync(candidate)) sources.push(candidate)
    }
    const folder = path.join(dataDir, 'sku-maps')
    try {
      if (fs.existsSync(folder)) {
        for (const name of fs.readdirSync(folder).sort()) {
          if (name.startsWith('~$') || name.startsWith('.')) continue
          if (/\.(xlsx|xlsm|csv|json)$/i.test(name)) sources.push(path.join(folder, name))
        }
      }
    } catch { /* ignore */ }
  }

  const map = new Map()
  const python = findPythonForMap()
  const builder = path.join(import.meta.dirname, 'build-sku-map.py')
  for (const original of sources) {
    if (!fs.existsSync(original)) {
      logLine(`商品映射文件不存在：${original}`)
      continue
    }
    let source = original
    if (/\.(xlsx|xlsm)$/i.test(source)) {
      if (!python) {
        logLine(`${path.basename(source)} 需要 Python+openpyxl 转换，但没找到；请另存为 CSV`)
        continue
      }
      try {
        fs.mkdirSync(cacheDir, { recursive: true })
      } catch { /* ignore */ }
      const converted = path.join(cacheDir, `${path.basename(source).replace(/\.[^.]+$/, '')}.csv`)
      const result = spawnSync(python, [builder, source, converted], { encoding: 'utf8' })
      const note = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
      if (result.status !== 0 || !fs.existsSync(converted)) {
        logLine(`商品表转换失败 ${path.basename(source)}：${note.slice(0, 160)}`)
        continue
      }
      logLine(`商品表转换：${path.basename(source)} → ${path.basename(converted)}（${note.slice(0, 100)}）`)
      source = converted
    }
    try {
      if (source.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(fs.readFileSync(source, 'utf8'))
        for (const [key, val] of Object.entries(parsed)) {
          map.set(String(key).trim(), typeof val === 'string' ? { sku: val.trim(), name: '' } : { sku: String(val.sku || ''), name: String(val.name || '') })
        }
      } else {
        const text = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')
        const lines = text.split(/\r?\n/).filter((line) => line.trim())
        const header = (lines[0] || '').split(',').map((cell) => cell.replace(/^"|"$/g, '').trim().toLowerCase())
        const productIndex = header.indexOf('product_id')
        const skuIndex = header.indexOf('seller_sku')
        const nameIndex = header.indexOf('product_name')
        if (productIndex < 0 || skuIndex < 0) {
          logLine(`商品表缺列（需要 product_id / seller_sku）：${path.basename(source)}`)
          continue
        }
        let added = 0
        for (const line of lines.slice(1)) {
          const clean = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || []
          const productId = clean[productIndex]
          if (!productId) continue
          map.set(productId, { sku: clean[skuIndex] || '', name: nameIndex >= 0 ? clean[nameIndex] || '' : '' })
          added++
        }
        logLine(`商品映射 +${added}：${path.basename(source)}`)
      }
    } catch (error) {
      logLine(`商品映射读取失败 ${path.basename(source)}：${error.message}`)
    }
  }
  if (map.size === 0) {
    logLine('未找到商品映射（sku-map.csv/xlsx 或 sku-maps/ 目录）；商品明细的 SKU/商品名称 列将为空')
  } else {
    logLine(`商品映射合计 ${map.size} 个商品`)
  }

  // Manual overrides win over exports: small CSV with product_id,seller_sku,product_name
  // for products missing from a Seller Center export (deleted/paused/new listings).
  const overrideCandidates = [value('--sku-overrides', ''), path.join(dataDir, 'sku-overrides.csv'), path.join(dataDir, 'sku-maps', 'overrides.csv')].filter(Boolean)
  for (const file of overrideCandidates) {
    try {
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
      if (lines.length < 2) continue
      const header = lines[0].split(',').map((cell) => cell.replace(/^"|"$/g, '').trim().toLowerCase())
      const productIndex = header.findIndex((cell) => cell === 'product_id' || cell === '商品id')
      const skuIndex = header.findIndex((cell) => cell === 'seller_sku' || cell === 'sku' || cell === '商家sku')
      const nameIndex = header.findIndex((cell) => cell === 'product_name' || cell === '商品名称')
      if (productIndex < 0) continue
      let added = 0
      for (const line of lines.slice(1)) {
        const clean = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || []
        const productId = clean[productIndex]
        if (!productId) continue
        const existing = map.get(productId) || { sku: '', name: '' }
        map.set(productId, {
          sku: (skuIndex >= 0 && clean[skuIndex]) || existing.sku || '',
          name: (nameIndex >= 0 && clean[nameIndex]) || existing.name || '',
        })
        added++
      }
      if (added) logLine(`手工补录 +${added}：${path.basename(file)}`)
    } catch (error) {
      logLine(`手工补录读取失败 ${path.basename(file)}：${error.message}`)
    }
  }
  return (productId) => map.get(String(productId)) || { sku: '', name: '' }
}

/** Locate a Python interpreter that has openpyxl. */
function findPythonForMap() {
  const candidates = [
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python.exe',
    'python',
  ]
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import openpyxl'], { encoding: 'utf8' })
      if (probe.status === 0) return candidate
    } catch { /* next */ }
  }
  return null
}
const productLookup = createProductLookup()
const dailyRows = []
const accountRows = []
const errors = []

const authorized = (await callTool('auth_advertiser_get', {})).data?.list || []
const targets = requestedAccounts.length
  ? authorized.filter((account) => requestedAccounts.includes(String(account.advertiser_id)))
  : authorized
logLine(`账户 ${targets.length}/${authorized.length} 个待拉取`)

for (const account of targets) {
  const advertiserId = String(account.advertiser_id)
  const advertiserName = account.advertiser_name || advertiserId
  let accountCost = 0
  let accountOrders = 0
  let accountRevenue = 0
  let storesWithData = 0

  try {
    const storeList = (await callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
    const usable = storeList.filter((store) => store.is_gmv_max_available === true)
    logLine(`· ${advertiserName}：店铺 ${storeList.length} 个，可跑 GMV Max ${usable.length} 个`)

    for (const store of usable) {
      const storeId = String(store.store_id)
      const storeName = store.store_name || storeId
      try {
        const aggregate = await callTool('gmv_max_report_get', {
          advertiser_id: advertiserId,
          store_ids: [storeId],
          start_date: startText,
          end_date: endText,
          metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue', 'roi', 'cost_per_order'],
          dimensions: ['campaign_id'],
          page_size: 200,
        })
        const rows = aggregate.data?.list || []
        for (const row of rows) {
          const metrics = row.metrics || {}
          const cost = Number(metrics.cost) || 0
          const revenue = Number(metrics.gross_revenue) || 0
          const orders = Number(metrics.orders) || 0
          accountCost += cost
          accountOrders += orders
          accountRevenue += revenue
          if (cost > 0 || revenue > 0 || orders > 0) storesWithData++
          summaryRows.push({
            账户: advertiserName,
            广告账户ID: advertiserId,
            店铺: storeName,
            推广系列ID: String(row.dimensions?.campaign_id || ''),
            推广系列: metrics.campaign_name || '',
            消耗: cost,
            订单: orders,
            GMV: revenue,
            ROI: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
            单均成本: orders > 0 ? Number((cost / orders).toFixed(2)) : 0,
            数据源: 'GMV Max',
          })
        }

        if (days > 1) {
          const daily = await callTool('gmv_max_report_get', {
            advertiser_id: advertiserId,
            store_ids: [storeId],
            start_date: startText,
            end_date: endText,
            metrics: ['campaign_name', 'cost', 'orders', 'gross_revenue', 'roi'],
            dimensions: ['campaign_id', 'stat_time_day'],
            page_size: 1000,
          })
          for (const row of daily.data?.list || []) {
            const metrics = row.metrics || {}
            const cost = Number(metrics.cost) || 0
            const revenue = Number(metrics.gross_revenue) || 0
            const orders = Number(metrics.orders) || 0
            if (cost === 0 && revenue === 0 && orders === 0) continue
            dailyRows.push({
              日期: String(row.dimensions?.stat_time_day || '').slice(0, 10),
              账户: advertiserName,
              店铺: storeName,
              推广系列ID: String(row.dimensions?.campaign_id || ''),
              推广系列: metrics.campaign_name || '',
              消耗: cost,
              订单: orders,
              GMV: revenue,
              ROI: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
            })
          }
        }
      } catch (error) {
        errors.push(`${advertiserName}/${storeName}: ${error.message}`)
        logLine(`  ! 店铺 ${storeName} 拉取失败：${error.message}`)
      }
    }

    // ---- product (SPU) level: which products inside the campaign consumed budget
    const activeCampaignIds = summaryRows
      .filter((row) => row.账户 === advertiserName && row.店铺 !== '' && row.消耗 > 0)
      .map((row) => row.推广系列ID)
      .filter(Boolean)
    for (const store of usable) {
      const storeId = String(store.store_id)
      const storeName = store.store_name || storeId
      if (!activeCampaignIds.length) break
      let spuIds = []
      try {
        const spuReport = await callTool('gmv_max_report_get', {
          advertiser_id: advertiserId,
          store_ids: [storeId],
          start_date: startText,
          end_date: endText,
          metrics: ['cost', 'orders', 'gross_revenue', 'roi'],
          dimensions: ['item_group_id'],
          filtering: { campaign_ids: activeCampaignIds },
          page_size: 500,
        })
        for (const row of spuReport.data?.list || []) {
          const metrics = row.metrics || {}
          const cost = Number(metrics.cost) || 0
          const revenue = Number(metrics.gross_revenue) || 0
          const orders = Number(metrics.orders) || 0
          const spu = String(row.dimensions?.item_group_id || '')
          if (!spu || (cost === 0 && revenue === 0 && orders === 0)) continue
          spuIds.push(spu)
          const product = productLookup(spu)
          productRows.push({
            账户: advertiserName,
            店铺: storeName,
            商品SPU: spu,
            商品名称: product.name,
            SKU: product.sku,
            消耗: cost,
            订单: orders,
            GMV: revenue,
            ROI: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
            单均成本: orders > 0 ? Number((cost / orders).toFixed(2)) : 0,
          })
        }
      } catch (error) {
        logLine(`  ! 商品级数据失败（${storeName}）：${error.message}`)
      }

      // ---- product × day: "每日广告订单" per product (multi-day ranges only)
      if (days > 1 && spuIds.length) {
        try {
          for (let page = 1; page <= 3; page++) {
            const productDaily = await callTool('gmv_max_report_get', {
              advertiser_id: advertiserId,
              store_ids: [storeId],
              start_date: startText,
              end_date: endText,
              metrics: ['cost', 'orders', 'gross_revenue'],
              dimensions: ['item_group_id', 'stat_time_day'],
              filtering: { campaign_ids: activeCampaignIds },
              page_size: 1000,
              page,
            })
            const list = productDaily.data?.list || []
            for (const row of list) {
              const metrics = row.metrics || {}
              const cost = Number(metrics.cost) || 0
              const revenue = Number(metrics.gross_revenue) || 0
              const orders = Number(metrics.orders) || 0
              if (cost === 0 && revenue === 0 && orders === 0) continue
              const spu = String(row.dimensions?.item_group_id || '')
              if (!spu) continue
              const product = productLookup(spu)
              productDailyRows.push({
                日期: String(row.dimensions?.stat_time_day || '').slice(0, 10),
                账户: advertiserName,
                店铺: storeName,
                商品SPU: spu,
                商品名称: product.name,
                SKU: product.sku,
                消耗: cost,
                订单: orders,
                GMV: revenue,
                ROI: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
              })
            }
            const totalPage = Number(productDaily.data?.page_info?.total_page) || 1
            if (list.length === 0 || page >= Math.min(totalPage, 3)) break
          }
        } catch (error) {
          logLine(`  ! 商品按天数据失败（${storeName}）：${error.message}`)
        }
      }

      if (spuIds.length && !has('--no-creative') && !creativeDisabled) {
        // TikTok's item-level report intermittently answers 52404/51010 for a
        // combined campaign+SPU filter; fall back to per-campaign calls.
        const queries = [{ campaignIds: activeCampaignIds, label: '全部系列' }].concat(
          activeCampaignIds.map((campaignId) => ({ campaignIds: [campaignId], label: campaignId })),
        )
        let creativeOk = false
        for (const query of queries) {
          if (creativeOk) break
          try {
            let page = 1
            let collected = 0
            for (;;) {
              const itemReport = await callTool('gmv_max_report_get', {
                advertiser_id: advertiserId,
                store_ids: [storeId],
                start_date: startText,
                end_date: endText,
                metrics: ['cost', 'orders', 'gross_revenue', 'product_impressions', 'product_clicks'],
                dimensions: ['item_id'],
                filtering: { campaign_ids: query.campaignIds, item_group_ids: spuIds },
                page_size: 1000,
                page,
              })
              const list = itemReport.data?.list || []
              for (const row of list) {
                const metrics = row.metrics || {}
                const cost = Number(metrics.cost) || 0
                const revenue = Number(metrics.gross_revenue) || 0
                const orders = Number(metrics.orders) || 0
                if (cost === 0 && revenue === 0 && orders === 0) continue
                const itemId = String(row.dimensions?.item_id || '')
                const impressions = Number(metrics.product_impressions) || 0
                const clicks = Number(metrics.product_clicks) || 0
                creativeRows.push({
                  账户: advertiserName,
                  店铺: storeName,
                  帖子ID: itemId,
                  帖子链接: itemId ? `https://www.tiktok.com/@i/video/${itemId}` : '',
                  消耗: cost,
                  订单: orders,
                  GMV: revenue,
                  ROI: cost > 0 ? Number((revenue / cost).toFixed(2)) : 0,
                  商品曝光: impressions,
                  商品点击: clicks,
                  点击率: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
                })
              }
              collected += list.length
              const totalPage = Number(itemReport.data?.page_info?.total_page) || 1
              if (list.length === 0 || page >= Math.min(totalPage, 5) || collected >= 5000) break
              page++
            }
            creativeOk = true
          } catch (error) {
            logLine(`  … 素材级（${storeName}/${query.label}）失败：${String(error.message).slice(0, 100)}`)
          }
        }
        if (!creativeOk) {
          creativeDisabled = true
          logLine(`  ! 素材级数据整体失败（${storeName}）：TikTok 接口持续报错，本次后续店铺跳过素材`)
        }
      }
    }
    // Classic auction campaigns (non GMV Max). Empty is normal.
    if (classicEnabled) {
      try {
        const classic = await callTool('report_integrated_get', {
          report_type: 'BASIC',
          data_level: 'AUCTION_CAMPAIGN',
          advertiser_id: advertiserId,
          dimensions: ['campaign_id'],
          metrics: ['campaign_name', 'spend', 'clicks', 'conversion', 'cost_per_conversion'],
          start_date: startText,
          end_date: endText,
          page_size: 200,
        })
        for (const row of classic.data?.list || []) {
          const metrics = row.metrics || {}
          summaryRows.push({
            账户: advertiserName,
            广告账户ID: advertiserId,
            店铺: '',
            推广系列ID: String(row.dimensions?.campaign_id || ''),
            推广系列: metrics.campaign_name || '',
            消耗: Number(metrics.spend) || 0,
            订单: Number(metrics.conversion) || 0,
            GMV: 0,
            ROI: 0,
            单均成本: Number(metrics.cost_per_conversion) || 0,
            数据源: '经典 Ads',
          })
        }
      } catch (error) {
        errors.push(`${advertiserName}/经典报表: ${error.message}`)
        logLine(`  ! 经典报表失败（可忽略）：${error.message}`)
      }
    }

    accountRows.push({
      账户: advertiserName,
      广告账户ID: advertiserId,
      店铺数: storeList.length,
      有量店铺: storesWithData,
      消耗合计: Number(accountCost.toFixed(2)),
      订单合计: accountOrders,
      GMV合计: Number(accountRevenue.toFixed(2)),
      ROI: accountCost > 0 ? Number((accountRevenue / accountCost).toFixed(2)) : 0,
    })
  } catch (error) {
    errors.push(`${advertiserName}: ${error.message}`)
    logLine(`! 账户 ${advertiserName} 失败：${error.message}`)
  }
}

// --------------------------------------------------------------- write files
const activeSummary = summaryRows.filter((row) => row.消耗 > 0 || row.订单 > 0 || row.GMV > 0)
const totalCost = activeSummary.reduce((sum, row) => sum + row.消耗, 0)
const totalOrders = activeSummary.reduce((sum, row) => sum + row.订单, 0)
const totalRevenue = activeSummary.reduce((sum, row) => sum + row.GMV, 0)
const totals = {
  消耗合计: Number(totalCost.toFixed(2)),
  订单合计: totalOrders,
  GMV合计: Number(totalRevenue.toFixed(2)),
  ROI: totalCost > 0 ? Number((totalRevenue / totalCost).toFixed(2)) : 0,
  单均成本: totalOrders > 0 ? Number((totalCost / totalOrders).toFixed(2)) : 0,
}

// --------------------------------------------------- SKU sales (their sheet)
/**
 * Locate candidate `sku 销量情况*.xlsx` workbooks, newest first.
 * Excel lock files (`~$...`) are skipped.
 * @returns {string[]}
 */
function findSkuSalesWorkbooks() {
  const explicit = value('--sku-sales', '')
  if (explicit) return fs.existsSync(explicit) ? [explicit] : []
  const directories = [
    value('--sku-sales-dir', path.join(os.homedir(), 'Desktop', 'sku每日销量情况')),
    settings.dataDir,
  ]
  const candidates = []
  for (const directory of directories) {
    try {
      if (!fs.existsSync(directory)) continue
      for (const name of fs.readdirSync(directory)) {
        if (name.startsWith('~$') || name.startsWith('.')) continue
        if (!/\.xlsx$/i.test(name) || !/sku|销量/i.test(name)) continue
        const full = path.join(directory, name)
        candidates.push({ path: full, mtime: fs.statSync(full).mtimeMs })
      }
    } catch { /* next directory */ }
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates.map((entry) => entry.path)
}

/**
 * Extract per-SKU daily sales for the report range and normalise to long rows.
 * @returns {{ rows: Array<Record<string, unknown>>, availableDates: string[], dates: string[], source: string } | null}
 */
function loadSkuSales() {
  const workbooks = findSkuSalesWorkbooks()
  if (workbooks.length === 0) {
    logLine('未找到 SKU 销量表（可在 Desktop\\sku每日销量情况 放一份，或用 --sku-sales 指定）')
    return null
  }
  const python = findPythonForMap()
  const extractor = path.join(import.meta.dirname, 'build-sku-sales.py')
  if (!python || !fs.existsSync(extractor)) {
    logLine('SKU 销量表提取需要 Python+openpyxl，未找到可用解释器')
    return null
  }
  const dates = []
  const firstDay = parseDate(startText) || new Date(endDate.getTime() - (days - 1) * DAY_MS)
  for (let cursor = firstDay; cursor.getTime() <= endDate.getTime(); cursor = new Date(cursor.getTime() + DAY_MS)) {
    dates.push(formatDate(cursor))
  }
  const jsonPath = path.join(reportDir, 'sku-sales.json')
  for (const workbook of workbooks) {
    if (!fs.existsSync(workbook)) continue
    const result = spawnSync(python, [extractor, workbook, jsonPath, '--dates', dates.join(',')], { encoding: 'utf8' })
    const note = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-1)[0]
    if (result.status !== 0 || !fs.existsSync(jsonPath)) {
      logLine(`SKU 销量表跳过 ${path.basename(workbook)}：${note.slice(0, 140)}`)
      continue
    }
    logLine(`SKU 销量表：${path.basename(workbook)}（${note.slice(0, 120)}）`)
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      const rows = []
      for (const entry of parsed.rows || []) {
        for (const [date, metrics] of Object.entries(entry.daily || {})) {
          const qty = Number(metrics.qty) || 0
          const revenue = Number(metrics.revenueTaxIncl) || 0
          if (qty === 0 && revenue === 0) continue
          rows.push({
            日期: date,
            站点: entry.station || '',
            SKU: entry.sku,
            产品名称: entry.name || '',
            销量: qty,
            含税销售额: revenue,
            不含税销售额: Number(metrics.revenueTaxExcl) || 0,
            毛利: Number(metrics.profit) || 0,
            毛利率: Number(metrics.revenueTaxExcl) > 0 ? Number(((Number(metrics.profit) || 0) / Number(metrics.revenueTaxExcl)).toFixed(4)) : 0,
          })
        }
      }
      rows.sort((left, right) => (left.日期 === right.日期 ? right.销量 - left.销量 : left.日期.localeCompare(right.日期)))
      return { rows, availableDates: parsed.availableDates || [], dates: parsed.dates || [], source: workbook }
    } catch (error) {
      logLine(`SKU 销量表解析失败：${error.message}`)
    }
  }
  return null
}
const skuSales = loadSkuSales()

const payload = {
  generatedAt: new Date().toISOString(),
  range: { start: startText, end: endText, days },
  proxy: resolvedProxy.proxy ?? null,
  totals,
  accounts: accountRows,
  summary: summaryRows.sort((a, b) => b.消耗 - a.消耗),
  daily: dailyRows.sort((a, b) => (a.日期 === b.日期 ? b.消耗 - a.消耗 : a.日期.localeCompare(b.日期))),
  products: productRows.sort((a, b) => b.消耗 - a.消耗),
  productDaily: productDailyRows.sort((a, b) => (a.日期 === b.日期 ? b.消耗 - a.消耗 : a.日期.localeCompare(b.日期))),
  creatives: creativeRows.sort((a, b) => b.消耗 - a.消耗),
  skuSales: skuSales ? { source: skuSales.source, availableDates: skuSales.availableDates, dates: skuSales.dates, rows: skuSales.rows } : null,
  errors,
}
fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(payload, null, 2))

/** Minimal RFC4180 CSV writer. */
function writeCsv(file, rows, columns) {
  const escape = (cell) => {
    const text = cell === null || cell === undefined ? '' : String(cell)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(','))
  fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')
}
const dailyColumns = ['日期', '账户', '店铺', '推广系列ID', '推广系列', '消耗', '订单', 'GMV', 'ROI']
// Detail-only output: the campaign/account summary CSVs are intentionally not
// written (the operator only wants the 商品/素材 breakdown). Raw rows stay in report.json.
if (payload.daily.length) writeCsv(path.join(reportDir, '按天明细.csv'), payload.daily, dailyColumns)
if (payload.products.length) {
  writeCsv(path.join(reportDir, '商品明细.csv'), payload.products, ['账户', '店铺', '商品SPU', '商品名称', 'SKU', '消耗', '订单', 'GMV', 'ROI', '单均成本'])
}
if (payload.productDaily.length) {
  writeCsv(path.join(reportDir, '商品按天.csv'), payload.productDaily, ['日期', '账户', '店铺', '商品SPU', '商品名称', 'SKU', '消耗', '订单', 'GMV', 'ROI'])
}
if (payload.creatives.length) {
  writeCsv(path.join(reportDir, '素材明细.csv'), payload.creatives, ['账户', '店铺', '帖子ID', '帖子链接', '消耗', '订单', 'GMV', 'ROI', '商品曝光', '商品点击', '点击率'])
}
if (payload.skuSales?.rows?.length) {
  writeCsv(path.join(reportDir, 'SKU销量.csv'), payload.skuSales.rows, ['日期', '站点', 'SKU', '产品名称', '销量', '含税销售额', '不含税销售额', '毛利', '毛利率'])
}

// ------------------------------------------------------------------- xlsx
let xlsxPath = null
if (wantXlsx) {
  const builder = path.join(import.meta.dirname, 'build-xlsx.py')
  const python = findPython()
  if (python && fs.existsSync(builder)) {
    const args = [builder, reportDir]
    if (xlsxTarget) args.push(xlsxTarget)
    const result = spawnSync(python, args, { encoding: 'utf8' })
    if (result.status === 0) {
      xlsxPath = xlsxTarget || path.join(reportDir, `${path.basename(reportDir)}.xlsx`)
      logLine(`xlsx 已生成：${xlsxPath}`)
    } else {
      logLine(`xlsx 生成失败（CSV 仍可用）：${(result.stderr || result.stdout || '').slice(0, 400)}`)
    }
  } else {
    logLine('未找到可用 Python/openpyxl，跳过 xlsx（CSV 仍可用）')
  }
}

/**
 * Prefer the DSH runtime Python (ships openpyxl), then PATH.
 * @returns {string | null}
 */
function findPython() {
  const candidates = [
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python.exe',
    'python',
  ]
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import openpyxl'], { encoding: 'utf8' })
      if (probe.status === 0) return candidate
    } catch { /* try next */ }
  }
  return null
}

// ------------------------------------------------------------------ summary
logLine(`完成：汇总 ${activeSummary.length} 行，按天 ${payload.daily.length} 行，商品 ${payload.products.length} 行，素材 ${payload.creatives.length} 行，SKU 销量 ${payload.skuSales?.rows?.length ?? 0} 行`)
logLine(`合计：消耗 ${totals.消耗合计}，订单 ${totals.订单合计}，GMV ${totals.GMV合计}，ROI ${totals.ROI}，单均成本 ${totals.单均成本}`)
logLine(`输出目录：${reportDir}`)
if (errors.length) logLine(`警告 ${errors.length} 条：${errors.slice(0, 5).join(' | ')}`)
process.exit(errors.length ? 2 : 0)
