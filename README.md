# Shopping Page Inspector — JD / Taobao / Tmall

云端商品详情检查器，目标是“成品家具优先，少量定制为辅”：先把真实商品的 SKU、尺寸、详情长图、桌腿/横梁结构尽量完整抓回，再把真实结构反向放进 CAD。

## P0 路由

- JD.com → `sian.agency/jd-com-product-scraper`
  - `productDetail`
  - 可选 `productPrice`
- Taobao / Tmall → `sian.agency/taobao-tmall-product-scraper`
  - `productDetail`, `detailVersion=v1`
- 浏览器深抓 → 本 Actor 自带 Chromium / Playwright

专用 Actor 用于结构化字段；浏览器层用于 JS、懒加载、详情图和动态接口。遇到登录/验证码/访问控制页时，只保存 partial evidence，不自动绕过。

## v0.2 相对 v0.1

- Docker 与 Playwright 固定到 `22-1.62.1` / `1.62.1`，避免浏览器和 npm 包版本漂移。
- 除详情图片元素截图外，还尝试保存 CDN 原始图片字节 `DETAIL_ORIG_*.{jpg,png,webp,...}`。
- 新增 `DETAIL_MANIFEST.json`，把原始 URL、natural size、截图 key、原图 key 对起来。
- 新增有界的 `NETWORK_JSON.json`，记录真实浏览器观察到的 JSON/XHR/fetch 响应；很多购物站把规格和 SKU 动态注入，这一层常比 DOM 更有价值。

## 输入示例

```json
{
  "url": "https://item.jd.com/10193770948879.html",
  "mode": "auto",
  "includePrice": true,
  "captureLargeImages": true,
  "downloadLargeImageOriginals": true,
  "captureNetworkJson": true,
  "maxLargeImages": 18,
  "proxyConfiguration": { "useApifyProxy": false }
}
```

## 输出

Key-Value Store：

- `OUTPUT`
- `STRUCTURED.json`
- `PAGE.html`
- `PAGE.png`
- `VISIBLE_TEXT.txt`
- `IMAGES.json`
- `JSON_LD.json`
- `RESOURCES.json`
- `NETWORK_JSON.json`
- `DETAIL_MANIFEST.json`
- `DETAIL_01.png ...`
- `DETAIL_ORIG_01.* ...`

Dataset 另写入一行轻量摘要，用于批量比较多个候选商品。

## 部署到 Apify

1. 把本仓库连接到 Apify Actor（Source type: Git repository）。
2. Build。
3. 用 `sample-input.json` 的京东样本验收。

当前验收 SKU：`10193770948879`（奕洲实木电脑桌/洞洞板/书架系列）。

## 安全边界

不自动登录，不自动解 CAPTCHA / 滑块，不用来绕过访问控制。公开结构化 Actor 或真实浏览器若落到验证页，保存证据并报告 partial。
