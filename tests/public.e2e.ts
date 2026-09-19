import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';
import { root } from './helpers.ts';
await test('public visitor can start, use the real chart and read the contributor guide', async (t) => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(() => browser?.close());
  const remote = process.env.EIR_DEMO_TEST_URL;
  const app = remote ? undefined : await createPublicDemo(root);
  const address = remote
    ? new URL(remote).origin
    : await app!.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app?.close());
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByRole('heading', { name: 'Var med och bygg Eir' }).waitFor();
  await page.getByRole('link', { name: 'Skicka en pull request' }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.screenshot({ path: root + 'test-results/public-start.png', fullPage: true });
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  assert.equal(await page.locator('.patient-option').count(), 4);
  assert.equal(await page.locator('#project-community').isVisible(), false);
  await page.getByRole('button', { name: /Sara Haddad/ }).click();
  await page.getByRole('heading', { name: 'Sara Haddad' }).waitFor();
  await page.getByText('Astma, ospecificerad', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Anna Lindberg/ }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  await page.getByRole('button', { name: 'Lägg till', exact: true }).click();
  const query = page.getByRole('combobox', { name: 'Sök diagnos eller ICD-10-SE-kod' });
  await query.fill('K219');
  await page.getByRole('option').filter({ hasText: 'K21.9' }).waitFor();
  await query.press('ArrowDown');
  await query.press('Enter');
  await page.locator('#diagnosis-selected').waitFor();
  await query.fill('hösnuva');
  assert.equal(await page.locator('#diagnosis-selected').isVisible(), false);
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByText('Välj en diagnos i sökresultatet.').waitFor();
  await page.getByRole('option').filter({ hasText: 'J30.1' }).click();
  assert.equal(await page.locator('#dialog-error').textContent(), '');
  await page.screenshot({ path: root + 'test-results/diagnosis-picker.png', fullPage: true });
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page
    .locator('#content')
    .getByText('Allergisk rinit orsakad av pollen', { exact: true })
    .waitFor();
  await page.route(
    '**/api/terminology/diagnoses?*',
    async (route) =>
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Test outage' }),
      }),
  );
  await page.getByRole('button', { name: 'Lägg till', exact: true }).click();
  await page.getByText('Kunde inte hämta diagnoser.', { exact: true }).waitFor();
  await page.unroute('**/api/terminology/diagnoses?*');
  await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'I10.9' }).waitFor();
  await query.fill('no-such-diagnosis');
  await page.getByText('Inga diagnoser hittades.', { exact: true }).waitFor();
  await query.fill('I10');
  await page.getByRole('option').filter({ hasText: 'Välj underkod' }).click();
  await page.getByRole('option').filter({ hasText: 'I10.9' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'Välj underkod' }).count(), 0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.equal(
      await page.locator('#dialog').evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/diagnosis-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page
    .getByLabel('Journaltext', { exact: true })
    .fill('Syntetiskt test av den offentliga demon.');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByText('Syntetiskt test av den offentliga demon.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Översikt', exact: true }).click();
  await page.screenshot({ path: root + 'test-results/public-desktop.png', fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.equal(
      await page
        .locator('.metric strong')
        .evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height < 40)),
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/public-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  await page.getByRole('button', { name: 'Öppna journalen' }).waitFor();
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
