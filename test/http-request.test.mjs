import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { httpRequest } from '../lib/transport.js'

/** 一个只实现 httpRequest 用到的接口的假 socket */
function fakeSocket() {
  const socket = new EventEmitter()
  socket.written = []
  socket.write = (chunk) => {
    socket.written.push(String(chunk))
    return true
  }
  socket.destroy = () => {
    socket.destroyed = true
  }
  return socket
}

test('httpRequest rejects when the peer closes before the response head', async () => {
  const socket = fakeSocket()
  const pending = httpRequest('https://example.com/x', {
    connect: async () => socket,
    timeoutMs: 5_000,
  })
  // 握手成功但一个字节都没回就断开（代理/网关静默断连的典型形态）
  setImmediate(() => socket.emit('close'))
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'connection_closed')
    return true
  })
  assert.equal(socket.destroyed, true)
})

test('httpRequest settles exactly once when both close and end fire', async () => {
  const socket = fakeSocket()
  const body = 'hello'
  const pending = httpRequest('https://example.com/x', {
    connect: async () => socket,
    timeoutMs: 5_000,
  })
  setImmediate(() => {
    socket.emit('data', Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`))
    socket.emit('end')
    socket.emit('close')
  })
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(response.text, body)
  assert.equal(socket.destroyed, true)
})

test('httpRequest fails instead of resolving a truncated body', async () => {
  const socket = fakeSocket()
  const pending = httpRequest('https://example.com/x', {
    connect: async () => socket,
    timeoutMs: 5_000,
  })
  setImmediate(() => {
    // 声明 10 字节，只给 4 字节就断开
    socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabcd'))
    socket.emit('close')
  })
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'truncated_body')
    return true
  })
})

test('httpRequest rejects on timeout and on abort with distinct codes', async () => {
  const timeoutSocket = fakeSocket()
  await assert.rejects(
    httpRequest('https://example.com/x', { connect: async () => timeoutSocket, timeoutMs: 20 }),
    (error) => error.code === 'timeout',
  )

  const abortSocket = fakeSocket()
  const controller = new AbortController()
  const pending = httpRequest('https://example.com/x', {
    connect: async () => abortSocket,
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  setImmediate(() => controller.abort())
  await assert.rejects(pending, (error) => error.code === 'aborted')
})
