import { Actor, log } from 'apify';

const IMAGE_KEY_RE = /(image|images|img|pic|photo|gallery)/i;
const IMAGE_URL_RE = /^https?:\/\//i;

function normalizeUrl(value) {
  if (typeof value !== 'string') return null;
  let url = value.trim();
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  if (!IMAGE_URL_RE.test(url)) return null;
  return url;
}

function looksLikeImageUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(parsed.pathname + parsed.search)
      || /(?:360buyimg|alicdn|tbcdn|taobaocdn|tmall|img\.jd|jdimg)/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function walk(value, keyHint, out, seen, depth = 0) {
  if (depth > 10 || value == null) return;

  if (typeof value === 'string') {
    const url = normalizeUrl(value);
    if (url && (IMAGE_KEY_RE.test(keyHint ?? '') || looksLikeImageUrl(url))) out.add(url);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) walk(item, keyHint, out, seen, depth + 1);
    return;
  }

  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) walk(child, key, out, seen, depth + 1);
}

export function collectStructuredImageUrls(structured) {
  const out = new Set();
  walk(structured, '', out, new WeakSet());
  return [...out];
}

function extensionForContentType(contentType = '', url = '') {
  const type = contentType.toLowerCase();
  if (type.includes('image/jpeg')) return 'jpg';
  if (type.includes('image/png')) return 'png';
  if (type.includes('image/webp')) return 'webp';
  if (type.includes('image/gif')) return 'gif';
  if (type.includes('image/avif')) return 'avif';
  const match = url.match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i);
  return match ? match[1].replace(/^jpeg$/i, 'jpg').toLowerCase() : 'bin';
}

export async function saveStructuredImages(structured, { maxImages = 30, referer } = {}) {
  const kv = await Actor.openKeyValueStore();
  const urls = collectStructuredImageUrls(structured).slice(0, Math.max(0, Math.min(maxImages, 60)));
  const manifest = [];

  for (const [index, url] of urls.entries()) {
    const record = { index: index + 1, url, key: null, contentType: null, bytes: 0, error: null };
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: referer ? { referer } : undefined,
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      if (!contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`Not an image response (${contentType})`);
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length) throw new Error('Empty image response');

      const ext = extensionForContentType(contentType, url);
      const key = `STRUCT_IMAGE_${String(index + 1).padStart(2, '0')}.${ext}`;
      await kv.setValue(key, body, { contentType });
      record.key = key;
      record.contentType = contentType;
      record.bytes = body.length;
    } catch (error) {
      record.error = error?.message ?? String(error);
      log.debug(`Could not save structured image ${url}: ${record.error}`);
    }
    manifest.push(record);
  }

  await kv.setValue('STRUCT_IMAGE_MANIFEST.json', manifest);
  const saved = manifest.filter((x) => x.key).length;
  return {
    found: urls.length,
    saved,
    manifestKey: 'STRUCT_IMAGE_MANIFEST.json',
    keys: manifest.filter((x) => x.key).map((x) => x.key),
  };
}
