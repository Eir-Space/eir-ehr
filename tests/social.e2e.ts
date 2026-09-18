import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';
import { root } from './helpers.ts';

test('social previews are readable without JavaScript, login or a demo session', async (t) => {
  const remote = process.env.EIR_DEMO_TEST_URL;
  const app = remote ? undefined : await createPublicDemo(root);
  const origin = remote
    ? new URL(remote).origin
    : await app!.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app?.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const fixture = await readFile(root + 'apps/web/social/eir-journal-v1.png');
  assert.equal(fixture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(fixture.readUInt32BE(16), 1200);
  assert.equal(fixture.readUInt32BE(20), 630);
  assert.ok(fixture.length < 2 * 1024 * 1024, 'Social image should remain small');
  for (const userAgent of ['facebookexternalhit/1.1', 'LinkedInBot/1.0', 'Twitterbot/1.0']) {
    const context = await browser.newContext({ javaScriptEnabled: false, userAgent });
    try {
      const page = await context.newPage();
      for (const path of ['/', '/guide.html']) {
        const response = await page.goto(origin + path);
        assert.equal(response?.status(), 200);
        const meta = async (property: string) => {
          const tag = page.locator(`meta[property="${property}"], meta[name="${property}"]`);
          assert.equal(await tag.count(), 1, `${path}: expected one ${property}`);
          return tag.getAttribute('content');
        };
        assert.equal(await meta('og:url'), 'https://ehr.eir.space' + path);
        assert.equal(
          await page.locator('link[rel="canonical"]').getAttribute('href'),
          'https://ehr.eir.space' + path,
        );
        assert.equal(await meta('og:type'), 'website');
        assert.equal(await meta('og:locale'), path === '/' ? 'sv_SE' : 'en_GB');
        assert.equal(await meta('twitter:card'), 'summary_large_image');
        assert.equal(await meta('twitter:title'), await meta('og:title'));
        assert.ok((await meta('og:description'))!.length > 50);
        assert.ok((await meta('og:image:alt'))!.length > 30);
        assert.equal(await meta('twitter:image:alt'), await meta('og:image:alt'));
        const image = await meta('og:image');
        assert.equal(image, 'https://ehr.eir.space/social/eir-journal-v1.png');
        assert.equal(await meta('twitter:image'), image);
        assert.equal(await meta('og:image:secure_url'), image);
        assert.equal(await meta('og:image:width'), '1200');
        assert.equal(await meta('og:image:height'), '630');
        const asset = await context.request.get(origin + new URL(image!).pathname);
        assert.equal(asset.status(), 200);
        assert.match(asset.headers()['content-type'], /^image\/png/);
        assert.equal(await meta('og:image:type'), 'image/png');
        assert.deepEqual(await asset.body(), fixture);
      }
    } finally {
      await context.close();
    }
  }
});
