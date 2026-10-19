// Renders the promo images in src/ (and the demo covers) to exact-size PNGs in out/.
// Usage: node docs/promo/render.mjs [name ...]   (no args = render everything)
// Uses the browser suite's Playwright; base.css loads Bricolage Grotesque and
// Pretendard over the network, so it needs a connection.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(dir, '../../apps/plot/apps/e2e/package.json'));
const { chromium } = require('@playwright/test');

// [source relative to docs/promo, output relative to docs/promo, width, height, pixel ratio]
// The promo images are wider than a README's column, so one pixel per point is
// sharp there; GitHub's social preview also wants 1280x640 under 1 MB. The covers
// get two, as the app shows them large on a high-density screen.
const TARGETS = [
  ...['lighthouse', 'neon', 'shrine', 'orbit', 'academy'].map((name) => [
    `demo/covers/${name}.svg`,
    `demo/covers/${name}.png`,
    600,
    900,
    2,
  ]),
  ['src/banner.html', 'out/banner.png', 1400, 560, 1],
  ['src/social.html', 'out/social.png', 1280, 640, 1],
  ['src/feature-chat.html', 'out/feature-chat.png', 1280, 800, 1],
  ['src/feature-cards.html', 'out/feature-cards.png', 1280, 800, 1],
  ['src/feature-models.html', 'out/feature-models.png', 1280, 800, 1],
  ['src/feature-phone.html', 'out/feature-phone.png', 1280, 800, 1],
];

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [source, output, width, height, deviceScaleFactor] of TARGETS) {
  const name = source.replace(/^.*\//, '').replace(/\.\w+$/, '');
  if (only.length && !only.includes(name)) continue;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
  await page.goto(pathToFileURL(join(dir, source)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(join(dir, output)), { recursive: true });
  await page.screenshot({ path: join(dir, output), omitBackground: true });
  await page.close();
  console.log(`rendered ${output} (${width}x${height})`);
}
await browser.close();
