export function normalizeUrl(input) {
  const url = new URL(input);
  url.hash = '';
  return url;
}

export function identifyProduct(input) {
  const url = normalizeUrl(input);
  const host = url.hostname.toLowerCase();

  if (host === 'item.jd.com' || host.endsWith('.jd.com')) {
    const match = url.pathname.match(/\/(\d+)\.html(?:$|\/)/);
    if (!match) throw new Error(`Could not find a numeric JD item ID in ${url.href}`);
    return {
      site: 'jd',
      itemId: match[1],
      canonicalUrl: `https://item.jd.com/${match[1]}.html`,
    };
  }

  if (host.endsWith('taobao.com') || host.endsWith('tmall.com')) {
    const itemId = url.searchParams.get('id');
    if (!itemId || !/^\d+$/.test(itemId)) {
      throw new Error(`Could not find a numeric Taobao/Tmall id= parameter in ${url.href}`);
    }
    return {
      site: host.endsWith('tmall.com') ? 'tmall' : 'taobao',
      itemId,
      canonicalUrl: url.href,
    };
  }

  return {
    site: 'other',
    itemId: null,
    canonicalUrl: url.href,
  };
}
