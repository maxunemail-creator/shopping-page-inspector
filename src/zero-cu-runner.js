import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zeroCuInspect } from './zero-cu.js';
import { augmentWithJdMobile } from './jd-mobile-fallback.js';

export async function runZeroCu(url, outputDir = 'zero-cu-results', options = {}) {
  const base = await zeroCuInspect(url, outputDir, options);
  const augmented = await augmentWithJdMobile(base, outputDir, {
    maxImages: Number(options.maxImages ?? process.env.MAX_IMAGES ?? 40),
  });
  await fs.writeFile(path.join(outputDir, 'ZERO_CU_SUMMARY.json'), `${JSON.stringify(augmented, null, 2)}\n`, 'utf8');
  return augmented;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.argv[2] ?? process.env.PRODUCT_URL;
  const outputDir = process.argv[3] ?? process.env.OUTPUT_DIR ?? 'zero-cu-results';
  if (!url) {
    console.error('Usage: node src/zero-cu-runner.js <product-url> [output-dir]');
    process.exitCode = 2;
  } else {
    try {
      const summary = await runZeroCu(url, outputDir);
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.usable) process.exitCode = 3;
    } catch (error) {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    }
  }
}
