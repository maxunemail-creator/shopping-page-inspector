# Shopping Page Inspector — JD / Taobao / Tmall

面向工程采购的商品详情检查器。目标不是“爬整站”，而是把已经筛中的真实 SKU 的公开规格、SKU 矩阵、商品图片和结构证据尽量完整拿回来，再把真实结构反向放进 CAD。

## 当前架构：P0/P1 免费，Apify 只做 P2

1. **P0 — Zero-CU HTTP**：GitHub Actions 普通 Node.js 请求京东移动商品页，直接解析 `window._itemOnly` / `window._itemInfo`，拿精确 SKU、颜色/尺寸矩阵和主图。不启动浏览器，不用 Apify。
2. **P1 — GitHub-hosted Chromium**：只有入围商品需要详情尺寸图时，才在标准 GitHub-hosted runner 上用系统 Chrome + `playwright-core` 真浏览器加载移动商品页、滚动详情、捕获 XHR/fetch 和详情 DOM。仍不使用 Apify CU。
3. **P2 — Apify**：只保留人工触发 fallback。P0/P1 都拿不到关键证据时才用第三方 Actor / Apify Chromium。
4. **访问控制边界**：登录、验证码、滑块或其他访问控制出现时只记录 partial/block，不自动绕过。

## P0：Zero-CU JD mobile embedded data

当前桌类商品最稳定的公开入口是：

- `item.m.jd.com/product/<sku>.html`
- 页面中的 `window._itemOnly` / `window._itemInfo`
- `360buyimg.com` 商品图片 CDN

`src/jd-mobile-structured.js` 会从移动商品页内嵌对象恢复：精确 SKU、完整 SKU 名称、品牌、当前颜色与尺寸、颜色/尺寸列表、`newColorSize` 全 SKU 变体矩阵、当前 SKU 主图、商品主图数组以及颜色变体主图。解析器支持页面对象中的尾随逗号，不需要执行 JavaScript。

其他公开接口仍做补充，但可能按出口 IP / 风控状态返回空结果或错误页，因此不视为必达：`p.3.cn/prices/mgets`、`pc_item_getWareGraphic`、`dx.3.cn/desc`、`cd.jd.com/description/channel`、`item-soa.jd.com/getWareBusiness`、公开评论接口等。

淘宝/天猫 v0.5 目前只做 passive public-HTML/CDN evidence，不调用需要签名、登录或私有 cookie 的接口。

## P1：GitHub-hosted Chromium deep inspection

`tools/browser-deep/deep-jd-v2.js` 使用 GitHub runner 自带 Google Chrome 和很轻的 `playwright-core`：

- 自动把 JD 桌面链接切到移动商品页；
- 真浏览器执行页面脚本并滚动到详情区域；
- 捕获 XHR/fetch/document 响应；
- 保存 `#detail` DOM、可见文字、网络索引；
- 从详情 DOM/网络响应中提取 CDN 图片；
- 使用同一 browser context 下载最多限定数量的较大详情图片；
- 保存 artifact 后供视觉工程判读。

当前 140 cm 奕洲样本的 P1 验收已通过：GitHub-hosted Chrome 无登录/验证拦截，捕获 27 个网络响应、7 个 detail 类响应、53 个 detail DOM 图片，下载 30 张有效详情图。最关键的接口是移动页实际发起的 `ware/detail/getIntroduceInfo`（`functionId=item_intruduce_info`），其返回体直接包含 29 张商品详情图。验收状态见 `.github/browser-deep-acceptance.json`。

P1 详情图已经恢复出该系列明确尺寸图：桌面高度 75 cm、桌深 60 cm、落地脚深 55 cm、桌板 25 mm、桌面到第一层置物架 52 cm、再上层间距 27 cm、顶部段 16 cm、上层架深 24 cm，总高 170 cm；宽度随 SKU 为 80/100/120/140/160/180 cm。内部未标注的桌腿型材宽度、后横梁高度、显示器臂夹持净空等仍禁止凭宣传图猜数值。

## 使用方式

P0 根目录请求文件：

```json
{
  "url": "https://item.jd.com/10193770948880.html",
  "maxImages": 36
}
```

更新 `request.json` 会触发 **Zero-CU product inspection**。

P1 深抓请求文件：

```json
{
  "url": "https://item.jd.com/10193770948880.html",
  "maxImages": 30
}
```

更新 `deep-request.json` 会触发 **Browser-deep product inspection (free public runner)**。

P0 本地/任意 Node 22+ 环境也可运行：

```bash
node src/zero-cu-runner.js https://item.jd.com/10193770948880.html zero-cu-results
```

P1 输出典型包含：`BROWSER_SUMMARY.json`、`BROWSER_PAGE.html`、`BROWSER_VISIBLE_TEXT.txt`、`DETAIL_DOM.html`、`NETWORK_INDEX.json`、`BROWSER_IMAGE_CANDIDATES.json`、`BROWSER_IMAGE_MANIFEST.json`、`browser-images/`。

## 工程证据分级

- `LAYOUT_USABLE`：精确 SKU、广告尺寸、真实商品主图已经闭合，可用于整体包络/摆放 CAD。
- `DETAIL_ENGINEERING_CANDIDATE` / browser-deep：取得真实商品详情图，可继续判读有明确标注的内部结构尺寸。
- 未标注尺寸仍保持 OPEN；不能因为有渲染图/宣传图就反算成制造尺寸。

## 当前奕洲验收样本

黑胡桃+黑架、25 mm 实木桌面、洞洞板/双层书架系列：

- 120×60×170：SKU `10193770948879`；
- 140×60×170：SKU `10193770948880`；
- 同颜色完整宽度 SKU 映射以及两次 Zero-CU 验收见 `.github/zero-cu-acceptance.json`。

P1 深抓验收使用 140 cm 版本，因为它是当前阳台主工位候选。

## Apify：manual only

`.github/workflows/deploy-apify.yml` 从 v0.5 起只有 `workflow_dispatch`，普通 push 不再自动部署、更不会自动执行真实商品 smoke run，避免无意烧完 Apify 配额。

旧 Apify 代码仍保留为 P2：`src/structured.js`、`src/structured-images.js`、`src/jd-description.js`、`src/deep-capture.js`、`src/main.js`。

## 安全边界

本项目只处理公开可访问的数据和用户有权访问的页面。不自动登录、不解 CAPTCHA/滑块、不绕过访问控制，也不使用凭证访问未授权数据。
