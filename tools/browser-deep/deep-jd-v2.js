import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAX_BODY = 2_000_000;
const MAX_RESPONSES = 140;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIN_USEFUL_BYTES = 20 * 1024;

function skuFromUrl(url) {
  const u = new URL(url);
  return u.pathname.match(/(?:product\/|\/)(\d{8,})(?:\.html)?/i)?.[1]
    || u.searchParams.get('wareId') || u.searchParams.get('skuId') || null;
}

function targetUrl(url) {
  const u = new URL(url);
  const sku = skuFromUrl(url);
  return /(^|\.)jd\.com$/i.test(u.hostname) && sku ? `https://item.m.jd.com/product/${sku}.html` : url;
}

function decode(s = '') {
  return String(s).replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
}

function normalizeImage(raw = '') {
  let url = decode(raw).trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (/^jfs\//i.test(url)) url = `https://m.360buyimg.com/mobilecms/${url}`;
  if (!/^https?:\/\//i.test(url)) return '';
  return url
    .replace(/\/pcpubliccms\/s\d+x\d+_jfs\//i, '/pcpubliccms/jfs/')
    .replace(/\/(n\d+)\/s\d+x\d+_jfs\//i, '/$1/jfs/')
    .replace(/\/sku\/s\d+x\d+_jfs\//i, '/sku/jfs/')
    .replace(/\/s\d+x\d+_jfs\//i, '/jfs/');
}

function noiseImage(url) {
  const s = String(url).toLowerCase();
  return [
    'error-new', '/jsresource/risk/', '/risk/static/', '/ling/jfs/',
    'businesslicense', 'certificate', 'qualification', 'license', 'licence',
    'permit', 'wenwangwen', 'qrcode', 'qr-code', 'sprite', 'loading',
    'transparent', 'default.image', '/shaidan/', '/comment/', '/avatar/',
  ].some((x) => s.includes(x));
}

function imageUrls(text = '') {
  const src = decode(text);
  const out = new Set();
  const abs = /(?:https?:)?\/\/[^\s"'<>\\)]+?(?:360buyimg\.com|jdimg\.com)[^\s"'<>\\)]*?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of src.matchAll(abs)) {
    const url = normalizeImage(m[0]);
    if (url && !noiseImage(url)) out.add(url);
  }
  const rel = /(?:^|["':,\s])(jfs\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|gif|avif))(?:["',\s}]|$)/gi;
  for (const m of src.matchAll(rel)) {
    const url = normalizeImage(m[1]);
    if (url && !noiseImage(url)) out.add(url);
  }
  return [...out];
}

function blocked(title, text, url) {
  const s = `${title}\n${text}\n${url}`;
  const rows = [
    ['jd-login', /passport\.jd\.com|登录京东|京东登录/i],
    ['jd-risk', /risk_handler|京东验证|安全验证|访问验证|访问受限/i],
    ['captcha', /captcha|验证码|verify you are human/i],
    ['access-denied', /access denied|403 forbidden/i],
  ];
  return rows.filter(([, re]) => re.test(s)).map(([name]) => name);
}

function networkSource(url, body = '') {
  const s = `${url}\n${body}`;
  if (/pc_item_getWareGraphic|graphicContent|waregraphic/i.test(s)) return 'network-ware-graphic';
  if (/introduction|gettemplate|description|detail/i.test(s)) return 'network-detail';
  return 'network-xhr';
}

function extension(type = '', url = '') {
  if (/jpeg/i.test(type)) return 'jpg';
  if (/png/i.test(type)) return 'png';
  if (/webp/i.test(type)) return 'webp';
  if (/gif/i.test(type)) return 'gif';
  if (/avif/i.test(type)) return 'avif';
  return url.match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i)?.[1]?.replace(/^jpeg$/i, 'jpg').toLowerCase() || 'bin';
}

function safe(s = '') {
  return String(s).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'evidence';
}

async function json(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium'].filter(Boolean)) {
    try { await fs.access(p); return p; } catch { /* continue */ }
  }
  return null;
}

async function downloadImages(context, candidates, dir, referer, maxImages) {
  const target = path.join(dir, 'browser-images');
  await fs.mkdir(target, { recursive: true });
  const manifest = [];
  let saved = 0;
  let attempted = 0;
  for (const c of candidates) {
    if (saved >= maxImages || attempted >= 140) break;
    attempted += 1;
    const row = { ...c, attempted, saved: false, bytes: 0, file: null, error: null };
    try {
      const r = await context.request.get(c.url, { headers: { referer, 'user-agent': UA }, timeout: 15000 });
      if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
      const type = r.headers()['content-type'] || 'application/octet-stream';
      if (!type.toLowerCase().startsWith('image/')) throw new Error(`not-image:${type}`);
      const body = await r.body();
      if (body.length > MAX_IMAGE_BYTES) throw new Error(`image-too-large:${body.length}`);
      row.bytes = body.length;
      if (body.length >= MIN_USEFUL_BYTES) {
        const file = `${String(saved + 1).padStart(2, '0')}_${safe(c.source)}.${extension(type, c.url)}`;
        await fs.writeFile(path.join(target, file), body);
        row.saved = true;
        row.file = `browser-images/${file}`;
        saved += 1;
      }
    } catch (e) {
      row.error = e?.message || String(e);
    }
    manifest.push(row);
  }
  return { attempted, saved, manifest };
}

async function run(inputUrl, outDir, maxImages) {
  await fs.mkdir(outDir, { recursive: true });
  const target = targetUrl(inputUrl);
  const sku = skuFromUrl(target);
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome executable not found');

  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    screen: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    userAgent: UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();

  const network = [];
  const tasks = [];
  page.on('response', (response) => {
    if (network.length + tasks.length >= MAX_RESPONSES) return;
    const req = response.request();
    const type = req.resourceType();
    const u = response.url();
    if (!['xhr', 'fetch', 'document'].includes(type) && !/wareGraphic|description|introduction|detail|commodity/i.test(u)) return;
    tasks.push((async () => {
      const headers = await response.allHeaders().catch(() => ({}));
      const contentType = headers['content-type'] || '';
      const row = { url: u, status: response.status(), resourceType: type, contentType, method: req.method(), body: null };
      if (['xhr', 'fetch', 'document'].includes(type) || /json|text|html|javascript/i.test(contentType) || /wareGraphic|description|introduction|detail/i.test(u)) {
        try {
          const text = await response.text();
          if (text.length <= MAX_BODY) row.body = text;
        } catch { /* opaque */ }
      }
      if (network.length < MAX_RESPONSES) network.push(row);
    })());
  });

  let navError = null;
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    navError = e?.message || String(e);
  }
  await page.waitForTimeout(3000);

  for (const label of ['商品详情', '商品介绍', '规格包装']) {
    const loc = page.getByText(label, { exact: true }).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(500);
      break;
    }
  }

  const detail = page.locator('#detail').first();
  if (await detail.count().catch(() => 0)) {
    await detail.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let oldHeight = 0;
    let stable = 0;
    for (let i = 0; i < 90; i += 1) {
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollBy(0, Math.max(520, Math.floor(window.innerHeight * 0.78)));
      await sleep(220);
      stable = h === oldHeight ? stable + 1 : 0;
      oldHeight = h;
      if (window.scrollY + window.innerHeight >= h - 10 && stable >= 3) break;
    }
  }).catch(() => {});
  await page.waitForTimeout(3500);
  await Promise.allSettled(tasks);

  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  const text = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  const block = blocked(title, text.slice(0, 120000), finalUrl);
  await fs.writeFile(path.join(outDir, 'BROWSER_PAGE.html'), html, 'utf8');
  await fs.writeFile(path.join(outDir, 'BROWSER_VISIBLE_TEXT.txt'), text.slice(0, 500000), 'utf8');
  await page.screenshot({ path: path.join(outDir, 'BROWSER_VIEWPORT.png'), fullPage: false }).catch(() => {});

  let detailHtml = null;
  let detailScreenshot = false;
  if (await detail.count().catch(() => 0)) {
    detailHtml = await detail.innerHTML().catch(() => null);
    if (detailHtml) await fs.writeFile(path.join(outDir, 'DETAIL_DOM.html'), detailHtml, 'utf8');
    const box = await detail.boundingBox().catch(() => null);
    if (box && box.width > 100 && box.height > 100 && box.height <= 16000) {
      await detail.screenshot({ path: path.join(outDir, 'DETAIL_SECTION.png') }).then(() => { detailScreenshot = true; }).catch(() => {});
    }
  }

  const dom = await page.evaluate(() => {
    const abs = (v) => { try { return v ? new URL(v, document.baseURI).href : null; } catch { return v; } };
    return [...document.images].map((img, index) => ({
      index,
      src: abs(img.currentSrc || img.src || img.dataset.src || img.dataset.lazyImg || img.dataset.lazyload || img.getAttribute('data-lazy-img') || img.getAttribute('data-original')),
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
      alt: img.alt || '',
      inDetail: Boolean(img.closest('#detail,[class*="detail"],[class*="Detail"],[class*="ssd"],[class*="description"]')),
    })).filter((x) => x.src);
  }).catch(() => []);
  await json(outDir, 'DOM_IMAGES.json', dom);

  const netDir = path.join(outDir, 'network');
  await fs.mkdir(netDir, { recursive: true });
  const index = [];
  const netImages = [];
  let bodyIndex = 0;
  for (const row of network) {
    const source = networkSource(row.url, row.body || '');
    const urls = row.body ? imageUrls(row.body) : [];
    let bodyFile = null;
    if (row.body && (source !== 'network-xhr' || urls.length)) {
      bodyIndex += 1;
      bodyFile = `network/${String(bodyIndex).padStart(3, '0')}_${safe(source)}.txt`;
      await fs.writeFile(path.join(outDir, bodyFile), row.body, 'utf8');
    }
    index.push({ url: row.url, status: row.status, resourceType: row.resourceType, contentType: row.contentType, method: row.method, source, bodyFile, imageCount: urls.length });
    for (const u of urls) netImages.push({ url: u, source, priority: source === 'network-ware-graphic' ? 0 : source === 'network-detail' ? 1 : 2 });
  }
  await json(outDir, 'NETWORK_INDEX.json', index);

  const map = new Map();
  const add = (row) => {
    const u = normalizeImage(row.url);
    if (!u || noiseImage(u)) return;
    const x = { ...row, url: u };
    const old = map.get(u);
    if (!old || x.priority < old.priority) map.set(u, x);
  };
  netImages.forEach(add);
  for (const img of dom) {
    if (img.inDetail) add({ url: img.src, source: 'dom-detail', priority: 1, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    else if (img.naturalWidth >= 500 && img.naturalHeight >= 250) add({ url: img.src, source: 'dom-large', priority: 3, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
  }
  const candidates = [...map.values()].sort((a, b) => a.priority - b.priority || ((b.naturalWidth || 0) * (b.naturalHeight || 0)) - ((a.naturalWidth || 0) * (a.naturalHeight || 0)));
  await json(outDir, 'BROWSER_IMAGE_CANDIDATES.json', candidates);
  const downloads = await downloadImages(context, candidates, outDir, finalUrl, maxImages);
  await json(outDir, 'BROWSER_IMAGE_MANIFEST.json', downloads);

  const wareGraphic = index.filter((x) => x.source === 'network-ware-graphic').length;
  const detailResponses = index.filter((x) => x.source === 'network-ware-graphic' || x.source === 'network-detail').length;
  const savedDetail = downloads.manifest.filter((x) => x.saved && ['network-ware-graphic', 'network-detail', 'dom-detail'].includes(x.source)).length;
  const summary = {
    inspectedAt: new Date().toISOString(),
    requestedUrl: inputUrl,
    targetUrl: target,
    sku,
    chromeExecutable: chrome,
    navigationError: navError,
    finalUrl,
    title,
    blockedMarkers: block,
    pageOk: !navError && block.length === 0,
    detailDomPresent: Boolean(detailHtml),
    detailScreenshotSaved: detailScreenshot,
    networkResponsesCaptured: index.length,
    wareGraphicResponses: wareGraphic,
    detailResponses,
    networkImageCandidates: netImages.length,
    domImages: dom.length,
    domDetailImages: dom.filter((x) => x.inDetail).length,
    candidateImages: candidates.length,
    attemptedImageDownloads: downloads.attempted,
    savedUsefulImages: downloads.saved,
    savedDetailImages: savedDetail,
    detailEvidenceRecovered: Boolean(detailHtml && (savedDetail > 0 || detailResponses > 0)),
    deepGeometryCandidate: savedDetail > 0,
    note: 'Deep-geometry candidate means detail-associated images were recovered. Visual engineering review is still required before using any internal dimension.',
  };
  await json(outDir, 'BROWSER_SUMMARY.json', summary);
  await browser.close();
  return summary;
}

const inputUrl = process.argv[2] || process.env.PRODUCT_URL;
const outDir = process.argv[3] || process.env.OUTPUT_DIR || 'browser-deep-results';
const maxImages = Number(process.argv[4] || process.env.MAX_IMAGES || 30);

if (!inputUrl) {
  console.error('Usage: node deep-jd-v2.js <product-url> [output-dir] [max-images]');
  process.exitCode = 2;
} else {
  try {
    const summary = await run(inputUrl, outDir, maxImages);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pageOk) process.exitCode = 3;
  } catch (error) {
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
    await json(outDir, 'BROWSER_FATAL.json', { inspectedAt: new Date().toISOString(), error: error?.stack || String(error) }).catch(() => {});
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
