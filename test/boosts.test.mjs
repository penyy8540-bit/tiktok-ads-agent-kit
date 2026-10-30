import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBoosts, hoursOf, hoursForDate, describeRecord, windowStats } from '../lib/boosts.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boosts-test-'))

test('hoursOf expands a half-open hour range and clamps to 0..23', () => {
  assert.deepEqual([...hoursOf({ startHour: 16, endHour: 20 })], [16, 17, 18, 19])
  assert.deepEqual([...hoursOf({ startHour: 22, endHour: 24 })], [22, 23])
  assert.deepEqual([...hoursOf({ startHour: 5, endHour: 5 })], [])
  // 越界输入直接视为无效（而不是悄悄裁剪），避免把错误时间段画到曲线上\n  assert.deepEqual([...hoursOf({ startHour: -1, endHour: 2 })], [])
  assert.deepEqual([...hoursOf(null)], [])
})

test('hoursForDate only counts records of that date', () => {
  const records = [
    { date: '2026-10-30', startHour: 16, endHour: 18 },
    { date: '2026-10-30', startHour: 20, endHour: 22 },
    { date: '2026-10-29', startHour: 8, endHour: 10 },
  ]
  assert.deepEqual([...hoursForDate(records, '2026-10-30')].sort((a, b) => a - b), [16, 17, 20, 21])
  assert.equal(hoursForDate(records, '2026-10-28').size, 0)
})

test('describeRecord renders a readable range with note', () => {
  assert.equal(describeRecord({ startHour: 16, endHour: 20, note: '加预算' }), '16:00-20:00 加预算')
  assert.equal(describeRecord({ startHour: 9, endHour: 10 }), '09:00-10:00')
})

test('windowStats compares the boosted window with the same length before it', () => {
  const points = []
  for (let hour = 0; hour < 24; hour += 1) {
    points.push({ hour: String(hour).padStart(2, '0') + ':00', cost: hour >= 16 && hour < 20 ? 10 : 2, orders: hour >= 16 && hour < 20 ? 2 : 0, revenue: hour >= 16 && hour < 20 ? 100 : 0 })
  }
  const stats = windowStats(points, { startHour: 16, endHour: 20 })
  assert.equal(stats.during.cost, 40)
  assert.equal(stats.during.orders, 8)
  assert.equal(stats.during.roi, 10)
  assert.equal(stats.before.cost, 8) // 12..16 每小時 2
  assert.equal(stats.before.roi, 0)
})

test('store persists records and links, and validates input', () => {
  const dir = tmpDir()
  const store = createBoosts({ dataDir: dir })

  const record = store.add({ itemId: 'item-1', date: '2026-10-30', startHour: 16, endHour: 20, note: '加预算 20%' })
  assert.equal(record.itemId, 'item-1')
  assert.throws(() => store.add({ itemId: 'item-1', date: '2026/10/30', startHour: 16, endHour: 20 }), /日期/)
  assert.throws(() => store.add({ itemId: 'item-1', date: '2026-10-30', startHour: 20, endHour: 16 }), /结束小时/)
  assert.throws(() => store.add({ itemId: 'item-1', date: '2026-10-30', startHour: 25, endHour: 26 }), /小时/)
  assert.throws(() => store.add({ date: '2026-10-30', startHour: 1, endHour: 2 }), /素材 ID/)

  store.setLink('item-1', 'https://www.tiktok.com/@shop/video/123')
  assert.equal(store.getLink('item-1'), 'https://www.tiktok.com/@shop/video/123')
  assert.throws(() => store.setLink('item-1', 'javascript:alert(1)'), /http/)

  // 重新打开同一目录，数据仍在
  const reopened = createBoosts({ dataDir: dir })
  const list = reopened.list()
  assert.equal(list.records.length, 1)
  assert.equal(list.links['item-1'], 'https://www.tiktok.com/@shop/video/123')

  assert.deepEqual(reopened.remove(record.id), { ok: true, removed: 1 })
  assert.equal(reopened.list().records.length, 0)
  assert.deepEqual(reopened.remove('nope'), { ok: false, removed: 0 })
})

test('setLink with empty value clears the link', () => {
  const dir = tmpDir()
  const store = createBoosts({ dataDir: dir })
  store.setLink('item-2', 'https://example.com/x')
  store.setLink('item-2', '')
  assert.equal(store.getLink('item-2'), '')
  assert.equal(store.list().links['item-2'], undefined)
})
