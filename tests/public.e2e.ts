import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';
import { root } from './helpers.ts';

test('public visitor can start, use the real chart and read the contributor guide', async (t) => {
  const remote = process.env.EIR_DEMO_TEST_URL;
  const app = remote ? undefined : await createPublicDemo(root);
  const address = remote
    ? new URL(remote).origin
    : await app!.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app?.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByRole('heading', { name: 'An open EHR, built together' }).waitFor();
  await page.getByRole('link', { name: 'How to open a pull request' }).waitFor();
  await page.getByRole('button', { name: 'Start demo' }).click();
  await page.getByText('Please confirm you will use synthetic information only.').waitFor();
  await page.getByLabel('I will use made-up information only.').check();
  await page.screenshot({ path: root + 'test-results/public-start.png', fullPage: true });
  await page.getByRole('button', { name: 'Start demo' }).click();
  await page.getByRole('heading', { name: 'Alex Exempel' }).waitFor();
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page
    .getByLabel('Journaltext', { exact: true })
    .fill('Syntetiskt test av den offentliga demon.');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByText('Syntetiskt test av den offentliga demon.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Översikt', exact: true }).click();
  await page.screenshot({ path: root + 'test-results/public-desktop.png', fullPage: true });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/public-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  await page.getByRole('button', { name: 'Start demo' }).waitFor();
  await page.goto(address + '/guide.html');
  await page.getByRole('heading', { name: 'Build with us' }).waitFor();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  assert.deepEqual(errors, []);
});
