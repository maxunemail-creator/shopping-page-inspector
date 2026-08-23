import { Actor, log } from 'apify';
import { identifyProduct } from './url.js';
import { fetchStructured } from './structured.js';
import { deepCapture } from './deep-capture.js';

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  if (!input.url) throw new Error('Input field "url" is required.');

  const product = identifyProduct(input.url);
  const mode = input.mode ?? 'auto';

  log.info(`Detected ${product.site} product ${product.itemId ?? '(no item id)'}`);

  let structured = null;
  let structuredError = null;
  if (mode !== 'browser-only' && product.site !== 'other') {
    try {
      structured = await fetchStructured(product, {
        includePrice: input.includePrice !== false,
      });
      await Actor.setValue('STRUCTURED.json', structured);
    } catch (error) {
      structuredError = error?.message ?? String(error);
      log.warning(`Structured extraction failed: ${structuredError}`);
    }
  }

  let browser = null;
  if (mode !== 'structured-only') {
    browser = await deepCapture(product.canonicalUrl, {
      proxyConfiguration: input.proxyConfiguration ?? { useApifyProxy: false },
      captureLargeImages: input.captureLargeImages !== false,
      downloadLargeImageOriginals: input.downloadLargeImageOriginals !== false,
      captureNetworkJson: input.captureNetworkJson !== false,
      maxLargeImages: input.maxLargeImages ?? 18,
    });
  }

  const output = {
    inspectedAt: new Date().toISOString(),
    inputUrl: input.url,
    product,
    mode,
    structured,
    structuredError,
    browser,
    interpretation: {
      complete: Boolean(structured) && (!browser || browser.ok),
      note: browser?.blockedMarkers?.length
        ? 'Browser capture encountered a login/verification/access-control page. The Actor records the partial capture but does not automate bypassing it.'
        : null,
    },
  };

  await Actor.setValue('OUTPUT', output);
  await Actor.pushData({
    site: product.site,
    itemId: product.itemId,
    canonicalUrl: product.canonicalUrl,
    structuredOk: Boolean(structured),
    browserOk: browser?.ok ?? null,
    browserTitle: browser?.title ?? null,
    imageCount: browser?.imageCount ?? null,
    capturedLargeImages: browser?.capturedLargeImages ?? null,
    downloadedLargeImageOriginals: browser?.downloadedLargeImageOriginals ?? null,
    networkJsonCount: browser?.networkJsonCount ?? null,
    blockedMarkers: browser?.blockedMarkers ?? [],
    structuredError,
    browserError: browser?.error ?? null,
  });
});
