import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { buildAuthorizeUrl, discoverMetadata, pkcePair, randomState, startCallbackServer } from '../lib/oauth.js'

test('pkcePair produces a 43-char verifier and its S256 challenge', async () => {
  const { verifier, challenge, method } = pkcePair()
  assert.equal(method, 'S256')
  assert.equal(verifier.length, 43)
  assert.match(verifier, /^[A-Za-z0-9_-]+$/)
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.equal(challenge, expected)
})

test('randomState is unique and URL safe', () => {
  const values = new Set(Array.from({ length: 32 }, () => randomState()))
  assert.equal(values.size, 32)
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]+$/)
})

test('buildAuthorizeUrl includes PKCE, state, scope and resource', () => {
  const metadata = { authorizationEndpoint: 'https://business-api.tiktok.com/portal/mcp-tt4b-authorize' }
  const url = new URL(
    buildAuthorizeUrl(metadata, {
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:43113/callback',
      challenge: 'challenge',
      state: 'state-1',
      scope: 'mcp:tt4b',
      resource: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer',
    }),
  )
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('client_id'), 'client-1')
  assert.equal(url.searchParams.get('scope'), 'mcp:tt4b')
  assert.equal(url.searchParams.get('resource'), 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer')
})

test('discoverMetadata falls back to the published TikTok endpoints when discovery fails', async () => {
  const metadata = await discoverMetadata('https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer', {
    proxy: null,
    timeoutMs: 1500,
  })
  // Whether or not the network is reachable, the fallback contract must hold.
  assert.ok(metadata.authorizationEndpoint.endsWith('/portal/mcp-tt4b-authorize'))
  assert.ok(metadata.tokenEndpoint.endsWith('/oauth/token'))
  assert.ok(metadata.registrationEndpoint.endsWith('/oauth/register'))
})

/**
 * Drive a real localhost callback server: the browser side is simulated with a
 * plain HTTP GET, which is exactly what TikTok's redirect performs.
 */
test('startCallbackServer captures the code and validates state', async () => {
  const port = 45000 + Math.floor(Math.random() * 2000)
  const server = await startCallbackServer({ port, timeoutMs: 5000 })
  assert.equal(server.redirectUri, `http://127.0.0.1:${port}/callback`)
  const wait = server.waitForCode('state-ok')
  await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/callback?code=the-code&state=state-ok`, (response) => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
  })
  assert.equal(await wait, 'the-code')
})

test('startCallbackServer rejects a mismatched state', async () => {
  const port = 46000 + Math.floor(Math.random() * 2000)
  const server = await startCallbackServer({ port, timeoutMs: 5000 })
  const wait = assert.rejects(server.waitForCode('expected'), /state 不匹配/)
  await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/callback?code=c&state=forged`, (response) => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
  })
  await wait
})

test('startCallbackServer surfaces OAuth errors from the provider', async () => {
  const port = 47000 + Math.floor(Math.random() * 2000)
  const server = await startCallbackServer({ port, timeoutMs: 5000 })
  const wait = assert.rejects(server.waitForCode('s'), /授权被拒绝/)
  await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/callback?error=access_denied&state=s`, (response) => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
  })
  await wait
})
