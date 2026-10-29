import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { MODES, dataDir, dshHome, normalizeConfig, readWindowsSystemProxy, resolveProxy } from '../lib/config.js'

test('defaults target the layer endpoint with meta exposure', () => {
  const config = normalizeConfig()
  assert.equal(config.mode, 'layer')
  assert.equal(config.resourceUrl, MODES.layer)
  assert.equal(config.expose, 'meta')
  assert.equal(config.proxySetting, 'auto')
  assert.equal(config.callbackPort, 43113)
  assert.equal(config.oauthScopes, 'mcp:tt4b')
})

test('flat mode switches the resource URL', () => {
  const config = normalizeConfig({ mode: 'flat' })
  assert.equal(config.resourceUrl, MODES.flat)
})

test('invalid enum values fail loudly instead of silently defaulting', () => {
  assert.throws(() => normalizeConfig({ mode: 'turbo' }), /mode/)
  assert.throws(() => normalizeConfig({ expose: 'everything' }), /expose/)
})

test('numeric fields are clamped into a safe range', () => {
  const config = normalizeConfig({ callbackPort: 10, requestTimeoutMs: 1, toolCallTimeoutMs: 10_000_000 })
  assert.equal(config.callbackPort, 1024)
  assert.equal(config.requestTimeoutMs, 5000)
  assert.equal(config.toolCallTimeoutMs, 900_000)
})

test('expose=all has a bounded tool ceiling', () => {
  assert.equal(normalizeConfig().maxExposeAll, 100)
  assert.equal(normalizeConfig({ maxExposeAll: 5 }).maxExposeAll, 5)
  assert.equal(normalizeConfig({ maxExposeAll: 99_999 }).maxExposeAll, 400)
  assert.equal(normalizeConfig({ maxExposeAll: 0 }).maxExposeAll, 1)
})

test('dataDir resolves under DSH_HOME and honours an override', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-test')
  try {
    assert.equal(dshHome(), path.join(os.tmpdir(), 'dsh-home-test'))
    assert.equal(dataDir({}), path.join(os.tmpdir(), 'dsh-home-test', 'plugin-data', 'tiktok-ads'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(dataDir({ dataDir: '/tmp/custom' }), '/tmp/custom')
})

test('resolveProxy honours off, explicit values and env fallback order', () => {
  const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy }
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  try {
    assert.deepEqual(resolveProxy('off'), { proxy: null, source: 'config-off' })
    assert.deepEqual(resolveProxy('http://127.0.0.1:7890'), { proxy: 'http://127.0.0.1:7890', source: 'config' })
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1081'
    assert.deepEqual(resolveProxy('auto'), { proxy: 'http://127.0.0.1:1081', source: 'env' })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Windows system proxy reader never throws and returns null or a host:port', () => {
  const value = readWindowsSystemProxy()
  assert.ok(value === null || typeof value === 'string')
  if (typeof value === 'string') assert.match(value, /^[^\s;=]+:\d+$/)
})
