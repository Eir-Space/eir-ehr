import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';

test('clinician workflow, plugin renderers, responsive layout and persisted source review', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByLabel('Sessionsnyckel').fill(f.runtime.get('identity').issue!(doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('heading', { name: 'Syntetisk Patient' }).waitFor();
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page.getByLabel('Journaltext', { exact: true }).fill('Granskad svensk journaltext.');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByText('Granskad svensk journaltext.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Signera', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Signera', exact: true }).click();
  await page.getByText('Signerad', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'AI-granskning', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa journalförslag' }).click();
  await page.getByRole('button', { name: 'Spara granskat utkast' }).click();
  await page.getByText('accepted', { exact: true }).waitFor();
  assert.equal(f.store.list(doctor.tenant, f.patient.id, 'note').length, 2);
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  await page.getByLabel('Visning').selectOption('table');
  await page.locator('table').waitFor();
  assert.equal(await page.locator('tbody tr').count(), 3);
  await page.getByLabel('Visning').selectOption('timeline');
  await page.locator('.timeline-entry').first().waitFor();
  await page.getByRole('button', { name: 'Översikt', exact: true }).click();
  await page.screenshot({ path: root + 'test-results/desktop.png', fullPage: true });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#error').isVisible(), false);
});
