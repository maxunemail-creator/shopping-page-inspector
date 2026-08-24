import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifyProduct } from './url.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_MAX_IMAGES = 36;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function timeoutSignal(ms = 15000) {
  return AbortSignal.timeout(ms);
}

function decodeHtml(text = '') {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripTags(text = '') {
  return decodeHtml(String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImageUrl(raw = '') {
  let url = String(raw).trim().replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

function normalizeJdOriginal(url) {
  const normalized = normalizeImageUrl(url);
  if (!normalized) return '';
  return normalized
    .replace(/\/pcpubliccms\/s\d+x\d+_jfs\//i, '/pcpubliccms/jfs/')
    .replace(/\/(n\d+)\/s\d+x\d+_jfs\//i, '/$1/jfs/')
    .replace(/\/sku\/s\d+x\d+_jfs\//i, '/sku/jfs/')
    .replace(/\/s\d+x\d+_jfs\//i, '/jfs/');
}

function isJdImage(url) {
  return /(?:360buyimg\.com|jdimg\.com)/i.test(url)
    && /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url);
}

function isNoiseJdImage(url) {
  const lower = String(url).toLowerCase();
  const bad = [
    'error-new', 'try_03', 'try1_07', 'yinying_06', 'error_06',
    '/jsresource/risk/', '/risk/static/', '/ling/jfs/',
    'businesslicense', 'business-license', 'certificate', 'certification',
    'qualification', 'licence', 'license', 'permit', 'wenwangwen',
    'qrcode', 'qr-code', 'sprite', 'loading', 'transparent', 'default.image',
  ];
  return bad.some((word) => lower.includes(word));
}

function collectImageUrlsFromText(text = '') {
  const urls = new Set();
  const decoded = String(text).replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const patterns = [
    /(?:https?:)?\/\/[^\s"'<>\\)]+?(?:360buyimg\.com|jdimg\.com)[^\s"'<>\\)]*?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi,
    /(?:src|data-src|data-lazy-img|data-lazyload|data-original|data-origin|data-url)=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(decoded)) !== null) {
      const url = normalizeJdOriginal(match[1] ?? match[0]);
      if (url && isJdImage(url) && !isNoiseJdImage(url)) urls.add(url);
    }
  }
  return [...urls];
}

function collectImageUrlsFromPayload(value, seen = new Set(), depth = 0) {
  if (value == null || depth > 6) return [];
  if (typeof value === 'string') return collectImageUrlsFromText(value);
  if (typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const urls = [];
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const entry of values) urls.push(...collectImageUrlsFromPayload(entry, seen, depth + 1));
  return [...new Set(urls.map(normalizeJdOriginal).filter((url) => url && !isNoiseJdImage(url)))];
}

function blockedJdResponse(finalUrl = '', text = '') {
  const url = String(finalUrl).toLowerCase();
  if (/passport\.jd\.com|\/risk_handler\/|\/error2\.aspx|safe\.jd\.com|sec\.jd\.com/.test(url)) return true;
  const title = stripTags(String(text).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return /京东验证|安全验证|访问验证|登录京东|京东登录|页面不存在|访问受限/i.test(title);
}

async function fetchText(url, { referer, timeoutMs = 15000, accept = '*/*' } = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      ...(referer ? { referer } : {}),
    },
    signal: timeoutSignal(timeoutMs),
  });
  const text = await response.text();
  return {
    requestedUrl: url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') ?? '',
    blocked: blockedJdResponse(response.url, text),
    text,
  };
}

function parseJsonLoose(text = '') {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const firstArray = trimmed.indexOf('[');
  const lastArray = trimmed.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    try { return JSON.parse(trimmed.slice(firstArray, lastArray + 1)); } catch { /* continue */ }
  }
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try { return JSON.parse(trimmed.slice(firstObject, lastObject + 1)); } catch { /* continue */ }
  }
  return null;
}

function parseJdTitle(html = '') {
  const candidates = [
    html.match(/<div[^>]+class=["'][^"']*sku-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1],
    html.match(/\bname\s*:\s*'([^']+)'/i)?.[1],
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const title = stripTags(candidate).replace(/\s*[-—_]\s*京东.*$/i, '').trim();
    if (title && !/登录京东|京东登录|京东验证|安全验证|访问验证|页面不存在|访问受限/i.test(title)) return title;
  }
  return null;
}

function parseJdParameters(html = '') {
  const rows = [];
  const liPattern = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liPattern.exec(html)) !== null && rows.length < 120) {
    const attrs = match[1];
    const body = stripTags(match[2]);
    const titleAttr = attrs.match(/\btitle=["']([^"']+)["']/i)?.[1];
    const text = decodeHtml(titleAttr ?? body).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 220) continue;
    if (!/[：:]|品牌|型号|商品编号|材质|尺寸|风格|产地|包装/i.test(text)) continue;
    rows.push(text);
  }
  return [...new Set(rows)];
}

function extractGraphicContent(payload, raw = '') {
  const candidates = [payload?.data?.graphicContent, payload?.graphicContent, payload?.data?.content, payload?.content];
  return candidates.find((value) => typeof value === 'string' && value.length > 20) ?? raw;
}

async function fetchJdPageCandidates(skuId) {
  const urls = [
    `https://item.jd.com/${skuId}.html`,
    `https://item.m.jd.com/product/${skuId}.html`,
    `https://item.m.jd.com/ware/view.action?wareId=${skuId}`,
  ];
  const attempts = [];
  let selected = null;
  for (const url of urls) {
    try {
      const response = await fetchText(url, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        timeoutMs: 20000,
      });
      const title = response.blocked ? null : parseJdTitle(response.text);
      const parameters = response.blocked ? [] : parseJdParameters(response.text);
      const images = response.blocked ? [] : collectImageUrlsFromText(response.text);
      const row = { ...response, title, parameters, images };
      attempts.push(row);
      if (!selected && response.ok && !response.blocked && (title || parameters.length || images.length)) selected = row;
    } catch (error) {
      attempts.push({ requestedUrl: url, ok: false, blocked: false, error: error?.message ?? String(error), text: '', title: null, parameters: [], images: [] });
    }
  }
  return { attempts, selected };
}

async function fetchJdPrice(skuId, referer) {
  const urls = [
    `https://p.3.cn/prices/mgets?type=1&skuIds=J_${encodeURIComponent(skuId)}`,
    `http://p.3.cn/prices/mgets?type=1&skuIds=J_${encodeURIComponent(skuId)}`,
  ];
  const attempts = [];
  for (const url of urls) {
    try {
      const response = await fetchText(url, { referer, accept: 'application/json,text/plain,*/*', timeoutMs: 12000 });
      const data = parseJsonLoose(response.text);
      attempts.push({ ...response, data });
      if (response.ok && !response.blocked && Array.isArray(data) && data.length) return { attempts, data };
    } catch (error) {
      attempts.push({ requestedUrl: url, ok: false, error: error?.message ?? String(error), data: null });
    }
  }
  return { attempts, data: null };
}

async function fetchJdWareGraphic(skuId, referer) {
  const body = encodeURIComponent(JSON.stringify({ skuId: String(skuId) }));
  const urls = [
    `https://api.m.jd.com/client.action?appid=item-v3&functionId=pc_item_getWareGraphic&client=pc&clientVersion=1.0.0&body=${body}`,
    `https://api.m.jd.com/api?appid=item-v3&functionId=pc_item_getWareGraphic&client=pc&clientVersion=1.0.0&body=${body}`,
  ];
  const attempts = [];
  for (const url of urls) {
    try {
      const response = await fetchText(url, { referer, accept: 'application/json,text/plain,*/*', timeoutMs: 20000 });
      const data = parseJsonLoose(response.text);
      const content = extractGraphicContent(data, response.text);
      const imageUrls = response.blocked ? [] : collectImageUrlsFromText(content);
      const row = { ...response, data, imageUrls, contentLength: content.length };
      attempts.push(row);
      if (response.ok && !response.blocked && imageUrls.length) return { attempts, selected: row };
    } catch (error) {
      attempts.push({ requestedUrl: url, ok: false, blocked: false, error: error?.message ?? String(error), data: null, imageUrls: [] });
    }
  }
  return { attempts, selected: null };
}

async function fetchJdLegacyDescriptions(skuId, referer) {
  const urls = [
    `https://dx.3.cn/desc/${encodeURIComponent(skuId)}`,
    `https://cd.jd.com/description/channel?skuId=${encodeURIComponent(skuId)}&mainSkuId=${encodeURIComponent(skuId)}&charset=utf-8&cdn=2`,
  ];
  const attempts = [];
  for (const url of urls) {
    try {
      const response = await fetchText(url, { referer, timeoutMs: 15000 });
      const data = parseJsonLoose(response.text);
      const content = extractGraphicContent(data, response.text);
      const imageUrls = response.blocked ? [] : collectImageUrlsFromText(content);
      attempts.push({ ...response, data, raw: response.text, imageUrls });
    } catch (error) {
      attempts.push({ requestedUrl: url, ok: false, blocked: false, error: error?.message ?? String(error), imageUrls: [] });
    }
  }
  return attempts;
}

async function fetchJdItemSoa(skuId, referer) {
  const url = `https://item-soa.jd.com/getWareBusiness?skuId=${encodeURIComponent(skuId)}`;
  try {
    const response = await fetchText(url, { referer, accept: 'application/json,text/plain,*/*', timeoutMs: 15000 });
    const data = response.blocked ? null : parseJsonLoose(response.text);
    return { ...response, data, imageUrls: response.blocked ? [] : collectImageUrlsFromPayload(data) };
  } catch (error) {
    return { requestedUrl: url, ok: false, blocked: false, error: error?.message ?? String(error), data: null, imageUrls: [] };
  }
}

async function fetchJdReviewSummary(skuId, referer) {
  const candidates = [
    `https://club.jd.com/comment/productCommentSummaries.action?referenceIds=${encodeURIComponent(skuId)}`,
    `https://sclub.jd.com/comment/productPageComments.action?productId=${encodeURIComponent(skuId)}&score=0&sortType=5&page=0&pageSize=10&isShadowSku=0&fold=1`,
  ];
  const attempts = [];
  for (const url of candidates) {
    try {
      const response = await fetchText(url, { referer, accept: 'application/json,text/plain,*/*', timeoutMs: 15000 });
      const data = response.blocked ? null : parseJsonLoose(response.text);
      attempts.push({ ...response, data });
      if (response.ok && !response.blocked && data) return { attempts, data };
    } catch (error) {
      attempts.push({ requestedUrl: url, ok: false, blocked: false, error: error?.message ?? String(error), data: null });
    }
  }
  return { attempts, data: null };
}

function extensionFor(contentType = '', url = '') {
  const type = contentType.toLowerCase();
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('avif')) return 'avif';
  const ext = url.match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i)?.[1];
  return ext ? ext.replace(/^jpeg$/i, 'jpg').toLowerCase() : 'bin';
}

function rankImages({ detail = [], html = [], soa = [] }) {
  const map = new Map();
  const add = (url, source, priority) => {
    const normalized = normalizeJdOriginal(url);
    if (!normalized || !isJdImage(normalized) || isNoiseJdImage(normalized)) return;
    const existing = map.get(normalized);
    if (!existing || priority < existing.priority) map.set(normalized, { url: normalized, source, priority });
  };
  detail.forEach((url) => add(url, 'detail', 0));
  html.forEach((url) => add(url, 'item-html', 1));
  soa.forEach((url) => add(url, 'item-soa', 2));
  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

async function downloadImages(images, outputDir, referer, maxImages = DEFAULT_MAX_IMAGES) {
  const imageDir = path.join(outputDir, 'images');
  await fs.mkdir(imageDir, { recursive: true });
  const selected = images.slice(0, maxImages);
  const manifest = selected.map((entry, index) => ({ index: index + 1, ...entry, saved: false, file: null, bytes: 0, contentType: null, error: null }));
  let totalBytes = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, selected.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= selected.length) return;
      const row = manifest[index];
      try {
        const response = await fetch(row.url, {
          redirect: 'follow',
          headers: { 'user-agent': USER_AGENT, referer, accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
          signal: timeoutSignal(12000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`not-image:${contentType}`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_IMAGE_BYTES) throw new Error(`image-too-large:${declared}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image-too-large:${bytes.length}`);
        const ext = extensionFor(contentType, row.url);
        const file = `${String(index + 1).padStart(2, '0')}_${row.source.replace(/[^a-z0-9-]/gi, '_')}.${ext}`;
        await fs.writeFile(path.join(imageDir, file), bytes);
        row.saved = true;
        row.file = `images/${file}`;
        row.bytes = bytes.length;
        row.contentType = contentType;
        totalBytes += bytes.length;
      } catch (error) {
        row.error = error?.message ?? String(error);
      }
    }
  });
  await Promise.all(workers);
  return { requested: selected.length, saved: manifest.filter((x) => x.saved).length, totalBytes, images: manifest };
}

async function writeJson(outputDir, name, value) {
  await fs.writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function compactAttempt(entry) {
  return {
    requestedUrl: entry.requestedUrl,
    finalUrl: entry.finalUrl ?? null,
    status: entry.status ?? null,
    ok: Boolean(entry.ok),
    blocked: Boolean(entry.blocked),
    error: entry.error ?? null,
    title: entry.title ?? null,
    parameterCount: entry.parameters?.length ?? 0,
    imageCount: entry.images?.length ?? entry.imageUrls?.length ?? 0,
  };
}

async function inspectJd(product, outputDir, options = {}) {
  const skuId = product.itemId;
  const itemUrl = product.canonicalUrl;
  const maxImages = Number(options.maxImages ?? process.env.MAX_IMAGES ?? DEFAULT_MAX_IMAGES);
  const result = {
    site: 'jd', skuId, canonicalUrl: itemUrl, inspectedAt: new Date().toISOString(), execution: 'zero-cu-http',
    requests: {}, title: null, parameters: [], price: null, reviewSummary: null, imageEvidence: null,
  };

  const pages = await fetchJdPageCandidates(skuId);
  result.requests.itemPages = pages.attempts.map(compactAttempt);
  result.publicPageBlocked = pages.attempts.length > 0 && pages.attempts.every((x) => x.blocked || !x.ok);
  if (pages.selected) {
    result.title = pages.selected.title;
    result.parameters = pages.selected.parameters;
    await fs.writeFile(path.join(outputDir, 'PAGE.html'), pages.selected.text, 'utf8');
  } else if (pages.attempts[0]?.text) {
    await fs.writeFile(path.join(outputDir, 'PAGE_BLOCKED.html'), pages.attempts[0].text, 'utf8');
  }
  await writeJson(outputDir, 'PAGE_ATTEMPTS.json', result.requests.itemPages);

  const [price, wareGraphic, legacyDescriptions, itemSoa, reviews] = await Promise.all([
    fetchJdPrice(skuId, itemUrl),
    fetchJdWareGraphic(skuId, itemUrl),
    fetchJdLegacyDescriptions(skuId, itemUrl),
    fetchJdItemSoa(skuId, itemUrl),
    fetchJdReviewSummary(skuId, itemUrl),
  ]);

  result.requests.price = price.attempts.map(compactAttempt);
  result.price = Array.isArray(price.data) ? price.data[0] ?? null : price.data;
  await writeJson(outputDir, 'PRICE.json', price.data ?? { attempts: result.requests.price, error: 'unavailable' });

  result.requests.wareGraphic = wareGraphic.attempts.map(compactAttempt);
  await writeJson(outputDir, 'WARE_GRAPHIC.json', wareGraphic.selected?.data ?? { attempts: result.requests.wareGraphic, error: 'unavailable' });
  if (wareGraphic.selected?.text) await fs.writeFile(path.join(outputDir, 'WARE_GRAPHIC_RAW.txt'), wareGraphic.selected.text, 'utf8');

  result.requests.itemSoa = compactAttempt(itemSoa);
  await writeJson(outputDir, 'ITEM_SOA.json', itemSoa.data ?? { error: itemSoa.blocked ? 'blocked/error redirect' : itemSoa.error ?? 'unavailable' });

  result.requests.reviews = reviews.attempts.map(compactAttempt);
  result.reviewSummary = reviews.data;
  await writeJson(outputDir, 'REVIEWS.json', reviews.data ?? { attempts: result.requests.reviews, error: 'unavailable' });

  result.requests.legacyDescriptions = legacyDescriptions.map(compactAttempt);
  await writeJson(outputDir, 'LEGACY_DESCRIPTIONS.json', result.requests.legacyDescriptions);
  for (const [index, entry] of legacyDescriptions.entries()) {
    if (entry.raw) await fs.writeFile(path.join(outputDir, `LEGACY_DESC_${index + 1}.txt`), entry.raw, 'utf8');
  }

  const detailImages = [
    ...(wareGraphic.selected?.imageUrls ?? []),
    ...legacyDescriptions.flatMap((entry) => entry.blocked ? [] : entry.imageUrls ?? []),
  ].filter((url) => !isNoiseJdImage(url));
  const htmlImages = pages.selected?.images ?? [];
  const soaImages = itemSoa.blocked ? [] : itemSoa.imageUrls ?? [];
  const rankedImages = rankImages({ detail: detailImages, html: htmlImages, soa: soaImages });
  const imageEvidence = await downloadImages(rankedImages, outputDir, itemUrl, maxImages);
  result.imageEvidence = {
    discovered: rankedImages.length,
    detailDiscovered: new Set(detailImages.map(normalizeJdOriginal).filter(Boolean)).size,
    htmlDiscovered: new Set(htmlImages.map(normalizeJdOriginal).filter(Boolean)).size,
    soaDiscovered: new Set(soaImages.map(normalizeJdOriginal).filter(Boolean)).size,
    ...imageEvidence,
  };
  await writeJson(outputDir, 'IMAGE_MANIFEST.json', result.imageEvidence);

  const priceValue = result.price?.p ?? result.price?.op ?? null;
  const engineeringUsable = result.parameters.length > 0 || result.imageEvidence.detailDiscovered > 0;
  const metadataUsable = Boolean(result.title || priceValue);
  result.usable = engineeringUsable || metadataUsable;
  result.evidenceClass = engineeringUsable ? 'ENGINEERING_USABLE' : metadataUsable ? 'METADATA_ONLY' : 'BLOCKED_OR_EMPTY';
  result.engineeringEvidence = {
    title: Boolean(result.title),
    price: Boolean(priceValue),
    parameters: result.parameters.length,
    detailImages: result.imageEvidence.detailDiscovered,
    savedImages: result.imageEvidence.saved,
    engineeringUsable,
    browserOrUserSessionNeeded: !engineeringUsable,
  };
  return result;
}

async function inspectPassivePage(product, outputDir, options = {}) {
  const response = await fetchText(product.canonicalUrl, { accept: 'text/html,application/xhtml+xml,*/*', timeoutMs: 20000 });
  await fs.writeFile(path.join(outputDir, response.blocked ? 'PAGE_BLOCKED.html' : 'PAGE.html'), response.text, 'utf8');
  const imageUrls = response.blocked ? [] : (product.site === 'taobao' || product.site === 'tmall'
    ? [...new Set([...response.text.matchAll(/(?:https?:)?\/\/[^\s"'<>\\)]+?(?:alicdn\.com|tbcdn\.cn)[^\s"'<>\\)]*?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\)]*)?/gi)].map((match) => normalizeImageUrl(match[0])).filter(Boolean))]
    : []);
  const title = response.blocked ? null : stripTags(response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || null;
  return {
    site: product.site,
    itemId: product.itemId,
    canonicalUrl: product.canonicalUrl,
    inspectedAt: new Date().toISOString(),
    execution: 'zero-cu-passive-http',
    title,
    page: { status: response.status, ok: response.ok, blocked: response.blocked, finalUrl: response.finalUrl, bytes: Buffer.byteLength(response.text) },
    publicImageUrls: imageUrls.slice(0, Number(options.maxImages ?? DEFAULT_MAX_IMAGES)),
    usable: Boolean(title || imageUrls.length),
    evidenceClass: title || imageUrls.length ? 'METADATA_ONLY' : 'BLOCKED_OR_EMPTY',
    note: 'Taobao/Tmall zero-CU support is passive-only in v0.5; no signed/private API or access-control bypass is attempted.',
  };
}

export async function zeroCuInspect(url, outputDir = 'zero-cu-results', options = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const product = identifyProduct(url);
  const summary = product.site === 'jd' && product.itemId
    ? await inspectJd(product, outputDir, options)
    : await inspectPassivePage(product, outputDir, options);
  await writeJson(outputDir, 'ZERO_CU_SUMMARY.json', summary);
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.argv[2] ?? process.env.PRODUCT_URL;
  const outputDir = process.argv[3] ?? process.env.OUTPUT_DIR ?? 'zero-cu-results';
  if (!url) {
    console.error('Usage: node src/zero-cu.js <product-url> [output-dir]');
    process.exitCode = 2;
  } else {
    try {
      const summary = await zeroCuInspect(url, outputDir);
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.usable) process.exitCode = 3;
    } catch (error) {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    }
  }
}
