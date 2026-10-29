# AGENTS.md

给在这个仓库里工作的编码 Agent 的说明。

## 快速验证

```bash
npm test                                   # 36 个单元测试，必须先全绿
node --check lib/core.js                   # 改动 lib/*.js 后逐个语法检查
node tools/dev/check-page.mjs                  # 改 dashboard.js 后校验内联脚本与 DOM id
node tools/ads-cli.mjs status              # 冒烟（需要本机已授权）
```

## 结构约束

- `lib/core.js` 是**无框架依赖**层：DSH 插件（`lib/index.js`）、CLI（`tools/ads-cli.mjs`）、
  MCP server（`tools/mcp-server.mjs`）都必须复用它，不要在入口里重复实现 OAuth/MCP 会话。
- 查询逻辑放 `lib/queries.js`，入口只做参数解析与输出格式。
- `lib/dashboard.js` 里的页面是**一个巨大的模板字符串**。改它之后必须跑 `node tools/dev/check-page.mjs`，
  它会检查内联脚本能否解析、`$('#id')` 引用的 id 是否真实存在。
- 插件工具通过 `ctx.tools.register({ name, description, parameters, output, execute })` 注册；
  `parameters` 用 JSON Schema 子集，`required` 必须是顶层数组。

## 代码风格

- ESM，不用 TypeScript，不加第三方依赖（整个项目零 runtime deps）。
- 注释写「为什么」而不是「是什么」；中文注释可以，但代码标识符用英文。
- 错误信息要能指导下一步动作（例如「请先运行 ads-cli login」），不要只抛 `failed`。

## 提交前检查清单

1. `npm test` 全绿
2. `node --check` 覆盖所有改动文件
3. 改了 `lib/dashboard.js` → 跑 `node tools/dev/check-page.mjs`
4. 没有把令牌、`auth.json`、`plugin-data/` 内容提交进仓库
5. 新增 CLI 命令 → 同步更新 `README.md` 与 `docs/AI-USAGE.md`

## 不要做的事

- 不要改 `.gitignore` 放行 `plugin-data/`、`*.token`、`reports/`
- 不要把 `C:\Users\...` 这类本机绝对路径写进代码（用 `os.homedir()` / 环境变量）
- 不要在日志里打印 access token / refresh token
- 不要把面板监听从 `127.0.0.1` 改成 `0.0.0.0`
