import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';
import { createApp } from '../apps/app.ts';
import { staffFixture } from './workforce-helpers.ts';
import { root } from './helpers.ts';

test('public workspace switches between care, audit and administration without exposing charts', async (t) => {
  const app = await createPublicDemo(root),
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  const options = await page
    .locator('#assignment option')
    .evaluateAll((els) =>
      els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent! })),
    );
  const select = async (role: string) =>
    page
      .getByLabel('Aktivt uppdrag', { exact: true })
      .selectOption(options.find((o) => o.text.endsWith(role))!.value);
  await select('Logggranskare');
  await page.getByRole('heading', { name: 'Åtkomstlogg', exact: true }).waitFor();
  assert.equal(await page.locator('.patient-option').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Registrera patient' }).isVisible(), false);
  await page.screenshot({ path: root + 'test-results/access-log-desktop.png', fullPage: true });
  await select('Behörighetsadministratör');
  await page.getByRole('heading', { name: 'Medarbetaruppdrag' }).waitFor();
  await page.getByRole('button', { name: 'Ändra uppdrag för David Ek' }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('false');
  await page.getByLabel('Orsak', { exact: true }).fill('Uppdrag avslutat');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.locator('#content').getByText('Återkallat', { exact: true }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/workforce-mobile.png', fullPage: true });
  await select('Vårdpersonal');
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  await page.getByRole('button', { name: 'Lås arbetsytan' }).click();
  await page.getByRole('button', { name: 'Öppna journalen' }).waitFor();
  assert.equal(await page.locator('#shell').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('reviewer records a durable assessment without receiving clinical access', async (t) => {
  const f = await staffFixture();
  await f.store.audit(f.doctor, 'access.emergency-opened', f.patient.id);
  const app = await createApp(f.runtime, root),
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await f.runtime.stop();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(15000);
  await page.goto(address);
  await page.locator('[name=token]').fill(await f.runtime.get('identity').issue!(f.reviewer));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('heading', { name: 'Åtkomstlogg', exact: true }).waitFor();
  assert.equal(await page.locator('.patient-option').count(), 0);
  const event = page.locator('.audit-entry').filter({ hasText: 'access.emergency-opened' });
  await event.getByRole('button', { name: 'Granska', exact: true }).click();
  await page
    .getByLabel('Bedömning och uppföljning')
    .fill('Kontakta ansvarig chef för uppföljning.');
  await page.getByRole('button', { name: 'Registrera granskning' }).click();
  await event.locator('summary').click();
  await event.getByText('Utredning krävs', { exact: true }).waitFor();
  assert.equal((await f.store.list(f.doctor.tenant, undefined, 'accessReview')).length, 1);
  await page.getByLabel('Utfall', { exact: true }).selectOption('denied');
  await page.getByRole('button', { name: 'Filtrera', exact: true }).click();
  await page.getByText('Inga händelser för valt filter.').waitFor();
});
