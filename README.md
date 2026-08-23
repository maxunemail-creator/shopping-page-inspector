# Shopping Page Inspector — JD / Taobao / Tmall

为“先选成品、再把真实桌腿/横梁尺寸反向放进 CAD”的采购工作准备的云端采集 Actor。

## 目标

输入一个商品 URL，尽量一次拿回两类信息：

1. **结构化商品数据**：SKU、规格、价格/价格补充、店铺、图片 URL 等。
2. **真实浏览器页面证据**：完整 HTML、全页截图、可见文本、图片清单、资源清单，以及最大的详情图片元素截图。

这使隐藏在详情长图里的“尺寸图 / 安装图 / 桌腿内距 / 横梁位置”可以继续交给视觉分析，而不只依赖搜索引擎摘要。

## 当前路由

- JD.com → `sian.agency/jd-com-product-scraper`
  - `productDetail`
  - 可选 `productPrice`
- Taobao / Tmall → `sian.agency/taobao-tmall-product-scraper`
  - `productDetail`, `detailVersion=v1`
- 浏览器深抓 → 本 Actor 自己的 Playwright/Chromium，不需要另外购买 Browserless。

## 当前验收样本

京东 SKU：`10193770948879`

原商品：奕洲实木电脑桌/书桌书架一体/洞洞板系列。目标是验证能否从结构化数据或详情长图中恢复桌板、桌架、洞洞板与层架的真实尺寸，从而把成品桌结构放入阳台 CAD。
