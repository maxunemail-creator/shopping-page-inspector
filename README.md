# Shopping Page Inspector — JD / Taobao / Tmall

面向工程采购的商品详情检查器。目标不是“爬整站”，而是把已经筛中的真实 SKU 的公开规格、SKU 矩阵、商品图片和结构证据尽量完整拿回来，再把真实结构反向放进 CAD。

## v0.5：Zero-CU first

默认工作流已改成：

1. **GitHub Actions / 普通 HTTP**：先读取公开商品页、京东移动页内嵌商品数据、公开接口和 CDN 图片；不启动 Chromium，也不调用收费 Apify Actor。
2. **Apify**：只保留为人工触发的 fallback。当公开数据拿不到深层结构证据时，才运行第三方结构化 Actor 或 Chromium。
3. **不自动绕访问控制**：登录、验证码、滑块或其他访问控制出现时，只记录失败/partial，不自动解决。

### 京东当前有效的 P0

实际验收显示，桌类商品最有价值的公开入口是：

- `item.m.jd.com/product/<sku>.html`
- 页面中的 `window._itemOnly` / `window._itemInfo`
- `360buyimg.com` 商品图片 CDN

`src/jd-mobile-structured.js` 会直接从移动商品页内嵌对象恢复：

- 精确 SKU；
- 完整 SKU 名称；
- 品牌；
- 当前颜色与尺寸；
- 颜色列表与尺寸列表；
- `newColorSize` 全 SKU 变体矩阵；
- 当前 SKU 主图；
- 商品主图数组；
- 每种颜色的变体主图。

解析器支持京东页面对象里存在的尾随逗号，不需要执行页面 JavaScript。

其他公开路径仍作为补充尝试：

- `item.jd.com/<sku>.html`：桌面页静态证据；
- `p.3.cn/prices/mgets`：价格接口；
- `api.m.jd.com ... pc_item_getWareGraphic`：图文详情接口候选；
- `dx.3.cn/desc/<sku>` 与 `cd.jd.com/description/channel`：旧详情接口 fallback；
- `item-soa.jd.com/getWareBusiness`：商品业务数据补充；
- `club.jd.com` / `sclub.jd.com`：公开评论摘要 fallback。

这些接口可能按出口 IP / 风控状态返回空结果或错误页，因此 v0.5 不把任何单一接口视为必达。

淘宝/天猫在 v0.5 只做 passive public-HTML/CDN evidence，不调用需要签名、登录或私有 cookie 的接口。

## 最常用的运行方式

仓库根目录有 `request.json`：

```json
{
  "url": "https://item.jd.com/10193770948879.html",
  "maxImages": 36
}
```

更新这个文件并 push 到 `main`，GitHub Actions 的 **Zero-CU product inspection** 会自动运行并上传 evidence artifact。它不需要 `APIFY_TOKEN`。

也可直接在任何 Node 22+ 环境运行：

```bash
node src/zero-cu-runner.js https://item.jd.com/10193770948879.html zero-cu-results
```

输出目录典型包含：

- `ZERO_CU_SUMMARY.json`：总结果和工程判据；
- `JD_MOBILE_STRUCTURED.json`：移动页恢复出的精确 SKU、颜色/尺寸矩阵和主图；
- `MOBILE_EVIDENCE.json`：移动页证据统计；
- `MOBILE_ALL_IMAGE_CANDIDATES.json`：所有候选图片 URL 及优先级；
- `mobile-images/`：优先下载当前 SKU、商品主图、颜色变体图，再补页面扫描图片；
- `PRICE.json` / `WARE_GRAPHIC.json` / `ITEM_SOA.json` / `REVIEWS.json`：公开接口补充结果；
- `PAGE*.html` / `MOBILE_PAGE.html`：原始页面证据。

## 工程证据分级

v0.5 不再把“抓到几张图片”直接等同于结构可用：

- `LAYOUT_USABLE`：精确 SKU 行已经匹配，广告尺寸确认，并至少取得真实商品主图。适合做整体包络/摆放 CAD。
- `DETAIL_ENGINEERING_CANDIDATE`：还取得可能包含结构或详情尺寸的较大详情图，可继续判读桌腿内距、横梁、层板等。
- 深层几何仍未恢复时，`browserOrUserSessionNeededForDeepGeometry=true`，明确禁止凭宣传图猜内部尺寸。

## GitHub Actions

### Zero-CU product inspection

自动触发：`request.json`、Zero-CU 代码、测试或 workflow 有变更，以及对应 pull request。

CI 只需 Node.js，不安装 Playwright/Chromium，也不消耗 Apify CU。

### Deploy to Apify (manual only)

Apify workflow 从 v0.5 起只允许 `workflow_dispatch` 人工触发。普通 GitHub push 不再自动部署、更不会自动执行真实购物网站 smoke run，避免无意烧完 Apify 配额。

## 当前验收样本：PASS

京东 SKU `10193770948879`，奕洲书架洞洞板一体实木电脑桌。

Zero-CU 验收 run `32723225484` 得到：

- 精确当前 SKU：`10193770948879`；
- 当前颜色：`黑胡桃+黑架【25mm实木桌面】`；
- 当前尺寸：`120*60*170cm【书架洞洞板】`；
- 8 种颜色 × 6 种尺寸，共 48 个 SKU 组合；
- 商品主图 3 张；
- 结构化商品/颜色主图候选 10 张，10 张均下载成功且超过 20 KiB；
- 当前证据等级：`LAYOUT_USABLE`；
- 深层结构尺寸仍 OPEN。

同一颜色 `黑胡桃+黑架【25mm实木桌面】` 的 `140*60*170cm【书架洞洞板】` 变体也已从矩阵直接恢复：SKU `10193770948880`。

验收状态另记录于 `.github/zero-cu-acceptance.json`。

## 旧的 Apify 深抓层仍然保留

- `src/structured.js`：第三方结构化 Actor；
- `src/structured-images.js`：结构化结果图片归档；
- `src/jd-description.js`：Apify KVS 版详情图片抓取；
- `src/deep-capture.js`：Playwright/Chromium 深抓；
- `src/main.js`：Apify Actor 入口。

这些现在是 P1/P2 fallback，不再是日常商品筛选的 P0。

## 安全边界

本项目只处理公开可访问的数据和用户有权访问的页面。不自动登录、不解 CAPTCHA/滑块、不绕过访问控制，也不使用凭证去访问用户未授权的数据。
