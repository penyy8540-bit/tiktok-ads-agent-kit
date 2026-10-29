---
name: tiktok-ads
description: 查询 TikTok 广告账户数据（GMV Max 报表、广告组、素材、SKU），监控花钱不出单的对象，导出 Excel。当用户提到 TikTok 广告、GMV Max、广告消耗、ROI、素材投放、广告账户数据、导出广告报表时使用。
---

# TikTok Ads

通过官方 TikTok for Business Ads MCP 访问用户自己的广告账户。

## 前置检查

```bash
node tools/ads-cli.mjs status
```

- `authorized: false` → 让用户运行 `node tools/ads-cli.mjs login`（会打开浏览器）
- 已授权 → 继续

## 常用命令（全部输出 JSON）

```bash
node tools/ads-cli.mjs accounts                 # 账户 + 店铺
node tools/ads-cli.mjs report --days 7          # 区间汇总 + 广告组明细
node tools/ads-cli.mjs creatives --days 1       # 素材明细（找花钱不出单）
node tools/ads-cli.mjs tools --query report     # 检索可用的 TikTok 工具
node tools/ads-cli.mjs call <tool> --args '{...}'  # 调任意工具
node tools/ads-cli.mjs export --start YYYY-MM-DD --end YYYY-MM-DD --out ./reports
```

## 判定规则

| 状态 | 条件 |
|---|---|
| 待删 | 消耗 ≥ $5 且订单 = 0 |
| 观察 | 有订单但 ROI < 目标 × 0.7 |
| 加热 | 有订单且 ROI ≥ 目标 × 1.2 |

默认目标 ROI = 10（可在插件配置调整）。

## 关键 API 约束

- GMV Max 数据用 `gmv_max_report_get`
- `item_group_id` 维度必须带 `filtering.campaign_ids`
- `item_id` 维度必须同时带 `campaign_ids` 与 `item_group_ids`
- 素材级没有小时数据（只有账户/广告组有）

## 安全

- 写操作（改预算/暂停/删计划）必须先让用户确认
- 不要把令牌出现在任何输出里
