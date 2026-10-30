# 给 AI 用的使用说明（AI-USAGE）

这份文档是写给**模型 / Agent**看的：告诉你什么时候该用哪个工具、参数怎么填、结果怎么读。

## 0. 一句话决策

| 你的宿主 | 用哪个 |
|---|---|
| DeepSeek Harness | 插件工具 `tiktok_ads_*`（见下表） |
| 能执行 shell 的 Agent（Claude Code / Codex / 自研） | `node tools/ads-cli.mjs <command>` |
| 支持 MCP 的客户端（Claude Desktop / Cursor） | `tools/mcp-server.mjs` 的 9 个工具 |

## 1. 永远先查状态

```bash
node tools/ads-cli.mjs status
```

返回里有三个关键字段：

- `authorized: false` → 先跑 `login`，不要继续调数据接口
- `tokenExpiresAt` 过期但 `hasRefreshToken: true` → 直接调数据接口，会自动续期
- `proxySource: "windows-system"` → 说明代理来自 Windows 系统设置，不是环境变量

## 2. 拿数据的三条命令

```bash
# ① 账户 + 店铺（后续调用都需要 advertiserId / storeId）
node tools/ads-cli.mjs accounts

# ② 广告组汇总（默认输出 JSON，含 totals + campaigns[]）
node tools/ads-cli.mjs report --days 7

# ③ 素材明细（找「花钱不出单」）
node tools/ads-cli.mjs creatives --days 1
```

参数通用：

| 参数 | 说明 |
|---|---|
| `--days 7` | 最近 7 天（默认 1） |
| `--today` | 包含今天（注意：今天数据是实时的，可能不完整） |
| `--start 2026-10-20 --end 2026-10-28` | 指定区间（优先于 `--days`） |
| `--advertiserId <id>` | 只看某个账户 |
| `--pretty` | 缩进 JSON（人看的时候用） |

## 3. 怎么判断「该不该停」

拿到素材明细后，按这套规则分类（插件面板里的「状态」列就是这个逻辑）：

| 状态 | 判定 |
|---|---|
| `待删 kill` | 消耗 ≥ 阈值（默认 $5）且订单 = 0 |
| `观察 watch` | 有订单，但 ROI < 目标 × 0.7 |
| `加热 scale` | 有订单，且 ROI ≥ 目标 × 1.2 |
| `正常 normal` | 其余 |

目标 ROI 默认 10，可在插件配置 `rules.roiTarget` 调整。

## 4. 直接调任意 TikTok 工具

```bash
node tools/ads-cli.mjs tools --query "report"        # 先查工具名
node tools/ads-cli.mjs call campaign_get --args '{"advertiser_id":"<id>","campaign_ids":["<cid>"]}'
```

MCP 方式对应 `tiktok_tools_search` + `tiktok_call`。

> ⚠️ 写操作（建计划 / 改预算 / 暂停）会真实修改广告账户。执行前必须让人类确认。

## 5. 必须知道的 API 坑（省你几小时）

| 坑 | 正确做法 |
|---|---|
| 用 `report_get` 拉 GMV Max 数据 → 返回空 | 用 `gmv_max_report_get` |
| `dimensions: ["item_group_id"]` 报错/为空 | 加 `filtering.campaign_ids` |
| `dimensions: ["item_id"]` 报错 | 同时加 `campaign_ids` **和** `item_group_ids` |
| 期望素材有小时数据 | 没有。小时数据只有账户/广告组级 |
| 想按 `stat_time_day` 拉多天 | 该维度不能单独用，要配合维度或改用默认聚合 |
| 拿 `item_id` 拼 tiktok.com/video/<id> | 打不开，网页端不认；只能复制给人在商家后台搜 |

## 6. 导出 Excel

```bash
node tools/ads-cli.mjs export --start 2026-10-20 --end 2026-10-28 --out ./reports
```

- 每天一个 `YYYY-MM-DD.xlsx`
- sheet：商品明细 / 素材明细 / SKU 销量 / 说明
- 需要 Python + openpyxl；没有 Python 时只有这一个功能不可用，其他命令不受影响

## 7. 结果结构示例

```json
{
  "ok": true,
  "range": { "start": "2026-10-22", "end": "2026-10-28" },
  "totals": { "cost": 2229.88, "orders": 756, "revenue": 30705.0, "roi": 13.77, "costPerOrder": 2.95 },
  "campaigns": [
    { "advertiserId": "766...", "campaignId": "1873...", "cost": 553.31, "orders": 134, "roi": 15.83 }
  ]
}
```

## 8. 出错怎么处理

| 报错 | 原因 | 处理 |
|---|---|---|
| `尚未授权` | 没有令牌 | `login` |
| `找不到 node 可执行文件` | 导出时代理/路径问题 | 确认 `node -v` 可用，或用 `--out` 指定目录 |
| `code=401xx` | 令牌失效 | 重新 `login` |
| `连接被关闭` | 代理不稳 | 检查 `TIKTOK_ADS_PROXY`，或重试 |
| 空数组 | 该区间确实没消耗，或账户/店铺不匹配 | 先 `accounts` 核对 storeId |

## 9. 安全补丁（v0.2.1）

- 面板只接受 Host: 127.0.0.1/localhost，写操作必须是 pplication/json，跨源请求直接 403
- 代理用户名密码不会出现在日志、状态返回值里（统一 edactProxy 脱敏）
- 导出目录限制在配置的 exportDir 内（默认桌面「广告/每日广告订单」）
- 代理断连不再导致宿主崩溃；素材 SKU 缓存 key 已修正
## 10. 达人昵称 / 发布时间

- **达人昵称**：identity_get(advertiser_id) 拿发布身份，identity_video_get(advertiser_id, identity_id, identity_type, item_type='VIDEO') 拿作品，把 item_id → display_name 映射起来（插件里缓存在 creator-map.json，30 分钟有效）。
  只覆盖**已授权投放的达人**（AUTH_CODE 类型），自然流量/其他达人无法解析。
- **发布时间**：TikTok 广告 Open API **不提供**。identity_video_get 只返回 uth_info.auth_start_time / auth_end_time（授权时间），不是发布时间。需要发布时间只能用商家中心/创作者中心页面查看。