/**
 * 查当前出口 IP（分别测直连和代理），TikTok Shop 的 IP 白名单要填这个
 */
import { httpRequest, parseProxy } from '../../lib/transport.js'
import { resolveProxy } from '../../lib/config.js'

async function probe(label, proxy) {
  try {
    const response = await httpRequest('https://api.ipify.org?format=json', { proxy, timeoutMs: 20_000 })
    const data = JSON.parse(response.text)
    console.log(`${label}: ${data.ip}`)
    return data.ip
  } catch (error) {
    console.log(`${label}: 失败 ${String(error.message).slice(0, 120)}`)
    return null
  }
}

const resolved = resolveProxy('auto')
console.log(`代理来源: ${resolved.source} -> ${resolved.proxy || '直连'}`)
await probe('直连出口 IP', null)
await probe('代理出口 IP', parseProxy(resolved.proxy))
