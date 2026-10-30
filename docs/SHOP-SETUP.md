# 接入 TikTok Shop（Seller Center）开放平台

广告接口（Ads API）和商家接口（Shop API）是**两套完全独立的授权**：

| | 广告 Ads API | 商家 Shop API |
|---|---|---|
| 平台 | TikTok Ads（business-api.tiktok.com） | Partner Center（partner.tiktokshop.com） |
| 授权 | OAuth（我们已接好） | OAuth + `auth_code` 换 token + `shop_cipher` |
| 调用 | MCP JSON-RPC | REST + **HMAC-SHA256 签名** |
| 能拿到 | 广告消耗/订单/素材/达人归属 | 商品信息、订单、履约、店铺信息 |

本插件的 Shop 客户端在 `lib/shop.js`，CLI 入口 `node tools/ads-cli.mjs shop ...`。

---

## 一、准备：创建应用（5 分钟）

1. 打开 **TikTok Shop Partner Center**：https://partner.tiktokshop.com
   （用你的商家主账号登录；如果还没有开发者身份，先申请「开发者」）
2. 进入 **App Management → Create App**
   - App name：例如 `ads-agent-kit`
   - 选择「Custom App（自定义应用）/ 商家自用」
3. 创建后进入应用详情，抄下两个值：
   - **App Key**（= client key）
   - **App Secret**（= client secret）
4. 在应用的 **Redirect URL** 里填一个 HTTPS 地址（**不能是 localhost**）
   - 没有服务器？可以用任意你拥有的域名下的一个页面，例如 `https://your-site.com/shop/callback`
   - 这个地址不需要真的有程序处理，我们只需要从跳转后的**地址栏**里复制 `code`
5. 在应用的 **Permissions / Scopes** 里勾选：
   - `Seller authorization`（授权店铺）
   - `Product`（商品信息）
   - `Order`（订单）—— 如果你要拉订单
6. 保存后把 App 状态设为 **Live / Enabled**

---

## 二、配置环境变量

```powershell
setx TIKTOK_SHOP_APP_KEY "你的 app_key"
setx TIKTOK_SHOP_APP_SECRET "你的 app_secret"
setx TIKTOK_SHOP_REDIRECT_URI "https://your-site.com/shop/callback"
# 可选：代理（国内需要）
setx TIKTOK_SHOP_PROXY "http://127.0.0.1:7890"
```

> 设置后需要**重开终端**才生效。也可以直接在当前会话里 `$env:TIKTOK_SHOP_APP_KEY="..."`。

验证：

```bash
node tools/ads-cli.mjs shop status
# {"ok":true,"configured":true,"authorized":false,...}
```

---

## 三、商家授权（拿 auth_code）

```bash
node tools/ads-cli.mjs shop login
```

它会打印一个授权 URL，用浏览器打开 → 登录你要接入的店铺 → 点「Authorize」。

授权后浏览器会跳到你的 `redirect_uri`，地址栏长这样：

```
https://your-site.com/shop/callback?code=ROW_xxxxxxxxxxxxx&shop_region=GB&state=...
```

把 `code=` 后面那一串复制下来（**10 分钟内有效**），然后：

```bash
node tools/ads-cli.mjs shop token --code ROW_xxxxxxxxxxxxx
# {"ok":true,"sellerName":"SUPERLEX UK","shopId":"...","shopCipherSaved":true,...}
```

令牌保存在 `~/.dsh/plugin-data/tiktok-ads/shop-auth.json`（0600），访问令牌约 4 小时，过期自动用 refresh token 续期。

---

## 四、能拉什么

```bash
node tools/ads-cli.mjs shop shops                 # 已授权店铺
node tools/ads-cli.mjs shop products --limit 20   # 商品列表（含上架/更新时间）
node tools/ads-cli.mjs shop orders --limit 20     # 订单列表（默认最近）
node tools/ads-cli.mjs shop call --path /product/202309/products/search --method POST --body '{"page_size":10}'
```

最后一条是**通用入口**：任何 Shop API 都可以用 `shop call` 直接探测，参数用 `--query`（GET 查询串）/ `--body`（POST JSON）传。

### 关于「素材发布时间」

- 广告 API（已接入）：`identity_video_get` 只返回授权起止时间，**没有发布时间**
- Shop API：商品有 `create_time` / `update_time`（**商品**上架/更新时间），但**短视频发布时间**目前不在 Shop Open API 文档的商品/订单范围里
- 结论：商品维度的「上架时间」可以拿到；**视频发布时间仍然拿不到**，除非 TikTok 后续开放内容类 API

---

## 五、常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `missing app_key` / `configured:false` | 环境变量没生效 | 重开终端，或当前会话 `$env:...` |
| `Shop 授权失败 code=10007` | auth_code 过期/已用过 | 重新 `shop login` 走一遍 |
| `code=105001` 等签名类错误 | app_secret 不对 / 时钟偏差 | 校对系统时间，确认 secret |
| `code=105002` 等权限类错误 | scope 没勾 | 回 Partner Center 勾权限后重新授权 |
| `shop_cipher` 为空 | 授权时没选店铺 | 重新授权并选择具体店铺 |

---

## 六、安全

- app_secret、access_token、shop_cipher 都只存本地文件（0600），不写进日志、不出现在工具返回值
- `lib/shop.js` 不引入任何第三方依赖，签名用 Node 内置 `crypto`
- Shop API 请求走和广告 API 同一套代理配置（`TIKTOK_SHOP_PROXY` / `HTTPS_PROXY` / Windows 系统代理）
