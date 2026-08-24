import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAX_CAPTURE_BODY_CHARS = 2_000_000;
const MAX_CAPTURED_RESPONSES = 120;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const USEFUL_IMAGE_BYTES = 20 * 1024;

function detectSite(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('jd.com')) return 'jd';
  if (host.endsWith('taobao.com')) return 'taobao';
  if (host.endsWith('tmall.com')) return 'tmall';
  return 'other';
}

function extractSku(url) {
  const parsed = new URL(url);
  const fromPath = parsed.pathname.match(/(?:product\/|\/)(\d{8,})(?:\.html)?/i)?.[1];
  const fromQuery = parsed.searchParams.get('wareId') || parsed.searchParams.get('skuId') || parsed.searchParams.get('id');
  return fromPath || (fromQuery && /^\d{8,}$/.test(fromQuery) ? fromQuery : null);
}

function mobileTarget(url) {
  if (detectSite(url) !== 'jd') return url;
  const sku = extractSku(url);
  return sku ? `https://item.m.jd.com/product/${sku}.html` : url;
}

function decode(text = '') {
  return String(text)
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

function normalizeImageUrl(raw = '') {
  let value = decode(raw).trim();
  if (!value) return '';
  if (value.startsWith('//')) value = `https:${value}`;
  if (/^jfs\//i.test(value)) value = `https://m.360buyimg.com/mobilecms/${value}`;
  if (!/^https?:\/\//i.test(value)) return '';
  return value
    .replace(/\/pcpubliccms\/s\d+x\d+_jfs\//i, '/pcpubliccms/jfs/')
    .replace(/\/(n\d+)\/s\d+x\d+_jfs\//i, '/$1/jfs/')
    .replace(/\/sku\/s\d+x\d+_jfs\//i, '/sku/jfs/')
    .replace(/\/s\d+x\d+_jfs\//i, '/jfs/');
}

function isNoiseImage(url) {
  const lower = String(url).toLowerCase();
  const bad = [
    'error-new', '/jsresource/risk/', '/risk/static/', '/ling/jfs/',
    'businesslicense', 'certificate', 'qualification', 'license', 'licence',
    'permit', 'wenwangwen', 'qrcode', 'qr-code', 'sprite', 'loading',
    'transparent', 'default.image', '/shaidan/', '/comment/', '/avatar/',
  ];
  return bad.some((word) => lower.includes(word));
}

function extractImageUrls(text = '') {
  const decoded = decode(text);
  const set = new Set();
  const absolute = /(?:https?:)?\/\/[^\s"'<>\\)]+?(?:360buyimg\.com|jdimg\.com)[^\s"'<>\\)]*?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of decoded.matchAll(absolute)) {
    const url = normalizeImageUrl(match[0]);
    if (url && !isNoiseImage(url)) set.add(url);
  }
  const relative = /(?:^|["':,\s])(jfs\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|gif|avif))(?:["',\s}]|$)/gi;
  for (const match of decoded.matchAll(relative)) {
    const url = normalizeImageUrl(match[1]);
    if (url && !isNoiseImage(url)) set.add(url);
  }
  return [...set];
}

function blockedMarkers(title, text, finalUrl) {
  const haystack = `${title}\n${text}\n${finalUrl}`.toLowerCase();
  const patterns = [
    ['jd-login', /passport\.jd\.com|登录京东|京东登录/i],
    ['jd-risk', /risk_handler|京东验证|安全验证|访问验证|访问受限/i],
    ['captcha', /captcha|验证码|verify you are human/i],
    ['access-denied', /access denied|403 forbidden/i],
  ];
  return patterns.filter(([, re]) => re.test(haystack)).map(([name]) => name);
}

function extensionFor(contentType = '', url = '') {
  const type = contentType.toLowerCase();
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('avif')) return 'avif';
  return url.match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i)?.[1]?.replace(/^jpeg$/i, 'jpg').toLowerCase() ?? 'bin';
}

function safeName(value = '') {
  return String(value).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'evidence';
}

function sourceForNetwork(row) {
  const combined = `${row.url}\n${row.body ?? ''}`;
  if (/pc_item_getWareGraphic|graphicContent|waregraphic/i.test(combined)) return 'network-ware-graphic';
  if (/introduction|gettemplate|description|detail/i.test(combined)) return 'network-detail';
  return 'network-xhr';
}

async function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function writeJson(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function captureNetworkBody(response, row) {
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = headers['content-type'] ?? '';
  const request = response.request();
  const type = request.resourceType();
  const shouldRead = ['xhr', 'fetch', 'document'].includes(type)
    || /json|text|html|javascript/i.test(contentType)
    || /wareGraphic|description|introduction|detail|commodity/i.test(response.url());
  if (!shouldRead) return row;
  try {
    const body = await response.text();
    if (body && body.length <= MAX_CAPTURE_BODY_CHARS) row.body = body;
  } catch {
    // opaque/streamed body
  }
  return row;
}

async function downloadCandidateImages(context, candidates, outDir, referer, maxImages) {
  const imageDir = path.join(outDir, 'browser-images');
  await fs.mkdir(imageDir, { recursive: true });
  const manifest = [];
  let savedUseful = 0;
  let attempted = 0;

  for (const candidate of candidates) {
    if (savedUseful >= maxImages || attempted >= 120) break;
    attempted += 1;
    const row = {
      ...candidate,
      attemptedIndex: attempted,
      saved: false,
      usefulByBytes: false,
      file: null,
      bytes: 0,
      contentType: null,
      error: null,
    };
    try {
      const response = await context.request.get(candidate.url, {
        headers: { referer, 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        timeout: 15000,
      });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const contentType = response.headers()['content-type'] ?? 'application/octet-stream';
      if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`not-image:${contentType}`);
      const bytes = await response.body();
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image-too-large:${bytes.length}`);
      row.bytes = bytes.length;
      row.contentType = contentType;
      row.usefulByBytes = bytes.length >= USEFUL_IMAGE_BYTES;
      if (row.usefulByBytes) {
        const ext = extensionFor(contentType, candidate.url);
        const file = `${String(savedUseful + 1).padStart(2, '0')}_${safeName(candidate.source)}.${ext}`;
        await fs.writeFile(path.join(imageDir, file), bytes);
        row.saved = true;
        row.file = `browser-images/${file}`;
        savedUseful += 1;
      }
    } catch (error) {
      row.error = error?.message ?? String(error);
    }
    manifest.push(row);
  }
  return { attempted, savedUseful, manifest };
}

async function run(url, outDir, maxImages) {
  await fs.mkdir(outDir, { recursive: true });
  const targetUrl = mobileTarget(url);
  const site = detectSite(targetUrl);
  const sku = extractSku(targetUrl);
  const chrome = await findChromeExecutable();
  if (!chrome) throw new Error('System Chrome/Chromium not found on runner.');

  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    screen: { width: 430, height: 932 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: USER_AGENT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();

  const network = [];
  const responseTasks = [];
  page.on('response', (response) => {
    if (network.length + responseTasks.length >= MAX_CAPTURED_RESPONSES) return;
    const request = response.request();
    const type = request.resourceType();
    const urlValue = response.url();
    if (!['xhr', 'fetch', 'document'].includes(type)
      && !/wareGraphic|description|introduction|detail|commodity/i.test(urlValue)) return;
    const task = (async () => {
      const headers = await response.allHeaders().catch(() => ({}));
      const row = {
        url: urlValue,
        status: response.status(),
        resourceType: type,
        contentType: headers['content-type'] ?? '',
        method: request.method(),
        body: null,
      };
      await captureNetworkBody(response, row);
      if (network.length < MAX_CAPTURED_RESPONSES) network.push(row);
    })();
    responseTasks.push(task);
  });

  const startedAt = new Date().toISOString();
  let navigationError = null;
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    navigationError = error?.message ?? String(error);
  }
  await page.waitForTimeout(3500);

  for (const label of ['商品详情', '商品介绍', '规格包装']) {
    const locator = page.getByText(label, { exact: true }).first();
    if (await locator.count().catch(() => 0)) {
      await locator.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(500);
      break;
    }
  }

  const detailLocator = page.locator('#detail').first();
  if (await detailLocator.count().catch(() => 0)) {
    await detailLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let stable = 0;
    let previousHeight = 0;
    for (let i = 0; i < 90; i += 1) {
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollBy(0, Math.max(520, Math.floor(window.innerHeight * 0.78)));
      await delay(220);
      const atBottom = window.scrollY + window.innerHeight >= height - 10;
      stable = height === previousHeight ? stable + 1 : 0;
      previousHeight = height;
      if (atBottom && stable >= 3) break;
    }
  }).catch(() => {});
  await page.waitForTimeout(3500);
  await Promise.allSettled(responseTasks);

  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  const visibleText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  const markers = blockedMarkers(title, visibleText.slice(0, 100000), finalUrl);

  await fs.writeFile(path.join(outDir, 'BROWSER_PAGE.html'), html, 'utf8');
  await fs.writeFile(path.join(outDir, 'BROWSER_VISIBLE_TEXT.txt'), visibleText.slice(0, 500000), 'utf8');
  await page.screenshot({ path: path.join(outDir, 'BROWSER_VIEWPORT.png'), fullPage: false }).catch(() => {});

  let detailHtml = null;
  let detailScreenshot = false;
  if (await detailLocator.count().catch(() => 0)) {
    detailHtml = await detailLocator.innerHTML().catch(() => null);
    if (detailHtml) await fs.writeFile(path.join(outDir, 'DETAIL_DOM.html'), detailHtml, 'utf8');
    const box = await detailLocator.boundingBox().catch(() => null);
    if (box && box.width > 100 && box.height > 100 && box.height <= 16000) {
      await detailLocator.screenshot({ path: path.join(outDir, 'DETAIL_SECTION.png') }).then(() => { detailScreenshot = true; }).catch(() => {});
    }
  }

  const domData = await page.evaluate(() => {
    const absolute = (value) => {
      if (!value) return null;
      try { return new URL(value, document.baseURI).href; } catch { return value; }
    };
    const pick = (img) => absolute(
      img.currentSrc || img.src || img.dataset.src || img.dataset.lazyImg || img.dataset.lazyload
      || img.getAttribute('data-lazy-img') || img.getAttribute('data-original') || img.getAttribute('data-origin'),
    );
    const all = [...document.images].map((img, index) => ({
      index,
      src: pick(img),
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
      alt: img.alt || '',
      inDetail: Boolean(img.closest('#detail,[class*="detail"],[class*="Detail"],[class*="ssd"],[class*="description"]')),
      ancestorClass: img.parentElement?.className ? String(img.parentElement.className).slice(0, 200) : '',
    })).filter((x) => x.src);
    const resources = performance.getEntriesByType('resource').map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType }));
    return { all, resources };
  }).catch(() => ({ all: [], resources: [] }));

  await writeJson(outDir, 'DOM_IMAGES.json', domData.all);
  await writeJson(outDir, 'RESOURCES_BROWSER.json', domData.resources.slice(0, 2000));

  const networkDir = path.join(outDir, 'network');
  await fs.mkdir(networkDir, { recursive: true });
  const networkIndex = [];
  const networkImageRows = [];
  let bodyNo = 0;
  for (const row of network) {
    const source = sourceForNetwork(row);
    const imageUrls = row.body ? extractImageUrls(row.body) : [];
    let bodyFile = null;
    if (row.body && (source !== 'network-xhr' || imageUrls.length)) {
      bodyNo += 1;
      bodyFile = `network/${String(bodyNo).padStart(3, '0')}_${safeName(source)}.txt`;
      await fs.writeFile(path.join(outDir, bodyFile), row.body, 'utf8');
    }
    networkIndex.push({ ...row, body: undefined, bodyFile, source, imageCount: imageUrls.length });
    for (const imageUrl of imageUrls) {
      networkImageRows.push({
        url: imageUrl,
        source,
        priority: source === 'network-ware-graphic' ? 0 : source === 'network-detail' ? 1 : 2,
        contextHint: source !== 'network-xhr',
      });
    }
  }
  await writeJson(outDir, 'NETWORK_INDEX.json', networkIndex);

  const candidateMap = new Map();
  const addCandidate = (candidate) => {
    const normalized = normalizeImageUrl(candidate.url);
    if (!normalized || isNoiseImage(normalized)) return;
    const row = { ...candidate, url: normalized };
    const old = candidateMap.get(normalized);
    if (!old || row.priority < old.priority) candidateMap.set(normalized, row);
  };
  for (const row of networkImageRows) addCandidate(row);
  for (const img of domData.all) {
    if (img.inDetail) addCandidate({ url: img.src, source: 'dom-detail', priority: 1, contextHint: true, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    else if (img.naturalWidth >= 500 && img.naturalHeight >= 250) addCandidate({ url: img.src, source: 'dom-large', priority: 3, contextHint: false, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
  }
  const candidates = [...candidateMap.values()].sort((a, b) => a.priority - b.priority || ((b.naturalWidth ?? 0) * (b.naturalHeight ?? 0)) - ((a.naturalWidth ?? 0) * (a.naturalHeight ?? 0)));
  await writeJson(outDir, 'BROWSER_IMAGE_CANDIDATES.json', candidates);
  const downloads = await downloadCandidateImages(context, candidates, outDir, finalUrl, maxImages);
  await writeJson(outDir, 'BROWSER_IMAGE_MANIFEST.json', downloads);

  const wareGraphicResponses = networkIndex.filter((row) => row.source === 'network-ware-graphic');
  const detailResponses = networkIndex.filter((row) => ['network-ware-graphic', 'network-detail'].includes(row.source));
  const savedDetailImages = downloads.manifest.filter((row) => row.saved && ['network-ware-graphic', 'network-detail', 'dom-detail'].includes(row.source)).length;
  const summary = {
    inspectedAt: new Date().toISOString(),
    startedAt,
    requestedUrl: url,
    targetUrl,
    site,
    sku,
    chromeExecutable: chrome,
    navigationError,
    finalUrl,
    title,
    blockedMarkers: markers,
    pageOk: !navigationError && markers.length === 0,
    detailDomPresent: Boolean(detailHtml),
    detailScreenshotSaved: detailScreenshot,
    networkResponsesCaptured: networkIndex.length,
    wareGraphicResponses: wareGraphicResponses.length,
    detailResponses: detailResponses.length,
    networkImageCandidates: networkImageRows.length,
    domImages: domData.all.length,
    domDetailImages: domData.all.filter((x) => x.inDetail).length,
    candidateImages: candidates.length,
    attemptedImageDownloads: downloads.attempted,
    savedUsefulImages: downloads.savedUseful,
    savedDetailImages,
    detailEvidenceRecovered: Boolean(detailHtml && (savedDetailImages > 0 || detailResponses.length > 0)),
    deepGeometryCandidate: savedDetailImages > 0,
    note: 'detailEvidenceRecovered means the browser reached detail-associated DOM/network evidence. It does not by itself prove that a dimension drawing is present; images still require visual engineering review.',
  };
  await writeJson(outDir, 'BROWSER_SUMMARY.json', summary);
  await browser.close();
  return summary;
}

const url = process.argv[2] || process.env.PRODUCT_URL;
const outDir = process.argv[3] || process.env.OUTPUT_DIR || 'browser-deep-results';
const maxImages = Number(process.argv[4] || process.env.MAX_IMAGES || 30);
if (!url) {
  console.error('Usage: node deep-jd.js <product-url> [output-dir] [max-images]');
  process.exitCode = 2;
} else {
  run(url, outDir, maxImages)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.pageOk) process.exitCode = 3;
    })
    .catch(async (error) => {
      await fs.mkdir(outDir, { recursive: true }).catch(() => {});
      await writeJson(outDir, 'BROWSER_FATAL.json', { error: error?.stack ?? String(error), inspectedAt: new Date().toISOString() }).catch(() => {});
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
