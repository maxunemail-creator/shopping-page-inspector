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

    // First complementary source: full-gallery oriented FalconScrape actor.
    let gallery = [];
    const galleryProvider = 'piotrv1001/jd-com-product-scraper';
    let galleryError = null;
    try {
      const galleryRun = await Actor.call(galleryProvider, {
        skuIds: [product.itemId],
      });
      gallery = await readCalledActorDataset(galleryRun);
    } catch (error) {
      galleryError = error?.message ?? String(error);
      log.warning(`Complementary JD gallery extraction failed: ${galleryError}`);
    }

    // Second complementary source: use only when the first gallery source
    // produced no row. This actor has a non-empty productUrls prefill, so
    // productUrls must be explicitly cleared when supplying our own SKU.
    let fallbackGallery = [];
    let fallbackGalleryError = null;
    const fallbackGalleryProvider = 'automation-lab/jd-com-product-scraper';
    if (!gallery.length) {
      try {
        const fallbackRun = await Actor.call(fallbackGalleryProvider, {
          productUrls: [],
          skus: [product.itemId],
          maxItems: 1,
          includeApiDetails: false,
        });
        fallbackGallery = await readCalledActorDataset(fallbackRun);
      } catch (error) {
        fallbackGalleryError = error?.message ?? String(error);
        log.warning(`Fallback JD gallery extraction failed: ${fallbackGalleryError}`);
      }
    }

    return {
      provider: 'sian.agency/jd-com-product-scraper',
      detail,
      price,
      galleryProvider,
      gallery,
      galleryError,
      fallbackGalleryProvider,
      fallbackGallery,
      fallbackGalleryError,
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
