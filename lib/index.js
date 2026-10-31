/**
 * dsh-plugin-tiktok-ads — TikTok Ads MCP plugin for DeepSeek Harness.
 *
 * Registers five tools on `ctx.tools`: status, connect, disconnect, catalog
 * search, and a generic MCP caller. The plugin owns the OAuth lifecycle and
 * speaks Streamable HTTP MCP directly, so the host's MCP bridge (which supports
 * static headers only) is not involved.
 *
 * Zero runtime dependencies: only Node built-in modules are imported.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from './config.js'
import { createAdsCore } from './core.js'
import { isTokenUsable, readAuth } from './store.js'
import { renderToolLines, searchTools, suggestToolNames } from './registry.js'
import { openExternal } from './oauth.js'
import { createPanel } from './panel.js'

export const name = 'tiktok-ads'
export const inject = ['tools']

const STATUS_PROPERTIES = {
  authorized: { type: 'boolean', description: '本地是否保存了可用的 TikTok 授权令牌。' },
  mode: { type: 'string', description: '当前 MCP 端点模式：layer（约 40 个核心工具）或 flat（约 400 个工具）。' },
  expose: { type: 'string', description: '工具暴露方式：meta（检索 + 调用）或 all（全量注册）。' },
  resource: { type: 'string', description: '当前 MCP 端点 URL。' },
  proxy: { type: 'string', description: '实际使用的代理，none 表示直连。' },
  proxySource: { type: 'string', description: '代理来源：config / env / windows-system / none。' },
  cachedTools: { type: 'integer', description: '本地缓存的 TikTok 工具数量。' },
  lastSyncedAt: { type: 'string', description: '工具清单最后一次从 TikTok 同步的时间（ISO）。' },
  tokenExpiresAt: { type: 'string', description: '访问令牌到期时间（ISO），不含令牌本身。' },
  message: { type: 'string', description: '面向模型的下一步操作指引。' },
}

const STATUS_REQUIRED = ['authorized', 'mode', 'expose', 'resource', 'proxy', 'proxySource', 'cachedTools', 'message']

const CALL_PROPERTIES = {
  tool: { type: 'string', description: '要调用的 TikTok MCP 工具原始名称，例如 campaign_get；可先用 tiktok_ads_tools 检索。' },
  args: { type: 'object', description: '传给该工具的 JSON 参数对象；没有参数时传 {}。字段定义见 tiktok_ads_tools 的说明。' },
}

/**
 * Build one tool result text block list for DSH rendering.
 * @param {string} text
 */
function textOutput(text) {
  return [{ type: 'text', text }]
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const log = typeof ctx.logger?.info === 'function' ? ctx.logger : null

  // OAuth 授权、MCP 会话、令牌刷新全部由 lib/core.js 负责（CLI / MCP server 共用）。
  const core = createAdsCore({
    settings,
    log: (message) => log?.info?.(`tiktok-ads: ${message}`),
  })

  /**
   * DSH 适配层：expose=all 时把同步到的工具注册成原生工具。
   * @param {{ signal?: AbortSignal, force?: boolean }} [options]
   */
  async function ensureSession({ signal, force = false } = {}) {
    const active = await core.ensureSession({ signal, force })
    if (settings.expose === 'all') registerAllTools(active.tools)
    return active
  }

  /** @type {Array<() => void>} */
  const allToolDisposers = []
  let allToolsRegistered = false
  /**
   * Register every discovered MCP tool as a native DSH tool (`expose: all`).
   * Deliberately opt-in: the flat endpoint returns ~400 tools, which would
   * consume a large part of the context window on every request.
   * @param {import('./registry.js').McpTool[]} tools
   */
  function registerAllTools(tools) {
    if (allToolsRegistered || settings.expose !== 'all') return
    allToolsRegistered = true
    // A hard ceiling: every registered tool ships its schema on every request
    // and enters session history/permission rules permanently. The flat
    // endpoint's ~400 tools would be a self-inflicted context blow-up.
    const limit = settings.maxExposeAll
    if (tools.length > limit) {
      log?.warn?.(`tiktok-ads: expose=all truncated to ${limit} of ${tools.length} tools (raise maxExposeAll to override)`)
    }
    for (const tool of tools.slice(0, limit)) {
      const rawName = String(tool.name || '')
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(rawName)) continue
      const exposedName = `tiktok_ads__${rawName}`
      try {
        allToolDisposers.push(
          ctx.tools.register({
            name: exposedName,
            description: `TikTok Ads: ${String(tool.description || rawName)}（由 dsh-plugin-tiktok-ads 全量注册）`,
            parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
              render: (_args, value) => textOutput(value.text),
            },
            timeoutMs: settings.toolCallTimeoutMs,
            async execute(args, exec) {
              const active = await ensureSession({ signal: exec?.signal })
              const result = await active.callTool(rawName, args ?? {}, { signal: exec?.signal, timeoutMs: settings.toolCallTimeoutMs })
              return { text: result.text }
            },
          }),
        )
      } catch (error) {
        log?.warn?.(`tiktok-ads: cannot expose ${rawName}: ${messageOf(error)}`)
      }
    }
  }

  /** @type {Array<() => void>} */
  const disposers = []

  // ------------------------------------------------- dashboard + monitoring
  /**
   * Call a TikTok registry tool by name through the dispatcher.
   * @param {string} name
   * @param {Record<string, unknown>} params
   */
  async function callToolStd(name, params) {
    return core.callTool(name, params)
  }

  const panel = createPanel({
    settings,
    callTool: callToolStd,
    log: (message) => log?.info?.(`tiktok-ads: ${message}`),
    getStatus: async () => {
      const health = await core.probeProxy()
      const status = core.status()
      return {
        authorized: status.authorized,
        mode: status.mode,
        resource: status.resource,
        proxy: status.proxy,
        proxyOk: health.ok,
        proxyHint: health.hint,
      }
    },
  })
  let panelUrl = null
  panel
    .start()
    .then((state) => {
      panelUrl = state.dashboardUrl
      if (panelUrl) log?.info?.(`tiktok-ads: dashboard ${panelUrl}`)
    })
    .catch((error) => log?.warn?.(`tiktok-ads: dashboard failed: ${messageOf(error)}`))

  // ---------------------------------------------------------------- status
  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_status',
      description:
        '查看 TikTok 广告插件状态：是否已授权、当前端点模式（layer/flat）、代理、已缓存工具数。未授权时返回下一步指引。开始任何 TikTok 广告任务前先调用它。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: STATUS_PROPERTIES, required: STATUS_REQUIRED },
        render: (_args, value) => textOutput(value.message),
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      async execute() {
        // 状态全部来自 core（与 CLI / MCP server 完全一致）；先探一次代理，proxyOk 才有意义
        await core.probeProxy()
        const status = core.status()
        const authorized = status.authorized
        const lines = [
          `TikTok 广告插件状态：${authorized ? '已授权' : '未授权'}（模式 ${status.mode}，暴露方式 ${status.expose}）`,
          `端点：${status.resource}`,
          `代理：${status.proxy}（来源 ${status.proxySource}）`,
          `已缓存工具：${status.cachedTools} 个${status.lastSyncedAt ? `，同步于 ${new Date(status.lastSyncedAt).toLocaleString('zh-CN')}` : ''}`,
        ]
        if (status.tokenExpiresAt) lines.push(`访问令牌到期：${new Date(status.tokenExpiresAt).toLocaleString('zh-CN')}`)
        const panelAlerts = panel.alerts()
        if (panelUrl || panel.dashboardUrl) lines.push(`监控面板：${panel.dashboardUrl || panelUrl}`)
        lines.push(`监控告警：${panelAlerts.active.length} 条${panelAlerts.lastScanAt ? `（上次扫描 ${new Date(panelAlerts.lastScanAt).toLocaleString('zh-CN')}）` : '（尚未扫描）'}；用 tiktok_ads_panel 查看/扫描`)
        if (pendingAuth) {
          lines.push(`待完成的授权：已生成授权链接，等浏览器回调（也可以直接打开：${pendingAuth.url}）。`)
        }
        if (!authorized) {
          lines.push('下一步：调用 tiktok_ads_connect 完成 TikTok for Business 浏览器授权（需要能访问 business-api.tiktok.com；如有必要在插件配置里设置 proxy）。')
        } else {
          lines.push('下一步：用 tiktok_ads_tools 检索工具（例如 query="campaign"），再用 tiktok_ads_call 调用。')
        }
        return {
          authorized: status.authorized,
          mode: status.mode,
          expose: status.expose,
          resource: status.resource,
          proxy: status.proxy,
          proxySource: status.proxySource,
          cachedTools: status.cachedTools,
          ...(status.lastSyncedAt ? { lastSyncedAt: status.lastSyncedAt } : {}),
          ...(status.tokenExpiresAt ? { tokenExpiresAt: status.tokenExpiresAt } : {}),
          message: lines.join('\n'),
        }
      },
    }),
  )

  // --------------------------------------------------------------- connect
  /**
   * Persist the authorize URL where the user can actually reach it: a text file
   * plus a Windows Internet Shortcut on the Desktop. Chat clients truncate long
   * query strings, so the file is the source of truth.
   * @param {string} url
   * @returns {string | null} shortcut path when written
   */
  function persistAuthorizeUrl(url) {
    try {
      fs.mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(settings.dataDir, 'pending-auth-url.txt'), `${url}\n`, { mode: 0o600 })
      const shortcut = path.join(os.homedir(), 'Desktop', 'TikTok-授权.url')
      fs.writeFileSync(shortcut, `[InternetShortcut]\r\nURL=${url}\r\n`, { mode: 0o600 })
      return shortcut
    } catch {
      return null
    }
  }

  /** @type {{ url: string, shortcut: string | null, startedAt: number, settle: Promise<Record<string, unknown>> } | null} */
  let pendingAuth = null

  /**
   * Begin an authorization: register/refresh the callback server, build the URL,
   * surface it, and return a promise that settles when the browser comes back.
   * The callback server stays open across tool calls, so `wait: false` followed
   * by a second `tiktok_ads_connect` picks up the same flow.
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function startAuthFlow({ signal } = {}) {
    // 真正的 OAuth 流程在 core.beginLogin：注册客户端、起回调服务、构造授权链接、
    // 失败时关闭回调端口。这里只负责把链接落盘/写桌面快捷方式并记录 pending 状态。
    const login = await core.beginLogin({ signal, wait: false, openBrowser: settings.autoOpenBrowser })
    const url = login.url
    const shortcut = persistAuthorizeUrl(url)
    const flow = { url, shortcut, startedAt: Date.now(), settle: login.settle }
    pendingAuth = flow
    login.settle.then(
      () => {
        if (pendingAuth === flow) pendingAuth = null
      },
      () => {
        if (pendingAuth === flow) pendingAuth = null
      },
    )
    return flow
  }

  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_connect',
      description:
        '启动 TikTok for Business OAuth 授权：生成授权链接（自动尝试打开浏览器，并写入桌面快捷方式「TikTok-授权.url」）。默认 wait=true 会阻塞等待你在浏览器完成授权并换取令牌；若你希望先拿到链接、稍后再授权，传 wait=false，之后再次调用本工具（或 tiktok_ads_status）即可完成换取令牌。传 force=true 强制重新授权。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          force: { type: 'boolean', description: '已有令牌时是否强制重新授权，默认 false。' },
          wait: { type: 'boolean', description: '是否阻塞等待浏览器授权完成，默认 true。传 false 只返回授权链接。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authorized: { type: 'boolean' },
            url: { type: 'string', description: '需要用户在浏览器打开的授权链接（已写入桌面快捷方式时仍然返回）。' },
            shortcut: { type: 'string', description: '桌面快捷方式路径（Windows），双击即用完整链接打开。' },
            toolCount: { type: 'integer', description: '授权后同步到的 TikTok 工具数量。' },
            message: { type: 'string' },
          },
          required: ['authorized', 'message'],
        },
        render: (_args, value) => textOutput(value.message),
      },
      timeoutMs: settings.authTimeoutMs + 60_000,
      async execute(args, exec) {
        const force = args?.force === true
        const wait = args?.wait !== false
        const existing = readAuth(settings.dataDir)
        if (!force && isTokenUsable(existing, settings.resourceUrl)) {
          return {
            authorized: true,
            message: `已处于授权状态（令牌到期 ${existing.expiresAt ? new Date(existing.expiresAt).toLocaleString('zh-CN') : '未知'}）。如需重新授权，请传 force=true。`,
          }
        }
        // Reuse a flow already waiting for the browser instead of starting a
        // second callback server on the same port.
        const flow = (!force && pendingAuth) || (await startAuthFlow({ signal: exec?.signal }))
        const where = flow.shortcut ? `\n桌面快捷方式（双击即用完整链接）：${flow.shortcut}` : ''

        if (!wait) {
          return {
            authorized: false,
            url: flow.url,
            ...(flow.shortcut ? { shortcut: flow.shortcut } : {}),
            message: `授权链接已生成，请在浏览器打开并点 Authorize：\n${flow.url}${where}\n\n完成后再次调用 tiktok_ads_connect（无需再传参数）即可换取令牌；等待回调最多 ${Math.round(settings.authTimeoutMs / 1000)} 秒。`,
          }
        }

        const result = await flow.settle
        if (result.authorized === true) {
          return {
            authorized: true,
            url: flow.url,
            ...(flow.shortcut ? { shortcut: flow.shortcut } : {}),
            toolCount: Number(result.toolCount) || 0,
            message: `授权成功。${String(result.syncNote || '')}`.trim(),
          }
        }
        // A timeout must not swallow the link: the user may still be able to finish.
        return {
          authorized: false,
          url: flow.url,
          ...(flow.shortcut ? { shortcut: flow.shortcut } : {}),
          message: `等待授权没有完成：${String(result.reason || '未知原因')}。\n授权链接仍然有效，可在浏览器打开后点 Authorize：\n${flow.url}${where}\n\n完成后再次调用 tiktok_ads_connect 以换取令牌（若链接已过期会重新生成）。`,
        }
      },
    }),
  )

  // ------------------------------------------------------------ disconnect
  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_disconnect',
      description: '清除本机保存的 TikTok 广告授权令牌（并尽力通知服务端撤销）。之后需要重新调用 tiktok_ads_connect。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        render: (_args, value) => textOutput(value.message),
      },
      timeoutMs: 30_000,
      async execute() {
        const result = await core.disconnect()
        return {
          message: `已清除本地授权令牌${result.revoked ? '，并已请求服务端撤销' : ''}。如需继续使用，请调用 tiktok_ads_connect。`,
        }
      },
    }),
  )

  // ---------------------------------------------------------------- catalog
  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_tools',
      description:
        '检索 TikTok 广告 MCP 工具目录（TikTok 官方提供约 40 个核心工具 / 约 400 个全量工具）。用关键词搜索（如 campaign、report、audience、creative、catalog、pixel），返回工具名 + 说明；再用 tiktok_ads_call 执行。未授权时会先提示授权。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '关键词，多个词以空格分隔；留空则按目录顺序返回第一批工具。' },
          limit: { type: 'integer', description: '返回条数，默认 25，上限 100。' },
          offset: { type: 'integer', description: '分页偏移，默认 0。' },
          refresh: { type: 'boolean', description: '是否强制从 TikTok 重新同步工具清单，默认 false（用本地缓存）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', description: '目录里的工具总数。' },
            matchedCount: { type: 'integer', description: '匹配关键词的工具数。' },
            listing: { type: 'string', description: '工具清单文本，每行一个。' },
            hint: { type: 'string', description: '下一步建议。' },
            message: { type: 'string' },
          },
          required: ['total', 'matchedCount', 'listing', 'message'],
        },
        render: (_args, value) => textOutput(value.message),
      },
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const tools = await core.getCatalog({ refresh: args?.refresh === true, signal: exec?.signal })
        if (tools.length === 0) {
          return {
            total: 0,
            matchedCount: 0,
            listing: '',
            message: '工具目录为空：TikTok 端点没有返回工具。请运行 tiktok_ads_connect（force=true）重新授权并同步。',
          }
        }
        const result = searchTools(tools, { query: args?.query || '', limit: args?.limit, offset: args?.offset })
        const lines = renderToolLines(result.tools)
        const header = args?.query
          ? `匹配 “${args.query}” 的工具：共 ${result.matchedCount} 个（显示 ${result.offset + 1}-${result.offset + result.tools.length}）`
          : `工具目录共 ${result.total} 个（显示 ${result.offset + 1}-${result.offset + result.tools.length}）`
        const more = result.offset + result.tools.length < result.matchedCount ? `\n还有更多结果，可用 offset=${result.offset + result.tools.length} 继续查看。` : ''
        const listing = lines.join('\n')
        return {
          total: result.total,
          matchedCount: result.matchedCount,
          listing,
          hint: '调用 tiktok_ads_call，tool 传工具名，args 传参数对象。',
          message: `${header}\n${listing}${more}`,
        }
      },
    }),
  )

  // ------------------------------------------------------------------- call
  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_call',
      description:
        '调用一个 TikTok 广告 MCP 工具（先通过 tiktok_ads_tools 拿到准确的工具名与参数要求）。写操作（创建/修改预算/暂停等）会按 DSH 现有审批策略执行。返回 TikTok 的原始结果文本（过长会截断）。',
      parameters: { type: 'object', additionalProperties: false, properties: CALL_PROPERTIES, required: ['tool', 'args'] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: { type: 'string' },
            text: { type: 'string', description: 'TikTok 返回的结果文本。' },
            truncated: { type: 'boolean', description: '结果是否因过长被截断。' },
          },
          required: ['tool', 'text', 'truncated'],
        },
        render: (_args, value) => textOutput(value.text),
      },
      timeoutMs: settings.toolCallTimeoutMs + 10_000,
      async execute(args, exec) {
        const toolName = typeof args?.tool === 'string' ? args.tool.trim() : ''
        if (!toolName) throw new Error('tiktok_ads_call 需要 tool 参数（TikTok MCP 工具名）。')
        const toolArgs = args?.args && typeof args.args === 'object' ? args.args : {}
        let active = await ensureSession({ signal: exec?.signal })
        let known = active.tools.some((tool) => tool.name === toolName)
        if (!known) {
          // The catalog may be stale; refresh once before rejecting the name.
          active = await ensureSession({ signal: exec?.signal, force: true })
          known = active.tools.some((tool) => tool.name === toolName)
        }
        if (!known) {
          const suggestions = suggestToolNames(active.tools, toolName)
          throw new Error(
            `TikTok 工具目录里没有 ${JSON.stringify(toolName)}。${suggestions.length ? `相近的工具：${suggestions.join('、')}。` : ''}请用 tiktok_ads_tools 检索准确名称。`,
          )
        }
        const result = await active.callTool(toolName, toolArgs, { signal: exec?.signal, timeoutMs: settings.toolCallTimeoutMs })
        return { tool: toolName, text: result.text, truncated: result.truncated }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `TikTok Ads · ${args?.tool || 'call'}`,
        kind: 'other',
        rawInput: args?.args ?? {},
      }),
    }),
  )

  // ------------------------------------------------------- dashboard/monitor
  disposers.push(
    ctx.tools.register({
      name: 'tiktok_ads_panel',
      description:
        'TikTok 广告监控面板：查看面板地址、立即扫描「花钱不出单」的系列/素材、列出当前告警、修改监控阈值与飞书 webhook。action=status（默认）/scan/alerts/open/set。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'scan', 'alerts', 'open', 'set'], description: '要执行的动作，默认 status' },
          days: { type: 'integer', description: '扫描窗口天数（覆盖配置，仅本次）' },
          spendThreshold: { type: 'number', description: '消耗阈值（美元），action=set 时生效' },
          roiTarget: { type: 'number', description: 'ROI 目标值，action=set 时生效' },
          roiRatio: { type: 'number', description: '低于目标的倍数触发告警（如 0.7），action=set 时生效' },
          monitorIntervalMinutes: { type: 'integer', description: '自动扫描间隔（分钟），action=set 时生效' },
          feishuWebhook: { type: 'string', description: '飞书自定义机器人 webhook，action=set 时生效（传空字符串可关闭）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string' },
            panelUrl: { type: 'string' },
            active: { type: 'integer' },
          },
          required: ['message'],
        },
        render: (_args, value) => textOutput(value.message),
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const action = typeof args?.action === 'string' ? args.action : 'status'
        if (action === 'set') {
          const patch = {}
          if (typeof args?.spendThreshold === 'number') patch.spendThreshold = args.spendThreshold
          if (typeof args?.roiTarget === 'number') patch.roiTarget = args.roiTarget
          if (typeof args?.roiRatio === 'number') patch.roiRatio = args.roiRatio
          if (typeof args?.days === 'number') patch.windowDays = args.days
          const updated = panel.setConfig({
            rules: {
              ...(patch.spendThreshold !== undefined ? { spendThreshold: patch.spendThreshold } : {}),
              ...(patch.roiTarget !== undefined ? { roiTarget: patch.roiTarget } : {}),
              ...(patch.roiRatio !== undefined ? { roiRatio: patch.roiRatio } : {}),
              ...(patch.windowDays !== undefined ? { windowDays: patch.windowDays } : {}),
            },
            ...(typeof args?.monitorIntervalMinutes === 'number' ? { monitorIntervalMinutes: args.monitorIntervalMinutes } : {}),
            ...(typeof args?.feishuWebhook === 'string' ? { feishuWebhook: args.feishuWebhook } : {}),
          })
          return {
            panelUrl: panel.dashboardUrl || panelUrl || undefined,
            message: `监控设置已更新：窗口 ${updated.rules.windowDays} 天，消耗阈值 $${updated.rules.spendThreshold}，ROI 目标 ${updated.rules.roiTarget}，间隔 ${updated.monitorIntervalMinutes} 分钟，飞书${updated.feishuWebhook ? '已配置' : '未配置'}。`,
          }
        }
        if (action === 'scan') {
          const result = await panel.runScan()
          const alerts = panel.alerts()
          const lines = [
            `扫描完成：覆盖 ${result.scannedStores} 个店铺，当前异常 ${result.active} 条（新增 ${result.fresh}，已恢复 ${result.resolved}）。`,
          ]
          for (const finding of alerts.active.slice(0, 10)) lines.push(`· [${finding.level === 'critical' ? '严重' : '警告'}] ${finding.message}`)
          if (alerts.active.length > 10) lines.push(`… 还有 ${alerts.active.length - 10} 条，见面板`)
          if (result.errors?.length) lines.push(`失败 ${result.errors.length} 个店铺：${result.errors.slice(0, 3).join('；')}`)
          return { panelUrl: panel.dashboardUrl || panelUrl || undefined, active: alerts.active.length, message: lines.join('\n') }
        }
        if (action === 'alerts') {
          const alerts = panel.alerts()
          if (alerts.active.length === 0) {
            return { active: 0, message: `当前没有异常告警${alerts.lastScanAt ? `（上次扫描 ${new Date(alerts.lastScanAt).toLocaleString('zh-CN')}）` : '，还没有扫描过'}` }
          }
          const lines = [`当前 ${alerts.active.length} 条异常：`]
          for (const finding of alerts.active.slice(0, 30)) lines.push(`· [${finding.level === 'critical' ? '严重' : '警告'}] ${finding.message}`)
          return { panelUrl: panel.dashboardUrl || panelUrl || undefined, active: alerts.active.length, message: lines.join('\n') }
        }
        if (action === 'open') {
          const url = panel.dashboardUrl || panelUrl
          if (!url) return { message: '面板没有启动成功，请检查配置里的 dashboardPort（默认 8790）是否被占用。' }
          const opened = openExternal(url)
          return { panelUrl: url, message: `${opened ? '已在浏览器打开' : '请手动打开'}监控面板：${url}` }
        }
        const alerts = panel.alerts()
        const config = panel.getConfig()
        const url = panel.dashboardUrl || panelUrl
        const lines = [
          `监控面板：${url || '未启动（dashboardEnabled 关闭或端口被占用）'}`,
          `规则：窗口 ${config.rules.windowDays} 天，消耗阈值 $${config.rules.spendThreshold}，ROI 目标 ${config.rules.roiTarget}（低于 ${Math.round(config.rules.roiRatio * 100)}% 告警）`,
          `自动扫描间隔：${config.monitorIntervalMinutes} 分钟；飞书推送：${config.feishuWebhook ? '已配置' : '未配置'}`,
          `当前异常：${alerts.active.length} 条${alerts.lastScanAt ? `（上次扫描 ${new Date(alerts.lastScanAt).toLocaleString('zh-CN')}）` : '（尚未扫描）'}`,
          '用 action=scan 立即扫描，或 action=open 打开面板。',
        ]
        return { panelUrl: url || undefined, active: alerts.active.length, message: lines.join('\n') }
      },
    }),
  )

  // Dispose every registration when the plugin unloads (HMR / profile edit).
  ctx.effect?.(() => () => {
    try {
      panel.stop()
    } catch { /* already stopped */ }
    for (const dispose of [...disposers, ...allToolDisposers]) {
      try {
        dispose()
      } catch { /* already disposed */ }
    }
    disposers.length = 0
    allToolDisposers.length = 0
    allToolsRegistered = false
  })

  log?.info?.(`tiktok-ads: registered 6 tools (mode ${settings.mode}, expose ${settings.expose})`)
}
