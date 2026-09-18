import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';

// Only capture a new local, disposable workspace. Never accept an external patient/session URL.
const root = fileURLToPath(new URL('../', import.meta.url));
const app = await createPublicDemo(root);
let browser;
try {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch({ headless: true });
  const workspace = await browser.newPage({
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 1,
  });
  await workspace.goto(address);
  await workspace.getByRole('button', { name: 'Öppna journalen' }).click();
  await workspace.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  await workspace.locator('.app-header .wordmark svg').waitFor();
  await workspace.evaluate(() => document.fonts.ready);
  const mark = await workspace.locator('.app-header .wordmark svg').evaluate((el) => el.outerHTML);
  const chart = await workspace.screenshot({
    clip: { x: 0, y: 0, width: 1440, height: 650 },
    animations: 'disabled',
  });
  const composition = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await composition.setContent(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #153f39; color: #fff; font-family: Arial, sans-serif; letter-spacing: 0; }
    header { padding: 40px 54px 0; }
    .top { display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 20px; }
    .brand svg { width: 65px; height: 65px; color: #86dec7; stroke-width: 1.7; }
    h1 { margin: 0; font-size: 70px; font-weight: 700; line-height: 1.1; }
    .domain { font-size: 21px; color: #c2e7dd; }
    .subtitle { margin: 17px 0 0; font-size: 32px; line-height: 1.3; font-weight: 400; }
    .details { margin: 16px 0 0; display: flex; align-items: center; gap: 18px; font-size: 17px; color: #c2e7dd; }
    .details span + span { border-left: 1px solid #71968d; padding-left: 18px; }
    figure { margin: 30px 54px 0; height: 380px; width: 1092px; overflow: hidden; background: #fff; border: 1px solid #b6d0c9; border-radius: 7px 7px 0 0; }
    figure img { display: block; width: 1092px; height: auto; }
  </style></head><body><header>
    <div class="top"><div class="brand">${mark}<h1>Eir Journal</h1></div><span class="domain">ehr.eir.space</span></div>
    <p class="subtitle">Ett öppet journalsystem för svensk vård.</p>
    <p class="details"><span>Öppen källkod</span><span>Utbytbara moduler</span><span>AI-stöd</span></p>
  </header><figure><img alt="Eirs kliniska arbetsyta med exempelpatienter" src="data:image/png;base64,${chart.toString('base64')}"></figure></body></html>`);
  await composition.locator('img').evaluate((img: HTMLImageElement) => img.decode());
  await composition.evaluate(() => document.fonts.ready);
  assert.equal(await composition.evaluate(() => document.documentElement.scrollWidth), 1200);
  for (const selector of ['.brand', '.domain', '.subtitle', '.details']) {
    assert.ok(
      await composition.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth),
      `${selector} overflows`,
    );
  }
  const destination = root + 'apps/web/social/eir-journal-v1.png';
  await mkdir(root + 'apps/web/social', { recursive: true });
  await composition.screenshot({ path: destination, type: 'png', animations: 'disabled' });
  console.log(`Created ${destination} (1200 x 630) from the local fictional clinical workspace.`);
} finally {
  await browser?.close();
  await app.close();
}
