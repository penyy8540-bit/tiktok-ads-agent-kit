#!/usr/bin/env node
/**
 * Standalone verification / login helper for dsh-plugin-tiktok-ads.
 *
 * Runs outside DSH so the network path, OAuth flow, and MCP handshake can be
 * checked without restarting the app:
 *
 *   node tools/verify.mjs                 # discovery + DCR + 401 check (no login)
 *   node tools/verify.mjs --login         # full OAuth login, then list tools
 *   node tools/verify.mjs --login --call campaign_get --args '{"advertiser_id":"..."}'
 *   node tools/verify.mjs --mode flat     # use the full ~400 tool endpoint
 *   node tools/verify.mjs --proxy http://127.0.0.1:7890
 *
 * The token is saved to the same location the plugin uses, so a successful
 * --login leaves DSH ready to use without re-authorizing.
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { normalizeConfig, resolveProxy } from '../lib/config.js'
import { parseProxy } from '../lib/transport.js'
import { McpSession } from '../lib/mcp.js'
import {
  buildAuthorizeUrl,
  discoverMetadata,
  exchangeCode,
  openExternal,
  pkcePair,
  randomState,
  registerClient,
  startCallbackServer,
} from '../lib/oauth.js'
import { isTokenUsable, readAuth, writeAuth } from '../lib/store.js'
import { searchTools } from '../lib/registry.js'

// stdout is buffered when this script runs as a piped background job, so also
// append every line to a log file the operator can tail while authorizing.
const LOG_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugin-data', 'tiktok-ads', 'login-attempt.log')
const consoleLog = console.log.bind(console)
console.log = (...args) => {
  consoleLog(...args)
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`)
  } catch { /* logging is best effort */ }
}

/**
 * Parse `--key value` / `--flag` arguments.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { call: '', args: '', query: '', limit: 20 }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'login' || key === 'help' || key === 'no-browser') {
      options[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) continue
    options[key] = value
    index++
  }
  return options
}

/** @param {string} step */
function heading(step) {
  console.log(`\n=== ${step} ===`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '')))
    return
  }

  const config = normalizeConfig({
    mode: options.mode || 'layer',
    proxy: options.proxy || 'auto',
    dataDir: options['data-dir'] || undefined,
    callbackPort: options.port ? Number(options.port) : undefined,
    authTimeoutMs: options['auth-timeout'] ? Number(options['auth-timeout']) * 1000 : undefined,
  })
  const resolvedProxy = resolveProxy(config.proxySetting)
  const proxy = parseProxy(resolvedProxy.proxy)
  console.log(`端点：${config.resourceUrl}`)
  console.log(`代理：${resolvedProxy.proxy ?? '直连'}（来源 ${resolvedProxy.source}）`)
  console.log(`数据目录：${config.dataDir}`)

  heading('1/5 OAuth 元数据发现')
  const metadata = await discoverMetadata(config.resourceUrl, { proxy, timeoutMs: config.requestTimeoutMs })
  console.log(`issuer：${metadata.issuer}`)
  console.log(`授权端点：${metadata.authorizationEndpoint}`)
  console.log(`token 端点：${metadata.tokenEndpoint}`)
  console.log(`注册端点：${metadata.registrationEndpoint}`)

  heading('2/5 未授权访问应返回 401 + WWW-Authenticate')
  const session = new McpSession({
    url: config.resourceUrl,
    proxy,
    timeoutMs: config.requestTimeoutMs,
    getToken: async () => 'invalid-probe-token',
    onUnauthorized: undefined,
  })
  try {
    await session.connect()
    console.log('⚠ 未授权居然握手成功（不符合预期）')
  } catch (error) {
    console.log(`✓ 按预期被拒绝：${error.message}`)
  }

  const existing = readAuth(config.dataDir)
  if (!options.login && !isTokenUsable(existing, config.resourceUrl)) {
    console.log('\n未登录。要完成授权并列出工具，请运行：')
    console.log(`  node tools/verify.mjs --login${options.proxy ? ` --proxy ${options.proxy}` : ''}`)
    return
  }

  let token = existing.accessToken
  if (options.login) {
    heading('3/5 动态客户端注册（RFC 7591）')
    const callback = await startCallbackServer({ port: config.callbackPort, timeoutMs: config.authTimeoutMs })
    try {
      const registration = await registerClient(metadata, {
        redirectUri: callback.redirectUri,
        proxy,
        timeoutMs: config.requestTimeoutMs,
      })
      console.log(`client_id：${registration.clientId}（public client，无 secret）`)

      const pkce = pkcePair()
      const state = randomState()
      const url = buildAuthorizeUrl(metadata, {
        clientId: registration.clientId,
        redirectUri: callback.redirectUri,
        challenge: pkce.challenge,
        state,
        scope: config.oauthScopes,
        resource: config.resourceUrl,
      })
      console.log('\n请在浏览器打开下面的链接并授权（等待回调中）：')
      console.log(url)
      // Also persist the URL: terminal/agent stdout is often piped and buffered,
      // and the user needs the link before the callback arrives.
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        const os = await import('node:os')
        mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
        writeFileSync(path.join(config.dataDir, 'pending-auth-url.txt'), `${url}\n`, { mode: 0o600 })
        // A Windows Internet Shortcut: double-clicking it opens the FULL URL.
        // Pasting/auto-linking a 300+ char URL with `&` is error-prone, and
        // `cmd /c start <url>` truncates at the first `&`.
        const shortcut = path.join(os.homedir(), 'Desktop', 'TikTok-授权.url')
        writeFileSync(shortcut, `[InternetShortcut]\r\nURL=${url}\r\n`, { mode: 0o600 })
        // A local page with one big button, for browsers that distrust file links.
        const html = path.join(config.dataDir, 'authorize.html')
        writeFileSync(
          html,
          `<!doctype html><meta charset="utf-8"><title>TikTok 授权</title><body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6"><h1>TikTok 广告授权</h1><p>下面这个按钮会把完整参数（client_id / redirect_uri / PKCE / resource）带到 TikTok 授权页。</p><p><a href="${url.replace(/&/g, '&amp;')}" style="display:inline-block;background:#0f766e;color:#fff;padding:.8rem 1.6rem;border-radius:.5rem;text-decoration:none;font-weight:600">打开 TikTok 授权页</a></p><p style="color:#666;font-size:.9rem">若页面顶部再次出现 <code>Missing required parameter(s)</code>，说明 URL 被截断——请改用桌面上的 TikTok-授权.url 双击打开。</p></body>`,
          { mode: 0o600 },
        )
        console.log(`授权链接已写入：${path.join(config.dataDir, 'pending-auth-url.txt')}`)
        console.log(`桌面快捷方式：${shortcut}`)
        console.log(`本地按钮页：${html}`)
      } catch { /* non-fatal */ }
      if (!options['no-browser']) openExternal(url)

      heading('4/5 等待浏览器回调并换取令牌')
      const code = await callback.waitForCode(state)
      const tokens = await exchangeCode(
        metadata,
        { clientId: registration.clientId, code, redirectUri: callback.redirectUri, codeVerifier: pkce.verifier, resource: config.resourceUrl },
        proxy,
        undefined,
        config.requestTimeoutMs,
      )
      writeAuth(config.dataDir, {
        clientId: registration.clientId,
        redirectUri: callback.redirectUri,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope || config.oauthScopes,
        resource: config.resourceUrl,
        mode: config.mode,
        authorizedAt: Date.now(),
      })
      token = tokens.accessToken
      console.log(`✓ 授权成功，令牌已保存到 ${path.join(config.dataDir, 'auth.json')}`)
      console.log(`  有效期至：${tokens.expiresAt ? new Date(tokens.expiresAt).toLocaleString('zh-CN') : '未声明'}`)
    } finally {
      callback.close()
    }
  }

  heading('5/5 MCP 握手 + 工具清单')
  let activeToken = token
  const active = new McpSession({
    url: config.resourceUrl,
    proxy,
    timeoutMs: config.requestTimeoutMs,
    getToken: async () => activeToken,
    onUnauthorized: async () => {
      throw new Error('访问令牌被拒绝，请重新运行 --login')
    },
  })
  await active.connect()
  console.log(`服务器：${active.serverInfo?.name || '未知'} ${active.serverInfo?.version || ''}`)
  console.log(`协议版本：${active.protocolVersion}`)
  console.log(`工具数量：${active.tools.length}`)

  const query = options.query || options.call || ''
  const found = searchTools(active.tools, { query, limit: Number(options.limit) || 20 })
  console.log(`\n${query ? `匹配 “${query}” 的工具：${found.matchedCount} 个` : `工具清单（前 ${found.tools.length} 个）`}：`)
  for (const tool of found.tools) {
    const description = String(tool.description || '').replace(/\s+/g, ' ').slice(0, 120)
    console.log(`- ${tool.name}${description ? `: ${description}` : ''}`)
  }

  if (options.call) {
    heading(`调用工具 ${options.call}`)
    let parsedArgs = {}
    if (options.args) {
      try {
        parsedArgs = JSON.parse(options.args)
      } catch {
        throw new Error(`--args 不是合法 JSON：${options.args}`)
      }
    }
    const result = await active.callTool(options.call, parsedArgs, { timeoutMs: config.toolCallTimeoutMs })
    console.log(result.text)
  }

  console.log('\n✓ 验证完成。重启 DSH（或让 profile 热重载）后即可在对话里使用 tiktok_ads_* 工具。')
}

main().catch((error) => {
  console.error(`\n✗ 失败：${error?.message || error}`)
  if (error?.cause?.message) console.error(`  原因：${error.cause.message}`)
  process.exitCode = 1
})
