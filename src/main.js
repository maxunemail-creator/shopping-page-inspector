import { Actor, log } from 'apify';
import { identifyProduct } from './url.js';
import { fetchStructured } from './structured.js';
import { saveStructuredImages } from './structured-images.js';
import { fetchJdDescriptionImages } from './jd-description.js';
import { deepCapture } from './deep-capture.js';

function hasStructuredData(structured) {
  return Boolean(
    structured
    && ((Array.isArray(structured.detail) && structured.detail.length)
      || (Array.isArray(structured.gallery) && structured.gallery.length)
      || (Array.isArray(structured.fallbackGallery) && structured.fallbackGallery.length)
      || (Array.isArray(structured.price) && structured.price.length)),
  );
}

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  if (!input.url) throw new Error('Input field "url" is required.');

  const product = identifyProduct(input.url);
  const mode = input.mode ?? 'auto';

  log.info(`Detected ${product.site} product ${product.itemId ?? '(no item id)'}`);

  let structured = null;
  let structuredError = null;
  let structuredImages = null;
  let structuredImagesError = null;
  let jdDescription = null;
  let jdDescriptionError = null;

  if (mode !== 'browser-only' && product.site !== 'other') {
    try {
      structured = await fetchStructured(product, {
        includePrice: input.includePrice !== false,
      });
      await Actor.setValue('STRUCTURED.json', structured);

      try {
        structuredImages = await saveStructuredImages(structured, {
          maxImages: 30,
          referer: product.canonicalUrl,
        });
      } catch (error) {
        structuredImagesError = error?.message ?? String(error);
        log.warning(`Structured image capture failed: ${structuredImagesError}`);
      }

      if (product.site === 'jd' && product.itemId) {
        try {
          jdDescription = await fetchJdDescriptionImages(product.itemId, {
            referer: product.canonicalUrl,
          });
        } catch (error) {
          jdDescriptionError = error?.message ?? String(error);
          log.warning(`JD description-image capture failed: ${jdDescriptionError}`);
        }
      }
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

  const structuredOk = hasStructuredData(structured);
  const browserOk = browser?.ok ?? null;
  const evidenceImageCount = (structuredImages?.saved ?? 0) + (jdDescription?.saved ?? 0);
  const output = {
    inspectedAt: new Date().toISOString(),
    inputUrl: input.url,
    product,
    mode,
    structured,
    structuredError,
    structuredImages,
    structuredImagesError,
    jdDescription,
    jdDescriptionError,
    browser,
    interpretation: {
      structuredUsable: structuredOk,
      browserUsable: browserOk,
      evidenceImageCount,
      complete: structuredOk && (mode === 'structured-only' || !browser || browser.ok),
      note: browser?.blockedMarkers?.length
        ? 'Browser capture encountered a login/verification/access-control page. Structured extractors, CDN image capture, and the public JD description endpoint can still provide usable evidence; the Actor records browser capture as partial and does not automate bypassing access controls.'
        : null,
    },
  };

  await Actor.setValue('OUTPUT', output);
  await Actor.pushData({
    site: product.site,
    itemId: product.itemId,
    canonicalUrl: product.canonicalUrl,
    structuredOk,
    structuredImageCount: structuredImages?.saved ?? null,
    jdDescriptionImageCount: jdDescription?.saved ?? null,
    browserOk,
    browserTitle: browser?.title ?? null,
    imageCount: browser?.imageCount ?? null,
    capturedLargeImages: browser?.capturedLargeImages ?? null,
    downloadedLargeImageOriginals: browser?.downloadedLargeImageOriginals ?? null,
    networkJsonCount: browser?.networkJsonCount ?? null,
    blockedMarkers: browser?.blockedMarkers ?? [],
    structuredError,
    structuredImagesError,
    jdDescriptionError,
    browserError: browser?.error ?? null,
  });
});
