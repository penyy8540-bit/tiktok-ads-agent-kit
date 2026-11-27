/**
 * SKU 销售汇总（纯函数，独立成模块方便单测）。
 *
 * 输入是 item_group_id（SPU）级的广告报表行，输出是按 SKU 聚合的销售 + 广告消耗表。
 * 一条 SPU 可能对应多个 SKU（多规格），但 TikTok 报表只到 SPU，这里按商品表映射到的
 * SKU 归组；映射不到的商品进「未映射」分组，不会被丢掉。
 */

/**
 * @param {Array<{ spu: string, cost?: number, orders?: number, revenue?: number, clicks?: number, impressions?: number }>} rows
 * @param {(spu: string) => { sku?: string, name?: string } | undefined} [lookup]
 */
export function aggregateSkuSales(rows, lookup) {
  const buckets = new Map()
  for (const row of rows || []) {
    const spu = String((row && row.spu) || '')
    if (!spu) continue
    const cost = Number(row.cost) || 0
    const orders = Number(row.orders) || 0
    const revenue = Number(row.revenue) || 0
    if (cost === 0 && orders === 0 && revenue === 0) continue
    const product = (lookup && lookup(spu)) || {}
    const sku = String(product.sku || '').trim()
    const key = sku || `未映射:${spu}`
    const bucket = buckets.get(key) || {
      sku,
      spu,
      name: String(product.name || ''),
      mapped: Boolean(sku),
      cost: 0,
      orders: 0,
      revenue: 0,
      clicks: 0,
      impressions: 0,
    }
    bucket.cost += cost
    bucket.orders += orders
    bucket.revenue += revenue
    bucket.clicks += Number(row.clicks) || 0
    bucket.impressions += Number(row.impressions) || 0
    buckets.set(key, bucket)
  }

  const list = [...buckets.values()].map((bucket) => ({
    sku: bucket.sku,
    spu: bucket.spu,
    name: bucket.name,
    mapped: bucket.mapped,
    cost: round2(bucket.cost),
    orders: bucket.orders,
    revenue: round2(bucket.revenue),
    roi: bucket.cost > 0 ? round2(bucket.revenue / bucket.cost) : 0,
    cpo: bucket.orders > 0 ? round2(bucket.cost / bucket.orders) : 0,
    clicks: bucket.clicks,
    impressions: bucket.impressions,
    ctr: bucket.impressions > 0 ? round2((bucket.clicks / bucket.impressions) * 100) : 0,
  }))

  list.sort((left, right) => right.orders - left.orders || right.cost - left.cost)

  const totals = list.reduce(
    (acc, item) => ({
      cost: acc.cost + item.cost,
      orders: acc.orders + item.orders,
      revenue: acc.revenue + item.revenue,
      clicks: acc.clicks + item.clicks,
      impressions: acc.impressions + item.impressions,
    }),
    { cost: 0, orders: 0, revenue: 0, clicks: 0, impressions: 0 },
  )

  for (const item of list) {
    item.costShare = totals.cost > 0 ? round2((item.cost / totals.cost) * 100) : 0
    item.orderShare = totals.orders > 0 ? round2((item.orders / totals.orders) * 100) : 0
  }

  return {
    rows: list,
    totals: {
      skuCount: list.filter((item) => item.mapped).length,
      unmappedCount: list.filter((item) => !item.mapped).length,
      cost: round2(totals.cost),
      orders: totals.orders,
      revenue: round2(totals.revenue),
      roi: totals.cost > 0 ? round2(totals.revenue / totals.cost) : 0,
      cpo: totals.orders > 0 ? round2(totals.cost / totals.orders) : 0,
      ctr: totals.impressions > 0 ? round2((totals.clicks / totals.impressions) * 100) : 0,
    },
  }
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2))
}
