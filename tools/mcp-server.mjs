#!/usr/bin/env node
/**
 * tiktok-ads MCP server (stdio) — 让任何支持 MCP 的 AI 客户端直接接入。
 *
 * 客户端配置示例（Claude Desktop / Cursor / 其他）：
 *   {
 *     "mcpServers": {
 *       "tiktok-ads": {
 *         "command": "node",
 *         "args": ["<绝对路径>/tools/mcp-server.mjs"],
 *         "env": { "TIKTOK_ADS_PROXY": "auto" }
 *       }
 *     }
 *   }
 *
 * 覆盖的工具：status / login / accounts / report / campaigns / creatives /
 * tools_search / call / export
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdsCore } from '../lib/core.js'
import { resolveRange, getAccounts, getCampaignReport, getCreativeReport } from '../lib/queries.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL_VERSION = '2024-11-05'

const core = createAdsCore({ log: (message) => process.stderr.write(`[tiktok-ads] ${message}\n`) })

const TOOLS = [
  {
    name: 'tiktok_status',
    description: '查看 TikTok 广告授权状态（是否已授权、模式、代理、数据目录）。开始任何 TikTok 广告任务前先调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => core.status(),
  },
  {
    name: 'tiktok_login',
    description: '生成 TikTok for Business OAuth 授权链接并自动打开浏览器；完成授权后令牌自动保存。若返回 wait=false 可稍后再查 status。',
    inputSchema: {
      type: 'object',
      properties: {
        wait: { type: 'boolean', description: '是否阻塞等待浏览器授权完成（默认 true）' },
        openBrowser: { type: 'boolean', description: '是否自动打开浏览器（默认 true）' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const wait = args.wait !== false
      const result = await core.beginLogin({ wait, openBrowser: args.openBrowser !== false })
      if (result && result.settle) {
        if (!wait) {
          // 不阻塞：授权在后台完成，客户端稍后用 tiktok_status 查询结果
          result.settle.catch(() => {})
          return { ok: true, url: result.url, waiting: true, hint: '授权完成后令牌会自动保存，稍后用 tiktok_status 查询' }
        }
        const settle = await result.settle
        return { ok: true, url: result.url, ...settle }
      }
      return result
    },
  },
  {
    name: 'tiktok_accounts',
    description: '列出已授权的 TikTok 广告账户及其 GMV Max 店铺（后续报表需要 advertiserId + storeId）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true, accounts: await getAccounts(core) }),
  },
  {
    name: 'tiktok_report',
    description: 'GMV Max 汇总报表（按广告组）。返回区间总消耗/订单/GMV/ROI + 每个广告组明细。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '最近 N 天（默认 1）' },
        today: { type: 'boolean', description: '是否包含今天（默认从前一天开始）' },
        start: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        advertiserId: { type: 'string', description: '只看某个广告账户' },
      },
      additionalProperties: false,
    },
    handler: async (args) => ({ ok: true, ...(await getCampaignReport(core, resolveRange(args), { advertiserId: args.advertiserId })) }),
  },
  {
    name: 'tiktok_campaigns',
    description: '广告组级明细（消耗/订单/GMV/ROI），按消耗降序。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        today: { type: 'boolean' },
        start: { type: 'string' },
        end: { type: 'string' },
        advertiserId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await getCampaignReport(core, resolveRange(args), { advertiserId: args.advertiserId })
      return { ok: true, range: result.range, count: result.campaigns.length, campaigns: result.campaigns }
    },
  },
  {
    name: 'tiktok_creatives',
    description: '素材级明细（作品 ID / 消耗 / 订单 / GMV / ROI / 点击），用于找「花钱不出单」的素材。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        today: { type: 'boolean' },
        start: { type: 'string' },
        end: { type: 'string' },
        advertiserId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (args) => ({ ok: true, ...(await getCreativeReport(core, resolveRange(args), { advertiserId: args.advertiserId })) }),
  },
  {
    name: 'tiktok_tools_search',
    description: '检索 TikTok 官方 MCP 工具目录（约 43 个核心工具），返回工具名和说明。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如 campaign / report / audience / creative' },
        limit: { type: 'number', description: '返回条数（默认 25）' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = core.listTools(String(args.query || ''), Number(args.limit) || 25)
      return { ok: true, total: result.total, matched: result.matched, tools: result.tools.map((tool) => ({ name: tool.name, description: tool.description })) }
    },
  },
  {
    name: 'tiktok_call',
    description: '直接调用任意 TikTok MCP 工具（先用 tiktok_tools_search 查名字和参数）。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具原始名称，如 campaign_get' },
        args: { type: 'object', description: '传给该工具的参数' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    handler: async (args) => ({ ok: true, tool: args.tool, result: await core.callTool(String(args.tool), args.args || {}) }),
  },
  {
    name: 'tiktok_export',
    description: '导出指定日期区间的 Excel 报表（每天一个 xlsx，含商品明细/素材明细/SKU 销量/说明），格式与插件面板导出一致。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        out: { type: 'string', description: '输出目录（默认 ./reports）' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const outDir = String(args.out || path.join(process.cwd(), 'reports'))
      const script = path.join(HERE, 'daily-report.mjs')
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [script, '--start', String(args.start), '--end', String(args.end), '--per-day', '--flat', '--out', outDir], { windowsHide: true })
        const log = []
        child.stdout.on('data', (chunk) => log.push(String(chunk).trim()))
        child.stderr.on('data', (chunk) => log.push(String(chunk).trim()))
        child.on('error', (error) => { log.push(error.message); resolve({ code: 1, log }) })
        child.on('close', (status) => resolve({ code: status, log }))
      })
      return { ok: code.code === 0, start: args.start, end: args.end, outDir, log: code.log.slice(-15) }
    },
  },
]

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]))

const send = (message) => {
  process.stdout.write(JSON.stringify(message) + '\n')
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    // 回显客户端请求的协议版本（支持 2024-11-05 / 2025-06-18 等）
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    ok(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'tiktok-ads', version: '0.3.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    ok(id, {})
    return
  }
  if (method === 'tools/list') {
    ok(id, {
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    })
    return
  }
  if (method === 'tools/call') {
    const name = String(params?.name || '')
    const tool = TOOL_MAP.get(name)
    if (!tool) {
      fail(id, -32602, `未知工具：${name}`)
      return
    }
    try {
      const result = await tool.handler(params?.arguments || {})
      ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false })
    } catch (error) {
      ok(id, { content: [{ type: 'text', text: `错误：${error instanceof Error ? error.message : String(error)}` }], isError: true })
    }
    return
  }
  fail(id, -32601, `不支持的方法：${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handle(message).catch((error) => {
      if (message && message.id !== undefined) fail(message.id, -32603, error instanceof Error ? error.message : String(error))
    })
  }
})
process.stdin.on('end', () => process.exit(0))
