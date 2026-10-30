import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startCallbackServer } from '../lib/oauth.js'

/** 找一个当前空闲的端口 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

test('callback server refuses a second listener on the same port while open', async () => {
  const port = await freePort()
  const first = await startCallbackServer({ port, timeoutMs: 5_000 })
  try {
    await assert.rejects(
      startCallbackServer({ port, timeoutMs: 5_000 }),
      (error) => error.code === 'callback_server_failed',
    )
  } finally {
    first.close()
  }
})

test('closing the callback server frees the port immediately (login retry works)', async () => {
  const port = await freePort()
  const first = await startCallbackServer({ port, timeoutMs: 5_000 })
  first.close()

  // 关闭后必须能马上在同一端口重新监听：注册 OAuth client 失败重试的场景依赖这一点
  const second = await startCallbackServer({ port, timeoutMs: 5_000 })
  try {
    assert.equal(new URL(second.redirectUri).port, String(port))
  } finally {
    second.close()
  }

  // 再关一次也不能抛（close 需要幂等）
  assert.doesNotThrow(() => second.close())
})
