/**
 * Seller Center product import.
 *
 * 用户从卖家中心导出「商品批量编辑 / 全部信息」Excel，上传到这里：
 *  1. 原文件存到 plugin-data/product-imports/
 *  2. 调 tools/parse-product-export.py 解析成 JSON（product_id / seller_sku / 名称 / 价格 / 状态 / 类目）
 *  3. 同步写一份 sku-map-cache CSV，让插件全局的 productLookup（SPU→SKU）立刻生效
 *  4. 提供「商品 × 广告」合并视图：用 SPU(item_group_id) 把广告消耗/订单挂到商品上
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const IMPORT_DIR = 'product-imports'
const PYTHON_CANDIDATES = [
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  'python',
  'python3',
]

const runParser = (python, script, source, target) =>
  new Promise((resolve) => {
    const child = spawn(python, ['-X', 'utf8', script, source, target], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: stderr.trim() || `解析进程退出码 ${code}` })
      try {
        resolve({ ok: true, result: JSON.parse(stdout.trim().split('\n').pop()) })
      } catch {
        resolve({ ok: true, result: { ok: true } })
      }
    })
  })

export function createProducts({ dataDir, log = () => {} }) {
  const importDir = path.join(dataDir, IMPORT_DIR)
  const scriptPath = fileURLToPath(new URL('../tools/parse-product-export.py', import.meta.url))

  const ensureDir = () => {
    fs.mkdirSync(importDir, { recursive: true, mode: 0o700 })
    return importDir
  }

  /** 最近一次导入的全部商品（从最新的 JSON 读） */
  const readLatest = () => {
    try {
      const files = fs.readdirSync(importDir).filter((name) => name.endsWith('.json')).sort().reverse()
      for (const name of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(importDir, name), 'utf8'))
        if (parsed && Array.isArray(parsed.products)) return { ...parsed, file: name }
      }
    } catch { /* none */ }
    return null
  }

  /** 把导入的商品写成 sku-map-cache CSV，让全局 productLookup 生效 */
  const writeSkuMap = (region, products) => {
    try {
      const cacheDir = path.join(dataDir, 'sku-map-cache')
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const file = path.join(cacheDir, `${region || 'GB'}-import-${stamp}.csv`)
      const header = 'product_id,seller_sku,product_name\n'
      const lines = products
        .filter((row) => row.productId)
        .map((row) => [row.productId, row.sellerSku || '', row.name || ''].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      fs.writeFileSync(file, header + lines.join('\n'))
      return file
    } catch (error) {
      log(`商品导入：写 SKU 映射失败 ${error.message}`)
      return null
    }
  }

  return {
    /** 导入一个 xlsx / csv（base64） */
    async import(base64, { fileName = 'products.xlsx', region = 'GB' } = {}) {
      const dir = ensureDir()
      const safeName = String(fileName).replace(/[^\w.\-]+/g, '_').slice(-80)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const sourceFile = path.join(dir, `${stamp}-${safeName}`)
      fs.writeFileSync(sourceFile, Buffer.from(base64, 'base64'))
      const targetFile = sourceFile.replace(/\.(xlsx|csv)$/i, '') + '.parsed.json'

      let parsedResult = null
      for (const python of PYTHON_CANDIDATES) {
        const attempt = await runParser(python, scriptPath, sourceFile, targetFile)
        if (attempt.ok) {
          parsedResult = attempt.result
          break
        }
        log(`商品导入：用 ${python} 解析失败：${attempt.error}`)
      }
      if (!parsedResult) return { ok: false, error: '解析失败：没有可用的 Python 环境' }
      let parsed = null
      try {
        parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'))
      } catch (error) {
        return { ok: false, error: `解析结果读取失败：${error.message}` }
      }
      const products = parsed.products || []
      const meta = {
        ok: true,
        fileName: safeName,
        region,
        importedAt: new Date().toISOString(),
        headerRow: parsed.headerRow,
        count: products.length,
        withProductId: products.filter((row) => row.productId).length,
        withSellerSku: products.filter((row) => row.sellerSku).length,
        skuMapFile: writeSkuMap(region, products),
        products,
      }
      fs.writeFileSync(targetFile, JSON.stringify(meta, null, 2))
      return {
        ok: true,
        count: meta.count,
        withProductId: meta.withProductId,
        withSellerSku: meta.withSellerSku,
        headerRow: meta.headerRow,
        skuMapFile: meta.skuMapFile,
        importedAt: meta.importedAt,
        region,
        fileName: safeName,
      }
    },

    /** 导入历史 + 当前商品 */
    list() {
      const latest = readLatest()
      let history = []
      try {
        history = fs.readdirSync(importDir)
          .filter((name) => name.endsWith('.parsed.json'))
          .sort()
          .reverse()
          .slice(0, 10)
          .map((name) => {
            const stat = fs.statSync(path.join(importDir, name))
            return { name, size: stat.size, at: stat.mtime.toISOString() }
          })
      } catch { /* none */ }
      return {
        hasData: Boolean(latest),
        importedAt: latest?.importedAt || null,
        region: latest?.region || null,
        fileName: latest?.fileName || null,
        headerRow: latest?.headerRow || null,
        count: latest?.products?.length || 0,
        products: (latest?.products || []).slice(0, 2000),
        history,
      }
    },

    /**
     * 商品 × 广告：按 SPU(product_id) 合并广告消耗/订单/GMV。
     * @param {{ days?: number, today?: boolean, start?: string, end?: string }} query
     * @param {string[]} accountIds
     * @param {(name: string, params: object) => Promise<any>} callTool
     * @param {Array<{ advertiserId: string, storeId: string, storeName: string }>} accounts
     */
    async joinWithAds(query, accounts, callTool, resolveRange) {
      const latest = readLatest()
      if (!latest) return { ok: false, error: '还没有导入商品，请先上传卖家中心导出的商品表' }
      const range = resolveRange(query)
      const bySpu = new Map()
      for (const account of accounts) {
        try {
          // item_group_id 报表必须带 campaign_ids 锚点，否则 TikTok 会报错返回空
          const campaignReport = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost'],
            dimensions: ['campaign_id'],
            page_size: 200,
          })
          const campaignIds = (campaignReport.data?.list || [])
            .filter((row) => Number(row.metrics?.cost) > 0)
            .map((row) => String(row.dimensions?.campaign_id || ''))
            .filter(Boolean)
          if (!campaignIds.length) continue
          const report = await callTool('gmv_max_report_get', {
            advertiser_id: account.advertiserId,
            store_ids: [account.storeId],
            start_date: range.start,
            end_date: range.end,
            metrics: ['cost', 'orders', 'gross_revenue'],
            dimensions: ['item_group_id'],
            filtering: { campaign_ids: campaignIds },
            page_size: 1000,
          })
          for (const row of report.data?.list || []) {
            const spu = String(row.dimensions?.item_group_id || '')
            if (!spu) continue
            const bucket = bySpu.get(spu) || { cost: 0, orders: 0, revenue: 0 }
            bucket.cost += Number(row.metrics?.cost) || 0
            bucket.orders += Number(row.metrics?.orders) || 0
            bucket.revenue += Number(row.metrics?.gross_revenue) || 0
            bySpu.set(spu, bucket)
          }
        } catch (error) {
          log(`商品×广告：${account.storeName} 拉取失败 ${error.message}`)
        }
      }
      const rows = (latest.products || []).map((product) => {
        const ad = bySpu.get(String(product.productId)) || { cost: 0, orders: 0, revenue: 0 }
        return {
          ...product,
          cost: Number(ad.cost.toFixed(2)),
          orders: ad.orders,
          revenue: Number(ad.revenue.toFixed(2)),
          roi: ad.cost > 0 ? Number((ad.revenue / ad.cost).toFixed(2)) : 0,
        }
      })
      rows.sort((left, right) => right.cost - left.cost)
      return {
        ok: true,
        range,
        importedAt: latest.importedAt,
        total: rows.length,
        matched: rows.filter((row) => row.cost > 0 || row.orders > 0).length,
        products: rows,
      }
    },
  }
}
