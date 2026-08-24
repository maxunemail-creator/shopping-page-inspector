import fs from 'node:fs/promises';
import path from 'node:path';
import { extractJdMobileStructured } from './jd-mobile-structured.js';

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const USEFUL_IMAGE_BYTES = 20 * 1024;

function decode(text = '') {
  return String(text)
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(text = '') {
  return decode(String(text).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(raw = '') {
  let url = decode(raw).trim();
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return '';
  return url
    .replace(/\/pcpubliccms\/s\d+x\d+_jfs\//i, '/pcpubliccms/jfs/')
    .replace(/\/(n\d+)\/s\d+x\d+_jfs\//i, '/$1/jfs/')
    .replace(/\/sku\/s\d+x\d+_jfs\//i, '/sku/jfs/')
    .replace(/\/s\d+x\d+_jfs\//i, '/jfs/');
}

function isNoise(url) {
  const lower = String(url).toLowerCase();
  const bad = [
    'error-new', '/jsresource/risk/', '/risk/static/', '/ling/jfs/',
    'businesslicense', 'certificate', 'qualification', 'license', 'licence',
    'permit', 'wenwangwen', 'qrcode', 'qr-code', 'sprite', 'loading',
    'transparent', 'default.image', '/shaidan/', '/comment/', '/avatar/',
  ];
  return bad.some((x) => lower.includes(x));
}

function productTitle(html) {
  const candidates = [
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const title = stripTags(raw)
      .replace(/【图片\s*价格\s*品牌\s*评论】.*$/i, '')
      .replace(/\s*[-—_]\s*京东.*$/i, '')
      .trim();
    if (title && !/京东\(JD\.COM\)-正品低价|京东商城|京东验证|登录京东|安全验证/i.test(title)) return title;
  }
  return null;
}

function imageRank(url, context) {
  const lower = url.toLowerCase();
  const ctx = context.toLowerCase();
  if (/detail|graphic|description|waregraphic|图文|详情/.test(ctx)) return 0;
  if (/\/(?:sku|imgzone|jdcms|pcpubliccms|babel|cms)\/jfs\//.test(lower)) return 1;
  if (/\/n\d+\/jfs\//.test(lower)) return 2;
  return 3;
}

function collectPageImages(html) {
  const decoded = decode(html);
  const pattern = /(?:https?:)?\/\/[^\s"'<>\\)]+?(?:360buyimg\.com|jdimg\.com)[^\s"'<>\\)]*?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi;
  const map = new Map();
  let match;
  let sequence = 0;
  while ((match = pattern.exec(decoded)) !== null) {
    const url = normalize(match[0]);
    if (!url || isNoise(url)) continue;
    const context = decoded.slice(Math.max(0, match.index - 300), Math.min(decoded.length, match.index + match[0].length + 300));
    const rank = imageRank(url, context);
    const old = map.get(url);
    const row = { url, rank, sequence: sequence++, source: 'page-scan', contextHint: /detail|graphic|description|waregraphic|图文|详情/i.test(context) };
    if (!old || rank < old.rank) map.set(url, row);
  }
  return [...map.values()].sort((a, b) => a.rank - b.rank || a.sequence - b.sequence);
}

function structuredImageCandidates(structured) {
  if (!structured) return [];
  const rows = [];
  let sequence = -1000;
  const add = (url, rank, source) => {
    const normalized = normalize(url);
    if (!normalized || isNoise(normalized)) return;
    if (rows.some((row) => row.url === normalized)) return;
    rows.push({ url: normalized, rank, sequence: sequence++, source, contextHint: source === 'exact-sku' });
  };
  add(structured.selectedImageUrl, -3, 'exact-sku');
  for (const url of structured.mainImageUrls ?? []) add(url, -2, 'main-image');
  for (const url of structured.uniqueVariantImageUrls ?? []) add(url, -1, 'variant-image');
  return rows;
}

function mergeCandidates(structuredRows, pageRows) {
  const map = new Map();
  for (const row of [...structuredRows, ...pageRows]) {
    const old = map.get(row.url);
    if (!old || row.rank < old.rank) map.set(row.url, row);
  }
  return [...map.values()].sort((a, b) => a.rank - b.rank || a.sequence - b.sequence);
}

function collectHints(html, structured) {
  const text = decode(html);
  const patterns = [
    /\b\d{2,4}\s*(?:\*|x|X|×)\s*\d{2,4}(?:\s*(?:\*|x|X|×)\s*\d{2,4})?\s*(?:cm|mm|厘米|毫米)?/g,
    /\b(?:18|20|25|30)\s*mm\b/gi,
    /.{0,60}(?:洞洞板|桌板厚度|桌腿|横梁|显示器支架|书架).{0,100}/gi,
  ];
  const hints = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/<[^>]+>/g, ' ').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
      if (value.length >= 3 && value.length <= 240) hints.push(value);
      if (hints.length >= 80) break;
    }
    if (hints.length >= 80) break;
  }
  if (structured?.selectedVariant?.size) hints.unshift(structured.selectedVariant.size);
  if (structured?.selectedVariant?.color) hints.unshift(structured.selectedVariant.color);
  return [...new Set(hints)];
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

async function downloadImages(images, outputDir, referer, maxImages) {
  const dir = path.join(outputDir, 'mobile-images');
  await fs.mkdir(dir, { recursive: true });
  const selected = images.slice(0, maxImages);
  const manifest = [];
  for (const [index, item] of selected.entries()) {
    const row = { ...item, index: index + 1, saved: false, usefulByBytes: false, file: null, bytes: 0, contentType: null, error: null };
    try {
      const response = await fetch(item.url, {
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, referer, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      if (!contentType.startsWith('image/')) throw new Error(`not-image:${contentType}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image-too-large:${bytes.length}`);
      const safeSource = String(item.source ?? `r${item.rank}`).replace(/[^a-z0-9-]/gi, '_');
      const file = `${String(index + 1).padStart(2, '0')}_${safeSource}.${extensionFor(contentType, item.url)}`;
      await fs.writeFile(path.join(dir, file), bytes);
      row.saved = true;
      row.usefulByBytes = bytes.length >= USEFUL_IMAGE_BYTES;
      row.file = `mobile-images/${file}`;
      row.bytes = bytes.length;
      row.contentType = contentType;
    } catch (error) {
      row.error = error?.message ?? String(error);
    }
    manifest.push(row);
  }
  return manifest;
}

export async function augmentWithJdMobile(summary, outputDir, { maxImages = 40 } = {}) {
  if (summary?.site !== 'jd' || !summary?.skuId) return summary;
  const url = `https://item.m.jd.com/product/${summary.skuId}.html`;
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    summary.mobileFallback = { url, ok: false, error: error?.message ?? String(error) };
    return summary;
  }
  const html = await response.text();
  const blocked = /passport\.jd\.com|\/risk_handler\/|\/error2\.aspx|safe\.jd\.com/.test(response.url)
    || /<title[^>]*>[^<]*(?:京东验证|安全验证|登录京东)/i.test(html);
  await fs.writeFile(path.join(outputDir, blocked ? 'MOBILE_PAGE_BLOCKED.html' : 'MOBILE_PAGE.html'), html, 'utf8');
  if (blocked) {
    summary.mobileFallback = { url, finalUrl: response.url, status: response.status, ok: response.ok, blocked: true, bytes: Buffer.byteLength(html) };
    return summary;
  }

  const structured = extractJdMobileStructured(html, summary.skuId);
  if (structured) await fs.writeFile(path.join(outputDir, 'JD_MOBILE_STRUCTURED.json'), `${JSON.stringify(structured, null, 2)}\n`, 'utf8');

  const title = structured?.skuName ?? productTitle(html);
  const structuredCandidates = structuredImageCandidates(structured);
  const pageCandidates = collectPageImages(html);
  const images = mergeCandidates(structuredCandidates, pageCandidates);
  await fs.writeFile(path.join(outputDir, 'MOBILE_ALL_IMAGE_CANDIDATES.json'), `${JSON.stringify(images, null, 2)}\n`, 'utf8');
  const hints = collectHints(html, structured);
  const manifest = await downloadImages(images, outputDir, url, Number(maxImages) || 40);
  const saved = manifest.filter((x) => x.saved).length;
  const useful = manifest.filter((x) => x.saved && x.usefulByBytes).length;
  const structuredSaved = manifest.filter((x) => x.saved && ['exact-sku', 'main-image', 'variant-image'].includes(x.source)).length;
  const structuredUseful = manifest.filter((x) => x.saved && x.usefulByBytes && ['exact-sku', 'main-image', 'variant-image'].includes(x.source)).length;
  const pageDetailUseful = manifest.filter((x) => x.saved && x.usefulByBytes && x.source === 'page-scan' && (x.contextHint || x.rank === 0)).length;
  const exactSkuSaved = manifest.some((x) => x.saved && x.source === 'exact-sku');
  const advertisedSize = structured?.selectedVariant?.size ?? structured?.rawProductFields?.size ?? null;
  const advertisedColor = structured?.selectedVariant?.color ?? structured?.rawProductFields?.color ?? null;
  const layoutUsable = Boolean(advertisedSize && exactSkuSaved && structuredUseful >= 1);
  const detailGeometryUsable = pageDetailUseful >= 1;

  const mobile = {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    blocked: false,
    bytes: Buffer.byteLength(html),
    title,
    structured,
    advertisedSize,
    advertisedColor,
    discoveredImages: images.length,
    pageScannedImages: pageCandidates.length,
    structuredImageCandidates: structuredCandidates.length,
    downloadedImages: saved,
    usefulImages: useful,
    structuredSavedImages: structuredSaved,
    structuredUsefulImages: structuredUseful,
    pageDetailUsefulImages: pageDetailUseful,
    hints,
    images: manifest,
  };
  await fs.writeFile(path.join(outputDir, 'MOBILE_EVIDENCE.json'), `${JSON.stringify(mobile, null, 2)}\n`, 'utf8');

  summary.mobileFallback = mobile;
  if (!summary.title && title) summary.title = title;
  summary.selectedVariant = structured?.selectedVariant ?? null;
  summary.variantMatrix = structured ? {
    brandName: structured.brandName,
    colors: structured.colors,
    sizes: structured.sizes,
    variantCount: structured.variants.length,
  } : null;
  summary.usable = summary.usable || Boolean(title || saved || advertisedSize);
  summary.evidenceClass = detailGeometryUsable ? 'DETAIL_ENGINEERING_CANDIDATE' : layoutUsable ? 'LAYOUT_USABLE' : summary.evidenceClass;
  summary.engineeringEvidence = {
    ...(summary.engineeringEvidence ?? {}),
    advertisedSize,
    advertisedColor,
    exactVariantMatched: Boolean(structured?.selectedVariant),
    variantCount: structured?.variants?.length ?? 0,
    mainImageCount: structured?.mainImageUrls?.length ?? 0,
    mobileCandidateImages: images.length,
    mobileSavedImages: saved,
    mobileUsefulImages: useful,
    structuredSavedImages: structuredSaved,
    structuredUsefulImages: structuredUseful,
    pageDetailUsefulImages: pageDetailUseful,
    mobileHintCount: hints.length,
    layoutUsable,
    detailGeometryUsable,
    engineeringUsable: layoutUsable || detailGeometryUsable,
    browserOrUserSessionNeeded: !(layoutUsable || detailGeometryUsable),
    browserOrUserSessionNeededForDeepGeometry: !detailGeometryUsable,
  };
  await fs.writeFile(path.join(outputDir, 'ZERO_CU_SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}
