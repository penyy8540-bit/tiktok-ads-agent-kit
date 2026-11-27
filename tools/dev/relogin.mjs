/**
 * 重新授权辅助脚本：先打印授权链接（并写桌面快捷方式），再等待浏览器回调。
 * 用法：node tools/dev/relogin.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAdsCore, configFromEnv } from '../../lib/core.js'

const core = createAdsCore({ log: (message) => console.error(`[core] ${message}`) })
const settings = configFromEnv({})
const desktop = path.join(os.homedir(), 'Desktop')
const shortcut = path.join(desktop, 'TikTok-授权.url')

const login = await core.beginLogin({ wait: false, openBrowser: true })
console.log(JSON.stringify({ ok: true, url: login.url }, null, 1))

try {
  fs.writeFileSync(shortcut, `[InternetShortcut]\r\nURL=${login.url}\r\n`, 'latin1')
  console.log(JSON.stringify({ shortcut }, null, 1))
} catch (error) {
  console.log(JSON.stringify({ shortcutError: error.message }))
}

console.log('WAITING_FOR_CALLBACK')
try {
  const result = await login.settle
  console.log(JSON.stringify({ authorized: result.authorized === true, toolCount: result.toolCount, dataDir: settings.dataDir }))
  process.exit(0)
} catch (error) {
  console.log(JSON.stringify({ authorized: false, error: error.message }))
  process.exit(1)
}
