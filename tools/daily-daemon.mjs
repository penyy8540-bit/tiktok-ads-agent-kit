#!/usr/bin/env node
/**
 * Tiny scheduler daemon: runs the daily report once a day at a local time.
 *
 * Windows Task Scheduler needs administrator rights in many locked-down setups,
 * so this daemon is started from the user's Startup folder instead (no
 * privileges required). It survives sleep/hibernate by re-checking every few
 * minutes, and it catches up when the machine was off at the scheduled time.
 *
 *   node tools/daily-daemon.mjs                 # run at 09:00 local, every day
 *   node tools/daily-daemon.mjs --at 08:30
 *   node tools/daily-daemon.mjs --catch-up      # fill recent missing runs, then exit
 *
 * State: %USERPROFILE%\.dsh\plugin-data\tiktok-ads\daemon-state.json
 * Log:   %USERPROFILE%\.dsh\plugin-data\tiktok-ads\daemon.log
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const has = (flag) => argv.includes(flag)

const DATA_DIR = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'plugin-data', 'tiktok-ads')
  : path.join(os.homedir(), '.dsh', 'plugin-data', 'tiktok-ads')
const OUT_ROOT = path.resolve(value('--out', path.join(os.homedir(), 'Desktop', '广告', '每日广告订单')))
const STATE_FILE = path.join(DATA_DIR, 'daemon-state.json')
const LOG_FILE = path.join(DATA_DIR, 'daemon.log')
const LOCK_FILE = path.join(DATA_DIR, 'daemon.lock')
const NODE = process.execPath
const REPORT = path.join(import.meta.dirname, 'daily-report.mjs')

const at = /^\d{1,2}:\d{2}$/.test(value('--at', '09:00')) ? value('--at', '09:00') : '09:00'
const [atHour, atMinute] = at.split(':').map(Number)
const CHECK_INTERVAL_MS = 5 * 60_000

const pad = (n) => String(n).padStart(2, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const today = () => formatDate(new Date())
const yesterday = () => formatDate(new Date(Date.now() - 86_400_000))

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    fs.appendFileSync(LOG_FILE, `${line}\n`)
  } catch { /* non-fatal */ }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch { /* non-fatal */ }
}

/** Single instance: a lock file holding a live PID. */
function acquireLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (existing?.pid && existing.pid !== process.pid) {
      try {
        process.kill(existing.pid, 0)
        return false // another daemon is alive
      } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2))
  return true
}

function releaseLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (existing?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true })
  } catch { /* non-fatal */ }
}

/** Run the report for one target date; resolves with the exit code. */
function runReport(targetDate) {
  return new Promise((resolve) => {
    log(`开始拉取 ${targetDate} 的报表…`)
    const child = spawn(NODE, [REPORT, '--date', targetDate, '--days', '1', '--flat', '--out', OUT_ROOT], {
      cwd: path.dirname(path.dirname(REPORT)),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      log(`启动报表进程失败：${error.message}`)
      resolve(1)
    })
    child.on('exit', (code) => {
      for (const line of output.trim().split(/\r?\n/).filter(Boolean).slice(-6)) log(`  ${line}`)
      log(`报表进程结束，退出码 ${code}`)
      resolve(code ?? 1)
    })
  })
}

function reportExists(targetDate) {
  try {
    // Standard layout: one flat workbook per day (<out>/<date>.xlsx).
    if (fs.existsSync(path.join(OUT_ROOT, `${targetDate}.xlsx`))) return true
    // Legacy layouts kept for older output folders.
    const dir = path.join(OUT_ROOT, targetDate)
    return fs.existsSync(path.join(dir, `${targetDate}.xlsx`)) || fs.existsSync(path.join(dir, 'report.json'))
  } catch {
    return false
  }
}

function nextRunFrom(now) {
  const candidate = new Date(now)
  candidate.setHours(atHour, atMinute, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate
}

async function runDue(state) {
  const now = new Date()
  const target = yesterday()
  const stamp = today()
  if (state.lastRunDate === stamp) return state
  const due = new Date(now)
  due.setHours(atHour, atMinute, 0, 0)
  if (now.getTime() < due.getTime()) return state
  if (reportExists(target)) {
    log(`${target} 的报表已存在，跳过`)
    state.lastRunDate = stamp
    writeState(state)
    return state
  }
  const code = await runReport(target)
  state.lastRunDate = stamp
  state.lastResult = code
  state.lastTarget = target
  state.lastRunAt = new Date().toISOString()
  writeState(state)
  return state
}

// --------------------------------------------------------------- catch-up
if (has('--catch-up')) {
  const state = readState()
  const targets = []
  for (let offset = 1; offset <= 3; offset++) {
    const target = formatDate(new Date(Date.now() - offset * 86_400_000))
    if (!reportExists(target)) targets.push(target)
  }
  if (targets.length === 0) log('最近 3 天报表都齐了，无需补跑')
  for (const target of targets) await runReport(target)
  process.exit(0)
}

// ---------------------------------------------------------------- daemon
if (!acquireLock()) {
  log('已有守护进程在运行，退出')
  process.exit(0)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

log(`守护进程启动：每天 ${at} 拉取昨日报表 → ${OUT_ROOT}（PID ${process.pid}）`)
let state = readState()
state = await runDue(state)
let nextRun = nextRunFrom(new Date())
log(`下次运行：${nextRun.toLocaleString('zh-CN')}`)

const timer = setInterval(async () => {
  try {
    const now = new Date()
    if (now.getTime() >= nextRun.getTime()) {
      nextRun = nextRunFrom(now)
      log(`触发定时任务（下次 ${nextRun.toLocaleString('zh-CN')}）`)
    }
    state = await runDue(state)
  } catch (error) {
    log(`定时循环异常：${error?.message || error}`)
  }
}, CHECK_INTERVAL_MS)
timer.unref?.()
// Keep the process alive explicitly (the interval is unref'd for tests).
setInterval(() => {}, 1 << 30)
