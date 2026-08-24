import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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

function collectImages(html) {
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
    if (!old || rank < old.rank) map.set(url, { url, rank, sequence: sequence++, contextHint: /detail|graphic|description|waregraphic|图文|详情/i.test(context) });
  }
  return [...map.values()].sort((a, b) => a.rank - b.rank || a.sequence - b.sequence);
}

function collectHints(html) {
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
    const row = { ...item, index: index + 1, saved: false, file: null, bytes: 0, contentType: null, error: null };
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
      const file = `${String(index + 1).padStart(2, '0')}_r${item.rank}.${extensionFor(contentType, item.url)}`;
      await fs.writeFile(path.join(dir, file), bytes);
      row.saved = true;
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

  const title = productTitle(html);
  const images = collectImages(html);
  const hints = collectHints(html);
  const manifest = await downloadImages(images, outputDir, url, Number(maxImages) || 40);
  const saved = manifest.filter((x) => x.saved).length;
  const highConfidence = manifest.filter((x) => x.saved && x.rank <= 1).length;
  const detailContext = images.filter((x) => x.contextHint || x.rank <= 1).length;

  const mobile = {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    blocked: false,
    bytes: Buffer.byteLength(html),
    title,
    discoveredImages: images.length,
    detailContextCandidates: detailContext,
    downloadedImages: saved,
    highConfidenceImages: highConfidence,
    hints,
    images: manifest,
  };
  await fs.writeFile(path.join(outputDir, 'MOBILE_EVIDENCE.json'), `${JSON.stringify(mobile, null, 2)}\n`, 'utf8');

  summary.mobileFallback = mobile;
  if (!summary.title && title) summary.title = title;
  const hasUsefulImageSet = Boolean(title && saved >= 5);
  const hasEngineeringHints = hints.some((x) => /(?:\*|x|X|×).*?(?:\*|x|X|×)|mm|洞洞板|桌板厚度|桌腿|横梁/i.test(x));
  summary.usable = summary.usable || Boolean(title || saved);
  if (hasUsefulImageSet || hasEngineeringHints) {
    summary.evidenceClass = detailContext > 0 || hasEngineeringHints ? 'ENGINEERING_CANDIDATE' : summary.evidenceClass;
    summary.engineeringEvidence = {
      ...(summary.engineeringEvidence ?? {}),
      mobileCandidateImages: images.length,
      mobileSavedImages: saved,
      mobileHighConfidenceImages: highConfidence,
      mobileDetailContextCandidates: detailContext,
      mobileHintCount: hints.length,
      engineeringUsable: Boolean((detailContext > 0 && saved >= 3) || hasEngineeringHints),
      browserOrUserSessionNeeded: !((detailContext > 0 && saved >= 3) || hasEngineeringHints),
    };
  }
  await fs.writeFile(path.join(outputDir, 'ZERO_CU_SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}
