import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

const BLOCK_MARKERS = [
  '验证码', '安全验证', '访问过于频繁', '请登录', '登录后',
  'captcha', 'verify you are human', 'access denied', 'robot check',
];

const MAX_NETWORK_JSON_RECORDS = 60;
const MAX_NETWORK_JSON_CHARS = 250000;

function detectBlocked(title, text, finalUrl = '') {
  const haystack = `${title}\n${text}`.toLowerCase();
  const markers = new Set(
    BLOCK_MARKERS.filter((marker) => haystack.includes(marker.toLowerCase())),
  );

  if (/passport\.jd\.com|login\.jd\.com/i.test(finalUrl)) markers.add('jd-login-redirect');
  if (/京东[^\n]{0,20}欢迎登录|登录页面/.test(`${title}\n${text}`)) markers.add('jd-login-page');
  if (/login\.taobao\.com|login\.tmall\.com/i.test(finalUrl)) markers.add('taobao-tmall-login-redirect');

  return [...markers];
}

function extensionForContentType(contentType = '') {
  const value = contentType.toLowerCase();
  if (value.includes('image/jpeg')) return 'jpg';
  if (value.includes('image/png')) return 'png';
  if (value.includes('image/webp')) return 'webp';
  if (value.includes('image/gif')) return 'gif';
  if (value.includes('image/avif')) return 'avif';
  return 'bin';
}

export async function deepCapture(url, {
  proxyConfiguration,
  captureLargeImages = true,
  downloadLargeImageOriginals = true,
  captureNetworkJson = true,
  maxLargeImages = 18,
} = {}) {
  const kv = await Actor.openKeyValueStore();
  const proxy = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

  const networkJson = [];
  const networkTasks = [];

  let result = {
    attempted: true,
    ok: false,
    requestedUrl: url,
    finalUrl: null,
    title: null,
    blockedMarkers: [],
    imageCount: 0,
    capturedLargeImages: 0,
    downloadedLargeImageOriginals: 0,
    networkJsonCount: 0,
    records: {},
    error: null,
  };

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxy,
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 150,
    navigationTimeoutSecs: 60,
    launchContext: {
      launchOptions: {
        headless: true,
      },
    },
    preNavigationHooks: [async ({ page }) => {
      if (!captureNetworkJson) return;
      page.on('response', (response) => {
        if (networkJson.length + networkTasks.length >= MAX_NETWORK_JSON_RECORDS) return;
        const task = (async () => {
          try {
            const headers = await response.allHeaders();
            const contentType = headers['content-type'] ?? '';
            const request = response.request();
            const resourceType = request.resourceType();
            if (!contentType.includes('json') && !['xhr', 'fetch'].includes(resourceType)) return;

            const responseText = await response.text();
            if (!responseText || responseText.length > MAX_NETWORK_JSON_CHARS) return;

            let parsed = null;
            try { parsed = JSON.parse(responseText); } catch { /* keep bounded text */ }

            if (networkJson.length < MAX_NETWORK_JSON_RECORDS) {
              networkJson.push({
                url: response.url(),
                status: response.status(),
                resourceType,
                contentType,
                body: parsed ?? responseText,
              });
            }
          } catch {
            // Some responses are opaque, streamed, redirects, or otherwise unreadable.
          }
        })();
        networkTasks.push(task);
      });
    }],
    async requestHandler({ page, request }) {
      await page.waitForTimeout(2500);

      // Trigger ordinary lazy loading by moving through the document in bounded steps.
      await page.evaluate(async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const maxSteps = 36;
        for (let i = 0; i < maxSteps; i += 1) {
          const before = window.scrollY;
          window.scrollBy(0, Math.max(550, Math.floor(window.innerHeight * 0.8)));
          await delay(180);
          if (window.scrollY === before || window.scrollY + window.innerHeight >= document.body.scrollHeight - 5) break;
        }
        window.scrollTo(0, 0);
        await delay(450);
      });

      await Promise.allSettled(networkTasks);

      const title = await page.title();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 250000);
      const finalUrl = page.url();
      const html = await page.content();
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });

      await kv.setValue('PAGE.html', html, { contentType: 'text/html; charset=utf-8' });
      await kv.setValue('PAGE.png', screenshot, { contentType: 'image/png' });
      await kv.setValue('VISIBLE_TEXT.txt', bodyText, { contentType: 'text/plain; charset=utf-8' });

      const pageData = await page.evaluate(() => {
        const absolute = (value) => {
          if (!value) return null;
          try { return new URL(value, document.baseURI).href; } catch { return value; }
        };

        const images = [...document.images].map((img, domIndex) => {
          const rect = img.getBoundingClientRect();
          const candidateSrc = img.currentSrc
            || img.src
            || img.dataset.src
            || img.dataset.lazyImg
            || img.dataset.lazyload
            || img.getAttribute('data-lazy-img')
            || img.getAttribute('data-original');
          return {
            domIndex,
            src: absolute(candidateSrc),
            alt: img.alt || '',
            naturalWidth: img.naturalWidth || 0,
            naturalHeight: img.naturalHeight || 0,
            renderedWidth: Math.round(rect.width || 0),
            renderedHeight: Math.round(rect.height || 0),
          };
        });

        const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .map((el) => el.textContent)
          .filter(Boolean);

        const resources = performance.getEntriesByType('resource')
          .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType }))
          .filter((entry) => /image|img|xmlhttprequest|fetch/.test(entry.initiatorType));

        return { images, jsonLd, resources };
      });

      await kv.setValue('IMAGES.json', pageData.images);
      await kv.setValue('JSON_LD.json', pageData.jsonLd);
      await kv.setValue('RESOURCES.json', pageData.resources);
      if (captureNetworkJson) await kv.setValue('NETWORK_JSON.json', networkJson);

      let captured = 0;
      let downloadedOriginals = 0;
      const captureManifest = [];

      if (captureLargeImages && maxLargeImages > 0) {
        const candidates = pageData.images
          .filter((x) => x.src && x.naturalWidth >= 500 && x.naturalHeight >= 250)
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))
          .slice(0, Math.min(maxLargeImages, 40));

        for (const candidate of candidates) {
          const item = { ...candidate, screenshotKey: null, originalKey: null };
          try {
            const locator = page.locator('img').nth(candidate.domIndex);
            await locator.scrollIntoViewIfNeeded();
            await page.waitForTimeout(120);
            const buffer = await locator.screenshot({ type: 'png' });
            captured += 1;
            const key = `DETAIL_${String(captured).padStart(2, '0')}.png`;
            await kv.setValue(key, buffer, { contentType: 'image/png' });
            item.screenshotKey = key;
          } catch (err) {
            log.debug(`Could not screenshot image ${candidate.domIndex}: ${err?.message ?? err}`);
          }

          if (downloadLargeImageOriginals && candidate.src) {
            try {
              const response = await page.context().request.get(candidate.src, {
                headers: { referer: finalUrl },
                timeout: 20000,
              });
              if (response.ok()) {
                const body = await response.body();
                const contentType = response.headers()['content-type'] ?? 'application/octet-stream';
                const ext = extensionForContentType(contentType);
                const key = `DETAIL_ORIG_${String(captureManifest.length + 1).padStart(2, '0')}.${ext}`;
                await kv.setValue(key, body, { contentType });
                item.originalKey = key;
                downloadedOriginals += 1;
              }
            } catch (err) {
              log.debug(`Could not download image ${candidate.src}: ${err?.message ?? err}`);
            }
          }

          captureManifest.push(item);
        }
      }

      await kv.setValue('DETAIL_MANIFEST.json', captureManifest);

      const blockedMarkers = detectBlocked(title, bodyText, finalUrl);
      result = {
        attempted: true,
        ok: blockedMarkers.length === 0,
        requestedUrl: request.url,
        finalUrl,
        title,
        blockedMarkers,
        imageCount: pageData.images.length,
        capturedLargeImages: captured,
        downloadedLargeImageOriginals: downloadedOriginals,
        networkJsonCount: networkJson.length,
        records: {
          html: 'PAGE.html',
          screenshot: 'PAGE.png',
          visibleText: 'VISIBLE_TEXT.txt',
          images: 'IMAGES.json',
          jsonLd: 'JSON_LD.json',
          resources: 'RESOURCES.json',
          networkJson: captureNetworkJson ? 'NETWORK_JSON.json' : null,
          detailManifest: 'DETAIL_MANIFEST.json',
          detailScreenshotPrefix: captured ? 'DETAIL_' : null,
          detailOriginalPrefix: downloadedOriginals ? 'DETAIL_ORIG_' : null,
        },
        error: null,
      };
    },
    failedRequestHandler({ request }, error) {
      result = {
        ...result,
        requestedUrl: request.url,
        error: error?.message ?? String(error),
      };
    },
  });

  try {
    await crawler.run([url]);
  } catch (error) {
    result = { ...result, error: error?.message ?? String(error) };
  }

  return result;
}
