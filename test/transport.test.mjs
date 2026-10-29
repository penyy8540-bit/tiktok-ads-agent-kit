import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProxy, splitSseEvents } from '../lib/transport.js'

test('splitSseEvents parses single and multi event blocks', () => {
  const { events, rest } = splitSseEvents('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n')
  assert.equal(rest, '')
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}' },
    { event: 'message', data: '{"b":2}' },
  ])
})

test('splitSseEvents keeps an incomplete trailing event', () => {
  const { events, rest } = splitSseEvents('data: {"a":1}\n\ndata: {"b":')
  assert.equal(events.length, 1)
  assert.equal(rest, 'data: {"b":')
})

test('splitSseEvents handles CRLF, comments and multi-line data', () => {
  const { events } = splitSseEvents('event: ping\r\ndata: x\r\n\r\n: keepalive\r\ndata: line1\r\ndata: line2\r\n\r\n')
  assert.deepEqual(events, [
    { event: 'ping', data: 'x' },
    { event: 'message', data: 'line1\nline2' },
  ])
})

test('parseProxy normalizes accepted forms and rejects others', () => {
  assert.equal(parseProxy('off'), null)
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy(undefined), null)
  const url = parseProxy('127.0.0.1:7890')
  assert.equal(url.href, 'http://127.0.0.1:7890/')
  assert.equal(parseProxy('http://127.0.0.1:7890').hostname, '127.0.0.1')
  assert.throws(() => parseProxy('socks5://127.0.0.1:1080'), /仅支持 http/)
})
