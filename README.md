# Shopping Page Inspector — JD / Taobao / Tmall

面向工程采购的商品详情检查器。目标不是“爬整站”，而是把已经筛中的真实 SKU 的价格、公开参数、详情长图、桌腿/横梁/洞洞板结构尽量完整拿回来，再把真实结构反向放进 CAD。

## v0.5：Zero-CU first

默认工作流已改成：

1. **GitHub Actions / 普通 HTTP**：先读取公开商品页、价格接口、详情图接口、公开评论摘要和 CDN 图片；这一路不启动 Chromium，也不调用收费 Apify Actor。
2. **Apify**：只保留为人工触发的 fallback。当公开接口拿不到关键结构证据时，才部署/运行第三方结构化 Actor 或 Chromium。
3. **不自动绕访问控制**：登录、验证码、滑块或其他访问控制出现时，只记录失败/partial，不自动解决。

当前京东 Zero-CU 路径会尝试：

- `item.jd.com/<sku>.html`：标题、静态参数、页面图片线索。
- `p.3.cn/prices/mgets`：公开价格数据。
- `api.m.jd.com ... pc_item_getWareGraphic`：商品图文详情/详情图片线索。
- `dx.3.cn/desc/<sku>` 与 `cd.jd.com/description/channel`：旧版详情接口 fallback。
- `item-soa.jd.com/getWareBusiness`：公开商品业务数据补充。
- `club.jd.com` / `sclub.jd.com`：公开评论摘要 fallback。
- `360buyimg.com` / `jdimg.com`：尽量下载原始 CDN 商品/详情图片。

淘宝/天猫在 v0.5 只做 passive public-HTML/CDN evidence，不调用需要签名、登录或私有 cookie 的接口。

## 最常用的运行方式

仓库根目录有一个 `request.json`：

```json
{
  "url": "https://item.jd.com/10193770948879.html",
  "maxImages": 36
}
```

更新这个文件并 push 到 `main`，GitHub Actions 的 **Zero-CU product inspection** 会自动运行并上传 evidence artifact。它不需要 `APIFY_TOKEN`。

也可直接在任何 Node 22+ 环境运行：

```bash
node src/zero-cu.js https://item.jd.com/10193770948879.html zero-cu-results
```

输出目录典型包含：

- `ZERO_CU_SUMMARY.json`：总结果和工程判据。
- `PRICE.json`：价格接口原始结构化结果。
- `WARE_GRAPHIC.json` / `WARE_GRAPHIC_RAW.txt`：京东图文详情接口证据。
- `ITEM_SOA.json`：商品业务数据补充。
- `REVIEWS.json`：公开评论摘要。
- `LEGACY_DESCRIPTIONS.json` / `LEGACY_DESC_*.txt`：旧详情接口 fallback。
- `PAGE.html`：普通 HTTP 商品页证据（如果能直接取得）。
- `IMAGE_MANIFEST.json` + `images/`：下载成功的商品/详情图及来源。

## GitHub Actions

### Zero-CU product inspection

自动触发条件：

- `request.json` 更新；
- `src/zero-cu.js` / `src/url.js` / `package.json` 等 Zero-CU 代码更新；
- 对上述文件的 pull request。

CI 只需 Node.js，不运行 `npm install`，因此不会安装 Playwright/Chromium，也不会消耗 Apify CU。

### Deploy to Apify (manual only)

Apify workflow 从 v0.5 起只允许 `workflow_dispatch` 人工触发。普通 GitHub push 不再自动部署、更不会自动执行真实购物网站 smoke run，避免无意烧完 Apify 配额。

## 旧的 Apify 深抓层仍然保留

仓库里仍保留：

- `src/structured.js`：第三方结构化 Actor。
- `src/structured-images.js`：结构化结果中的图片归档。
- `src/jd-description.js`：Apify KVS 版详情图片抓取。
- `src/deep-capture.js`：Playwright/Chromium 深抓。
- `src/main.js`：Apify Actor 入口。

这几层现在是 **P1/P2 fallback**，不再是日常商品筛选的 P0。

## 当前验收样本

京东 SKU `10193770948879`，奕洲实木电脑桌 / 书架洞洞板系列。

前一版 Apify 路径已成功拿到该 SKU 的结构化商品数据、价格和 19 张图片，但 Chromium 被京东登录页重定向。v0.5 的验收目标是确认公开 HTTP/API/CDN 路径能在不消耗 Apify CU 的前提下恢复足够的工程证据。

## 安全边界

本项目只处理公开可访问的数据和用户有权访问的页面。不自动登录、不解 CAPTCHA/滑块、不绕过访问控制，也不使用凭证去访问用户未授权的数据。
