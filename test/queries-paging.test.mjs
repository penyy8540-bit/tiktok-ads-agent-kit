import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchReportRows, REPORT_PAGE_SIZE } from '../lib/queries.js'

/** 造一个按 page 返回分页数据的假 core */
function pagedCore({ total, pageSizePerCall, withPageInfo = true, listBuilder }) {
  const calls = []
  return {
    calls,
    async callTool(name, params) {
      assert.equal(name, 'gmv_max_report_get')
      calls.push(params)
      const page = Number(params.page) || 1
      const size = Number(params.page_size) || REPORT_PAGE_SIZE
      const start = (page - 1) * size
      const rows = (listBuilder ? listBuilder(page, size) : Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, index) => ({ id: start + index })))
      return {
        code: 0,
        data: {
          ...(withPageInfo
            ? { page_info: { page, page_size: size, total_number: total, total_page: Math.max(1, Math.ceil(total / size)) } }
            : {}),
          list: rows,
        },
      }
    },
  }
}

test('fetchReportRows walks every page until total_page is reached', async () => {
  const core = pagedCore({ total: 25, pageSizePerCall: 10 })
  const result = await fetchReportRows(core, { advertiser_id: '1' }, { pageSize: 10 })
  assert.equal(result.rows.length, 25)
  assert.equal(result.pages, 3)
  assert.equal(result.truncated, false)
  assert.equal(core.calls.length, 3)
  assert.deepEqual(core.calls.map((call) => call.page), [1, 2, 3])
  assert.deepEqual(core.calls.map((call) => call.page_size), [10, 10, 10])
})

test('fetchReportRows stops when the row count reaches total_number even without total_page', async () => {
  const core = {
    calls: [],
    async callTool(_name, params) {
      this.calls.push(params)
      const page = Number(params.page)
      const rows = page === 1 ? Array.from({ length: 4 }, (_, i) => ({ id: i })) : Array.from({ length: 2 }, (_, i) => ({ id: 4 + i }))
      return { data: { page_info: { total_number: 6 }, list: rows } }
    },
  }
  const result = await fetchReportRows(core, {}, { pageSize: 4 })
  assert.equal(result.rows.length, 6)
  assert.equal(result.truncated, false)
  assert.equal(core.calls.length, 2)
})

test('fetchReportRows flags truncation when the API returns no paging info and a full page', async () => {
  const core = pagedCore({ total: 999, pageSizePerCall: 10, withPageInfo: false, listBuilder: (_page, size) => Array.from({ length: size }, (_, i) => ({ id: i })) })
  const result = await fetchReportRows(core, {}, { pageSize: 10 })
  assert.equal(result.rows.length, 10)
  assert.equal(result.truncated, true)
  assert.match(result.warning, /分页信息/)
})

test('fetchReportRows marks truncation when paging info promises more but a page is empty', async () => {
  const core = {
    calls: [],
    async callTool(_name, params) {
      this.calls.push(params)
      const page = Number(params.page)
      return {
        data: {
          page_info: { page, page_size: 10, total_number: 30, total_page: 3 },
          list: page === 1 ? Array.from({ length: 10 }, (_, i) => ({ id: i })) : [],
        },
      }
    },
  }
  const result = await fetchReportRows(core, {}, { pageSize: 10 })
  assert.equal(result.rows.length, 10)
  assert.equal(result.truncated, true)
  assert.match(result.warning, /空/)
})

test('fetchReportRows respects maxPages as a safety net', async () => {
  const core = pagedCore({ total: 1000, pageSizePerCall: 10 })
  const result = await fetchReportRows(core, {}, { pageSize: 10, maxPages: 3 })
  assert.equal(result.pages, 3)
  assert.equal(result.truncated, true)
  assert.match(result.warning, /上限/)
})
