import { Actor, log } from 'apify';

async function readCalledActorDataset(run) {
  if (!run?.defaultDatasetId) return [];
  const dataset = Actor.apifyClient.dataset(run.defaultDatasetId);
  const page = await dataset.listItems({ limit: 100 });
  return page.items ?? [];
}

export async function fetchStructured(product, { includePrice = true } = {}) {
  if (!Actor.isAtHome()) {
    throw new Error('Structured store-Actor calls require an Apify platform run (APIFY_TOKEN/account context).');
  }

  if (product.site === 'jd') {
    const detailRun = await Actor.call('sian.agency/jd-com-product-scraper', {
      operation: 'productDetail',
      itemId: product.itemId,
    });
    const detail = await readCalledActorDataset(detailRun);

    let price = [];
    if (includePrice) {
      const priceRun = await Actor.call('sian.agency/jd-com-product-scraper', {
        operation: 'productPrice',
        itemId: product.itemId,
      });
      price = await readCalledActorDataset(priceRun);
    }

    // Complement the deep-SKU extractor with a gallery-oriented JD extractor.
    // This remains non-fatal: if the secondary Actor is unavailable or its
    // input contract changes, the primary SIAN result is still returned.
    let gallery = [];
    let galleryError = null;
    try {
      const galleryRun = await Actor.call('piotrv1001/jd-com-product-scraper', {
        skuIds: [product.itemId],
      });
      gallery = await readCalledActorDataset(galleryRun);
    } catch (error) {
      galleryError = error?.message ?? String(error);
      log.warning(`Complementary JD gallery extraction failed: ${galleryError}`);
    }

    return {
      provider: 'sian.agency/jd-com-product-scraper',
      galleryProvider: 'piotrv1001/jd-com-product-scraper',
      detail,
      price,
      gallery,
      galleryError,
    };
  }

  if (product.site === 'taobao' || product.site === 'tmall') {
    const detailRun = await Actor.call('sian.agency/taobao-tmall-product-scraper', {
      operation: 'productDetail',
      itemId: product.itemId,
      detailVersion: 'v1',
    });
    const detail = await readCalledActorDataset(detailRun);

    return {
      provider: 'sian.agency/taobao-tmall-product-scraper',
      detail,
    };
  }

  return {
    provider: null,
    detail: [],
    warning: 'No structured extractor configured for this domain.',
  };
}
