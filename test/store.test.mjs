import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearAuth, describeAuth, isTokenUsable, readAuth, updateAuth, writeAuth } from '../lib/store.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-store-'))
}

test('missing file reads as an empty record', () => {
  const dir = tempDir()
  assert.deepEqual(readAuth(dir), {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('write includes the file and read returns it', () => {
  const dir = tempDir()
  writeAuth(dir, { clientId: 'abc', accessToken: 'token-1234', resource: 'r' })
  const record = readAuth(dir)
  assert.equal(record.clientId, 'abc')
  assert.equal(record.accessToken, 'token-1234')
  updateAuth(dir, { refreshToken: 'refresh-1' })
  assert.equal(readAuth(dir).refreshToken, 'refresh-1')
  clearAuth(dir)
  assert.deepEqual(readAuth(dir), {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('corrupt auth files degrade to an empty record', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'auth.json'), '{not json')
  assert.deepEqual(readAuth(dir), {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('isTokenUsable honours resource binding and expiry skew', () => {
  const resource = 'https://example.test/mcp'
  assert.equal(isTokenUsable({}, resource), false)
  assert.equal(isTokenUsable({ accessToken: 't', resource }, resource), true)
  assert.equal(isTokenUsable({ accessToken: 't', resource: 'other' }, resource), false)
  assert.equal(isTokenUsable({ accessToken: 't', resource, expiresAt: Date.now() + 1000 }, resource), false)
  assert.equal(isTokenUsable({ accessToken: 't', resource, expiresAt: Date.now() + 600_000 }, resource), true)
})

test('describeAuth never exposes the full token', () => {
  const described = describeAuth({ accessToken: 'abcdefgh-1234', scope: 'mcp:tt4b', expiresAt: Date.now() + 60_000 })
  assert.equal(described.authorized, true)
  assert.equal(described.tokenTail, '1234')
  assert.equal(JSON.stringify(described).includes('abcdefgh'), false)
  assert.equal(describeAuth({}).authorized, false)
})
