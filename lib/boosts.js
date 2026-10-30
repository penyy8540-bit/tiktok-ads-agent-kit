/**
 * 素材加热记录 + 视频进入链接。
 *
 * 加热（boost）是运营手动操作的记录：某天某小时段给某个素材加预算/加热，
 * 用来和「加热前后表现」对比。这里只存事实，不做任何广告后台调用。
 *
 * 存储：dataDir/boosts.json
 *   { records: [{ id, itemId, date, startHour, endHour, note, createdAt }],
 *     links: { [itemId]: url } }
 *
 * 小时按**曲线上的小时标注**记录（面板会按所选时区展示），因此这里只做
 * 数值校验与统计，不做时区换算。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'boosts.json'
const MAX_RECORDS = 500

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
const clampHour = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const hour = Math.trunc(number)
  return hour >= 0 && hour <= 24 ? hour : null
}

/** 某条加热记录覆盖的小时集合（0..23），用于曲线加粗与「加热中」判断 */
export function hoursOf(record) {
  const hours = new Set()
  if (!record) return hours
  const start = clampHour(record.startHour)
  const end = clampHour(record.endHour)
  if (start === null || end === null) return hours
  for (let hour = start; hour < end; hour += 1) {
    if (hour >= 0 && hour <= 23) hours.add(hour)
  }
  return hours
}

/** 一组记录在某一天覆盖的小时集合 */
export function hoursForDate(records, date) {
  const hours = new Set()
  for (const record of records || []) {
    if (record.date !== date) continue
    for (const hour of hoursOf(record)) hours.add(hour)
  }
  return hours
}

/** 记录完整说明，例如 "16:00-20:00 加预算" */
export function describeRecord(record) {
  const pad = (value) => String(value).padStart(2, '0')
  const range = `${pad(record.startHour)}:00-${pad(record.endHour)}:00`
  return record.note ? `${range} ${record.note}` : range
}

/**
 * 加热时间段 vs 之前同样长度的时间段的表现对比。
 * @param {Array<{hour?:string,cost?:number,orders?:number,revenue?:number}>} points 按小时的点
 * @param {{startHour:number,endHour:number}} record
 */
export function windowStats(points, record) {
  const sum = (list) => list.reduce((acc, point) => ({
    cost: acc.cost + (Number(point.cost) || 0),
    orders: acc.orders + (Number(point.orders) || 0),
    revenue: acc.revenue + (Number(point.revenue) || 0),
  }), { cost: 0, orders: 0, revenue: 0 })
  const hourOf = (point) => Number(String(point.hour || '').slice(0, 2))
  const start = clampHour(record.startHour) ?? 0
  const end = clampHour(record.endHour) ?? 0
  const during = (points || []).filter((point) => {
    const hour = hourOf(point)
    return Number.isFinite(hour) && hour >= start && hour < end
  })
  const length = Math.max(0, end - start)
  const beforeStart = Math.max(0, start - length)
  const before = (points || []).filter((point) => {
    const hour = hourOf(point)
    return Number.isFinite(hour) && hour >= beforeStart && hour < start
  })
  const duringSum = sum(during)
  const beforeSum = sum(before)
  const roi = (value) => (value.cost > 0 ? Number((value.revenue / value.cost).toFixed(2)) : 0)
  return {
    during: { ...duringSum, roi: roi(duringSum) },
    before: { ...beforeSum, roi: roi(beforeSum) },
  }
}

export function createBoosts({ dataDir, log = () => {} }) {
  const file = path.join(dataDir, FILE)
  let state = { records: [], links: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    state = {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {},
    }
  } catch { /* first run */ }

  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify(state, null, 2))
    } catch (error) {
      log(`加热记录保存失败：${error.message}`)
    }
  }

  return {
    /** 全部记录 + 链接 */
    list() {
      return {
        records: [...state.records].sort((left, right) => (left.date + String(left.startHour).padStart(2, '0')).localeCompare(right.date + String(right.startHour).padStart(2, '0'))),
        links: { ...state.links },
      }
    },
    /** 新增一条加热记录 */
    add({ itemId, campaignId = '', advertiserId = '', date, startHour, endHour, note = '' }) {
      const id = String(itemId || '').trim()
      if (!id) throw new Error('缺少素材 ID')
      if (!isDate(date)) throw new Error('日期格式应为 YYYY-MM-DD')
      const start = clampHour(startHour)
      const end = clampHour(endHour)
      if (start === null || end === null) throw new Error('小时必须在 0-24 之间')
      if (end <= start) throw new Error('结束小时必须大于开始小时')
      const record = {
        id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        itemId: id,
        campaignId: String(campaignId || ''),
        advertiserId: String(advertiserId || ''),
        date,
        startHour: start,
        endHour: end,
        note: String(note || '').slice(0, 60),
        createdAt: new Date().toISOString(),
      }
      state.records.push(record)
      if (state.records.length > MAX_RECORDS) state.records = state.records.slice(-MAX_RECORDS)
      save()
      return record
    },
    /** 删除一条记录 */
    remove(recordId) {
      const before = state.records.length
      state.records = state.records.filter((record) => record.id !== recordId)
      if (state.records.length === before) return { ok: false, removed: 0 }
      save()
      return { ok: true, removed: 1 }
    },
    /** 记录素材的视频进入链接 */
    setLink(itemId, url) {
      const id = String(itemId || '').trim()
      if (!id) throw new Error('缺少素材 ID')
      const value = String(url || '').trim()
      if (value && !/^https?:\/\//i.test(value)) throw new Error('链接必须以 http(s):// 开头')
      if (value) state.links[id] = value.slice(0, 500)
      else delete state.links[id]
      save()
      return { ok: true, itemId: id, url: value }
    },
    getLink(itemId) {
      return state.links[String(itemId || '')] || ''
    },
  }
}
