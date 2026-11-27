import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateSkuSales } from '../lib/sku-sales.js'

const lookup = (spu) => ({
  '111': { sku: 'SOM001UK', name: 'Grater' },
  '222': { sku: 'KCA0098UK', name: 'Bread Maker' },
}[spu])

test('aggregates SPU rows into SKU rows with shares', () => {
  const result = aggregateSkuSales([
    { spu: '111', cost: 60, orders: 6, revenue: 600, clicks: 30, impressions: 1000 },
    { spu: '222', cost: 40, orders: 4, revenue: 200, clicks: 10, impressions: 500 },
  ], lookup)
  assert.equal(result.rows.length, 2)
  const som = result.rows.find((row) => row.sku === 'SOM001UK')
  assert.equal(som.cost, 60)
  assert.equal(som.roi, 10)
  assert.equal(som.cpo, 10)
  assert.equal(som.costShare, 60)
  assert.equal(som.orderShare, 60)
  assert.equal(som.ctr, 3)
  assert.equal(result.totals.cost, 100)
  assert.equal(result.totals.orders, 10)
  assert.equal(result.totals.roi, 8)
  assert.equal(result.totals.skuCount, 2)
  // 按订单降序
  assert.equal(result.rows[0].orders, 6)
})

test('rows without product mapping are kept as 未映射 instead of dropped', () => {
  const result = aggregateSkuSales([
    { spu: '999', cost: 12, orders: 2, revenue: 30 },
  ], lookup)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].mapped, false)
  assert.equal(result.rows[0].sku, '')
  assert.equal(result.totals.unmappedCount, 1)
  assert.equal(result.totals.skuCount, 0)
  assert.equal(result.totals.cost, 12)
})

test('merges multiple SPU rows that map to the same SKU', () => {
  const dup = (spu) => ({ sku: 'SAME', name: 'Same product' })
  const result = aggregateSkuSales([
    { spu: '1', cost: 10, orders: 1, revenue: 100 },
    { spu: '2', cost: 5, orders: 2, revenue: 50 },
  ], dup)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].cost, 15)
  assert.equal(result.rows[0].orders, 3)
  assert.equal(result.rows[0].roi, 10)
})

test('skips empty rows and handles zero division safely', () => {
  const result = aggregateSkuSales([
    { spu: '111', cost: 0, orders: 0, revenue: 0 },
    { spu: '', cost: 10, orders: 1, revenue: 20 },
    { spu: '222', cost: 0, orders: 0, revenue: 0 },
  ], lookup)
  assert.equal(result.rows.length, 0)
  assert.equal(result.totals.cost, 0)
  assert.equal(result.totals.roi, 0)
  assert.equal(result.totals.cpo, 0)
})
