function findBalancedObject(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseAssignedObject(html, marker) {
  const raw = findBalancedObject(html, marker);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(removeTrailingCommas(raw));
    } catch {
      return null;
    }
  }
}

function toMobileCdn(pathOrUrl) {
  if (!pathOrUrl) return null;
  const value = String(pathOrUrl).trim().replace(/^\/+/, '');
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  return `https://m.360buyimg.com/mobilecms/${value}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractJdMobileStructured(html, skuId) {
  const itemOnlyRoot = parseAssignedObject(html, 'window._itemOnly = (');
  const itemInfoRoot = parseAssignedObject(html, 'window._itemInfo = (');
  const item = itemOnlyRoot?.item ?? null;
  const product = itemInfoRoot?.product ?? null;
  if (!item && !product) return null;

  const variants = Array.isArray(item?.newColorSize) ? item.newColorSize : [];
  const selectedVariant = variants.find((row) => String(row?.skuId ?? '') === String(skuId ?? item?.skuId ?? product?.skuId ?? '')) ?? null;
  const mainImagePaths = Array.isArray(item?.image) ? item.image : [];
  const mainImageUrls = unique(mainImagePaths.map(toMobileCdn));
  const selectedImageUrl = toMobileCdn(selectedVariant?.imagePath ?? product?.imageurl ?? mainImagePaths[0]);
  const uniqueVariantImageUrls = unique(variants.map((row) => toMobileCdn(row?.imagePath)));

  const colors = Array.isArray(item?.salePropSeq?.['1']) ? item.salePropSeq['1'] : [];
  const sizes = Array.isArray(item?.salePropSeq?.['2']) ? item.salePropSeq['2'] : [];

  return {
    parser: 'jd-mobile-embedded-v1',
    skuId: String(skuId ?? product?.skuId ?? item?.skuId ?? ''),
    brandName: item?.brandName ?? null,
    skuName: product?.skuName ?? item?.skuName ?? null,
    saleProp: item?.saleProp ?? null,
    colors,
    sizes,
    selectedVariant,
    mainImagePaths,
    mainImageUrls,
    selectedImageUrl,
    uniqueVariantImageUrls,
    variants,
    rawProductFields: product ? {
      skuId: product.skuId ?? null,
      skuName: product.skuName ?? null,
      imageurl: product.imageurl ?? null,
      color: product.color ?? null,
      size: product.size ?? null,
      width: product.width ?? null,
      height: product.height ?? null,
      length: product.length ?? null,
      weight: product.weight ?? null,
      brandId: product.brandId ?? null,
      shopId: product.shopId ?? null,
      venderId: product.venderId ?? null,
      category: product.category ?? null,
    } : null,
    dimensionSemantics: 'Use selectedVariant.size / product.size for advertised furniture size. JD raw width/height/length fields are preserved only as opaque catalog fields and are not assumed to be furniture overall dimensions.',
  };
}
