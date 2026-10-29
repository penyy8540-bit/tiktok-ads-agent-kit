import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readCache,
  renderToolLines,
  scoreTool,
  searchTools,
  suggestToolNames,
  termsOf,
  writeCache,
} from '../lib/registry.js'

const TOOLS = [
  { name: 'campaign_get', description: 'Get campaign details' },
  { name: 'campaign_list', description: 'List campaigns in an advertiser account' },
  { name: 'adgroup_create', description: 'Create an ad group' },
  { name: 'report_get', description: 'Fetch performance report metrics' },
  { name: 'audience_list', description: 'List custom audiences' },
]

test('termsOf splits on common separators and lowercases', () => {
  assert.deepEqual(termsOf('  Campaign, Report  广告 '), ['campaign', 'report', '广告'])
  assert.deepEqual(termsOf(undefined), [])
})

test('scoreTool ranks exact > prefix > contains and rejects misses', () => {
  assert.ok(scoreTool(TOOLS[0], ['campaign_get']) > scoreTool(TOOLS[1], ['campaign']))
  assert.equal(scoreTool(TOOLS[3], ['campaign']), 0)
})

test('searchTools ranks matching tools and paginates', () => {
  const result = searchTools(TOOLS, { query: 'campaign' })
  assert.equal(result.matchedCount, 2)
  assert.equal(result.total, 5)
  assert.equal(result.tools[0].name, 'campaign_get')

  const page = searchTools(TOOLS, { query: 'campaign', limit: 1, offset: 1 })
  assert.equal(page.tools.length, 1)
  assert.equal(page.tools[0].name, 'campaign_list')
})

test('searchTools without a query keeps catalog order and caps the limit', () => {
  const result = searchTools(TOOLS, { limit: 1000 })
  assert.equal(result.tools.length, TOOLS.length)
  assert.equal(result.limit, 100)
})

test('renderToolLines clips long descriptions and keeps names', () => {
  const lines = renderToolLines([{ name: 'x', description: 'a'.repeat(500) }])
  assert.equal(lines.length, 1)
  assert.ok(lines[0].startsWith('- x: '))
  assert.ok(lines[0].endsWith('…'))
})

test('suggestToolNames finds similar names and returns empty for noise', () => {
  const suggested = suggestToolNames(TOOLS, 'campaign_ge')
  assert.ok(suggested.includes('campaign_get'))
  assert.deepEqual(suggestToolNames(TOOLS, 'zzz'), [])
})

test('cache round-trips per resource and ignores other resources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-cache-'))
  const resource = 'https://example.test/mcp'
  assert.equal(readCache(dir, resource), null)
  writeCache(dir, { resource, syncedAt: 123, tools: TOOLS })
  const cached = readCache(dir, resource)
  assert.equal(cached.tools.length, TOOLS.length)
  assert.equal(cached.syncedAt, 123)
  assert.equal(readCache(dir, 'https://other.test/mcp'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})
