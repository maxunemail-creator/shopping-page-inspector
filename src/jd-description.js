import { Actor, log } from 'apify';

const MAX_DETAIL_IMAGES = 40;

function decodeEscapes(text = '') {
  return text
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function extractJsonLike(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* JSONP or wrapped response */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* preserve raw */ }
  }
  return null;
}

function collectDetailImageUrls(payload, rawText) {
  const content = decodeEscapes(payload?.content ?? payload?.data?.content ?? rawText ?? '');
  const urls = new Set();
  const patterns = [
    /(?:data-lazyload|data-lazy-img|data-src|src)=["']([^"']+)["']/gi,
    /(?:https?:)?\/\/[^\s"'<>\\]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>\\]*)?/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const candidate = decodeEscapes(match[1] ?? match[0]).trim();
      if (!candidate) continue;
      const normalized = candidate.startsWith('//') ? `https:${candidate}` : candidate;
      if (!/^https?:\/\//i.test(normalized)) continue;
      if (!/(360buyimg\.com|jdimg\.com)/i.test(normalized)) continue;
      urls.add(normalized);
      if (urls.size >= MAX_DETAIL_IMAGES) break;
    }
    if (urls.size >= MAX_DETAIL_IMAGES) break;
  }
  return [...urls];
}

function extensionFor(contentType = '', url = '') {
  const type = contentType.toLowerCase();
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  const match = url.match(/\.(jpe?g|png|webp|gif)(?:$|[?#])/i);
  return match ? match[1].replace(/^jpeg$/i, 'jpg').toLowerCase() : 'bin';
}

async function requestDescription(url, referer) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      referer,
      accept: '*/*',
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return { url, status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), text };
}

export async function fetchJdDescriptionImages(skuId, { referer } = {}) {
  const kv = await Actor.openKeyValueStore();
  const itemUrl = referer ?? `https://item.jd.com/${skuId}.html`;
  const candidates = [
    `https://dx.3.cn/desc/${skuId}`,
    `https://cd.jd.com/description/channel?skuId=${encodeURIComponent(skuId)}&mainSkuId=${encodeURIComponent(skuId)}&charset=utf-8&cdn=2`,
  ];

  const attempts = [];
  let chosen = null;
  let payload = null;
  let imageUrls = [];

  for (const url of candidates) {
    try {
      const response = await requestDescription(url, itemUrl);
      const parsed = extractJsonLike(response.text);
      const urls = collectDetailImageUrls(parsed, response.text);
      attempts.push({ url, status: response.status, ok: response.ok, contentType: response.contentType, imageCount: urls.length });
      if (response.ok && urls.length) {
        chosen = response;
        payload = parsed;
        imageUrls = urls;
        break;
      }
    } catch (error) {
      attempts.push({ url, ok: false, error: error?.message ?? String(error), imageCount: 0 });
    }
  }

  const manifest = [];
  if (chosen) {
    await kv.setValue('JD_DESCRIPTION_RAW.txt', chosen.text, { contentType: 'text/plain; charset=utf-8' });
    for (const [index, url] of imageUrls.entries()) {
      const row = { index: index + 1, url, key: null, bytes: 0, contentType: null, error: null };
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: { referer: itemUrl },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`Not image (${contentType})`);
        const body = Buffer.from(await response.arrayBuffer());
        const key = `JD_DETAIL_${String(index + 1).padStart(2, '0')}.${extensionFor(contentType, url)}`;
        await kv.setValue(key, body, { contentType });
        row.key = key;
        row.bytes = body.length;
        row.contentType = contentType;
      } catch (error) {
        row.error = error?.message ?? String(error);
        log.debug(`JD detail image download failed: ${row.error}`);
      }
      manifest.push(row);
    }
  }

  const summary = {
    skuId,
    attempts,
    sourceUrl: chosen?.url ?? null,
    payloadDetected: Boolean(payload),
    found: imageUrls.length,
    saved: manifest.filter((x) => x.key).length,
    images: manifest,
  };
  await kv.setValue('JD_DESCRIPTION.json', summary);
  return summary;
}
