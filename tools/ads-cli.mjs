#!/usr/bin/env node
/**
 * ads-cli — 命令行入口（给任何能执行命令的 AI / 人用）
 *
 * 用法：
 *   node tools/ads-cli.mjs status
 *   node tools/ads-cli.mjs login                 # 生成授权链接（浏览器打开）
 *   node tools/ads-cli.mjs accounts              # 已授权广告账户 + GMV Max 店铺
 *   node tools/ads-cli.mjs tools --query report  # 检索工具目录
 *   node tools/ads-cli.mjs call campaign_get --args '{}' 
 *   node tools/ads-cli.mjs report --days 7       # GMV Max 汇总
 *   node tools/ads-cli.mjs campaigns --days 7    # 广告组明细
 *   node tools/ads-cli.mjs creatives --days 1    # 素材明细
 *   node tools/ads-cli.mjs export --start 2026-10-28 --end 2026-10-28 --out ./reports
 *   node tools/ads-cli.mjs panel --port 8795     # 启动可视化面板
 *
 * 所有命令默认输出 JSON（便于 AI 解析）；加 --pretty 输出缩进 JSON。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdsCore } from '../lib/core.js'
import { createShopClient } from '../lib/shop.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

const command = argv[0] || 'status'
const flags = {}
for (let index = 1; index < argv.length; index += 1) {
  const token = argv[index]
  if (!token.startsWith('--')) continue
  const key = token.slice(2)
  const next = argv[index + 1]
  if (next && !next.startsWith('--')) {
    flags[key] = next
    index += 1
  } else {
    flags[key] = true
  }
}

const pretty = Boolean(flags.pretty)
const emit = (value) => {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n')
}

const pad = (value) => String(value).padStart(2, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function resolveRange() {
  if (flags.start && flags.end) return { start: String(flags.start), end: String(flags.end) }
  const days = Math.max(1, Number(flags.days) || 1)
  const end = flags.today ? new Date() : new Date(Date.now() - (flags.yesterday ? 86_400_000 : 0))
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  return { start: formatDate(start), end: formatDate(end) }
}

const num = (value) => Number(value) || 0

async function main() {
  const core = createAdsCore({ log: (message) => { if (flags.verbose) process.stderr.write(`[ads] ${message}\n`) } })

  switch (command) {
    case 'status': {
      emit(core.status())
      return
    }
    case 'login': {
      const result = await core.beginLogin({ wait: flags.wait !== false, openBrowser: !flags['no-browser'] })
      if (result && result.url && !result.ok) emit(result)
      else if (result && result.url) emit({ ok: true, url: result.url, waiting: true, hint: '浏览器完成授权后令牌会自动保存；随后 `ads-cli status` 应显示已授权' })
      else emit(result)
      return
    }
    case 'tools': {
      const result = core.listTools(String(flags.query || ''), Number(flags.limit) || 25)
      emit({
        ok: true,
        total: result.total,
        matched: result.matched,
        count: result.tools.length,
        tools: result.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      })
      return
    }
    case 'call': {
      const toolName = String(flags.tool || argv[1] || '')
      if (!toolName) throw new Error('用法：ads-cli call <tool_name> --args \'{...}\'')
      const args = flags.args ? JSON.parse(String(flags.args)) : {}
      emit({ ok: true, tool: toolName, result: await core.callTool(toolName, args) })
      return
    }
    case 'accounts': {
      const authorized = (await core.callTool('auth_advertiser_get', {})).data?.list || []
      const accounts = []
      for (const account of authorized) {
        const advertiserId = String(account.advertiser_id)
        let stores = []
        try {
          stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
        } catch { /* 非 GMV Max 账户 */ }
        const gmvStores = stores.filter((store) => store.is_gmv_max_available === true)
        accounts.push({
          advertiserId,
          advertiserName: account.advertiser_name || advertiserId,
          gmvMaxStores: gmvStores.map((store) => ({ storeId: String(store.store_id), storeName: store.store_name })),
        })
      }
      emit({ ok: true, count: accounts.length, accounts })
      return
    }
    case 'report': {
      const range = resolveRange()
      const accounts = await activeAccounts(core)
      const rows = []
      for (const account of accounts) {
        const result = await core.callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost', 'orders', 'gross_revenue'],
          dimensions: ['campaign_id'],
          page_size: 500,
        })
        for (const row of result.data?.list || []) {
          rows.push({
            advertiserId: account.advertiserId,
            store: account.storeName,
            campaignId: String(row.dimensions?.campaign_id || ''),
            cost: num(row.metrics?.cost),
            orders: num(row.metrics?.orders),
            revenue: num(row.metrics?.gross_revenue),
          })
        }
      }
      const totals = rows.reduce((acc, row) => ({
        cost: acc.cost + row.cost,
        orders: acc.orders + row.orders,
        revenue: acc.revenue + row.revenue,
      }), { cost: 0, orders: 0, revenue: 0 })
      emit({
        ok: true,
        range,
        totals: {
          ...totals,
          roi: totals.cost ? Number((totals.revenue / totals.cost).toFixed(2)) : 0,
          costPerOrder: totals.orders ? Number((totals.cost / totals.orders).toFixed(2)) : 0,
        },
        campaigns: rows.sort((left, right) => right.cost - left.cost),
      })
      return
    }
    case 'campaigns': {
      const range = resolveRange()
      const accounts = await activeAccounts(core)
      const rows = []
      for (const account of accounts) {
        const result = await core.callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost', 'orders', 'gross_revenue'],
          dimensions: ['campaign_id'],
          page_size: 500,
        })
        for (const row of result.data?.list || []) {
          const cost = num(row.metrics?.cost)
          const revenue = num(row.metrics?.gross_revenue)
          rows.push({
            advertiserId: account.advertiserId,
            store: account.storeName,
            campaignId: String(row.dimensions?.campaign_id || ''),
            cost,
            orders: num(row.metrics?.orders),
            revenue,
            roi: cost ? Number((revenue / cost).toFixed(2)) : 0,
          })
        }
      }
      emit({ ok: true, range, count: rows.length, campaigns: rows.sort((left, right) => right.cost - left.cost) })
      return
    }
    case 'creatives': {
      const range = resolveRange()
      const accounts = await activeAccounts(core)
      const rows = []
      for (const account of accounts) {
        const campaignResult = await core.callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost'],
          dimensions: ['campaign_id'],
          page_size: 100,
        })
        const campaignIds = (campaignResult.data?.list || [])
          .filter((row) => num(row.metrics?.cost) > 0)
          .map((row) => String(row.dimensions?.campaign_id || ''))
          .filter(Boolean)
        if (!campaignIds.length) continue
        const spuResult = await core.callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost', 'orders'],
          dimensions: ['item_group_id'],
          filtering: { campaign_ids: campaignIds },
          page_size: 1000,
        })
        const spuIds = (spuResult.data?.list || [])
          .filter((row) => num(row.metrics?.cost) > 0 || num(row.metrics?.orders) > 0)
          .map((row) => String(row.dimensions?.item_group_id || ''))
          .filter(Boolean)
        if (!spuIds.length) continue
        const itemResult = await core.callTool('gmv_max_report_get', {
          advertiser_id: account.advertiserId,
          store_ids: [account.storeId],
          start_date: range.start,
          end_date: range.end,
          metrics: ['cost', 'orders', 'gross_revenue', 'product_clicks'],
          dimensions: ['item_id'],
          filtering: { campaign_ids: campaignIds, item_group_ids: spuIds },
          page_size: 1000,
        })
        for (const row of itemResult.data?.list || []) {
          const cost = num(row.metrics?.cost)
          const revenue = num(row.metrics?.gross_revenue)
          rows.push({
            advertiserId: account.advertiserId,
            store: account.storeName,
            itemId: String(row.dimensions?.item_id || ''),
            cost,
            orders: num(row.metrics?.orders),
            revenue,
            roi: cost ? Number((revenue / cost).toFixed(2)) : 0,
            clicks: num(row.metrics?.product_clicks),
          })
        }
      }
      emit({
        ok: true,
        range,
        count: rows.length,
        creatives: rows.filter((row) => row.itemId && row.itemId !== '-1').sort((left, right) => right.cost - left.cost),
      })
      return
    }
    case 'export': {
      const range = resolveRange()
      const outDir = String(flags.out || path.join(process.cwd(), 'reports'))
      const script = path.join(HERE, 'daily-report.mjs')
      const args = [script, '--start', range.start, '--end', range.end, '--per-day', '--flat', '--out', outDir]
      const result = await runNode(args)
      emit({ ok: result.code === 0, range, outDir, code: result.code, log: result.log.slice(-20) })
      return
    }
    case 'shop': {
      const shop = createShopClient()
      const action = String(flags.action || argv[1] || 'status')
      if (action === 'status') {
        emit({ ok: true, ...shop.status() })
        return
      }
      if (action === 'login') {
        const { url, state } = shop.authorizeUrl()
        emit({
          ok: true,
          url,
          state,
          steps: [
            '1) 用浏览器打开 url，登录并同意授权你的 TikTok Shop',
            '2) 授权后浏览器会跳到你在 Partner Center 配置的 redirect_uri，地址栏里有 code=XXXX',
            '3) 复制 code，运行：node tools/ads-cli.mjs shop token --code XXXX',
          ],
        })
        return
      }
      if (action === 'token') {
        const code = String(flags.code || '')
        if (!code) throw new Error('用法：ads-cli shop token --code <auth_code>')
        const record = await shop.exchangeAuthCode(code)
        emit({ ok: true, sellerName: record.sellerName, shopId: record.shopId, shopCipherSaved: Boolean(record.shopCipher), accessTokenExpireAt: record.accessTokenExpireAt })
        return
      }
      if (action === 'shops') {
        emit({ ok: true, result: await shop.authorizedShops() })
        return
      }
      if (action === 'products') {
        emit({ ok: true, result: await shop.searchProducts({ pageSize: Number(flags.limit) || 20, pageToken: String(flags.token || '') }) })
        return
      }
      if (action === 'orders') {
        emit({
          ok: true,
          result: await shop.searchOrders({
            createTimeFrom: flags.from ? Number(flags.from) : undefined,
            createTimeTo: flags.to ? Number(flags.to) : undefined,
            pageSize: Number(flags.limit) || 20,
            pageToken: String(flags.token || ''),
          }),
        })
        return
      }
      if (action === 'call') {
        const apiPath = String(flags.path || '')
        if (!apiPath) throw new Error('用法：ads-cli shop call --path /product/202309/products/search --method POST --body \'{}\'')
        const query = flags.query ? JSON.parse(String(flags.query)) : {}
        const body = flags.body ? JSON.parse(String(flags.body)) : null
        emit({ ok: true, result: await shop.request(apiPath, { method: String(flags.method || 'GET'), query, body }) })
        return
      }
      throw new Error(`未知 shop 子命令：${action}（可用 status/login/token/shops/products/orders/call）`)
    }
    case 'panel': {
      const port = Number(flags.port) || 8795
      const script = path.join(HERE, 'panel-preview.mjs')
      const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: 'inherit' })
      emit({ ok: true, url: `http://127.0.0.1:${port}/`, note: '面板在前台运行，Ctrl+C 退出' })
      child.on('exit', (code) => process.exit(code || 0))
      return
    }
    default: {
      emit({ ok: false, error: `未知命令：${command}`, commands: ['status', 'login', 'accounts', 'tools', 'call', 'report', 'campaigns', 'creatives', 'export', 'panel'] })
      process.exitCode = 2
    }
  }
}

/** 拉一遍可用的 GMV Max 账户（带店铺） */
async function activeAccounts(core) {
  const authorized = (await core.callTool('auth_advertiser_get', {})).data?.list || []
  // --advertiserId / --advertiser-id 只取指定账户
  const wanted = flags.advertiserId || flags['advertiser-id'] || ''
  const accounts = []
  for (const account of authorized) {
    const advertiserId = String(account.advertiser_id)
    if (wanted && advertiserId !== String(wanted)) continue
    try {
      const stores = (await core.callTool('gmv_max_store_list_get', { advertiser_id: advertiserId })).data?.store_list || []
      const store = stores.find((row) => row.is_gmv_max_available === true)
      if (!store) continue
      accounts.push({
        advertiserId,
        advertiserName: account.advertiser_name || advertiserId,
        storeId: String(store.store_id),
        storeName: store.store_name || String(store.store_id),
      })
    } catch { /* skip */ }
  }
  return accounts
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true })
    const log = []
    child.stdout.on('data', (chunk) => log.push(String(chunk).trim()))
    child.stderr.on('data', (chunk) => log.push(String(chunk).trim()))
    child.on('error', (error) => resolve({ code: 1, log: [error.message] }))
    child.on('close', (code) => resolve({ code, log }))
  })
}

main().catch((error) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
