import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { integrationFixture, integrationRoot } from './integration-helpers.ts';

await test('connected order, operator reconciliation and machine result appear in the clinical workspace across desktop/mobile', async (t) => {
  const f = await integrationFixture();
  t.after(f.cleanup);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(f.urls[0]);
  await page
    .getByLabel('Sessionsnyckel')
    .fill(await f.runtimes[0].get('identity').issue!(f.doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await expect(page.getByRole('button', { name: 'Integrationer', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Prover och svar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny provbeställning' }).click();
  await page.getByLabel('Laboratorium', { exact: true }).selectOption('test-lab');
  await page.getByLabel('Analys / undersökning').fill('Elektrolytstatus');
  await page.getByLabel('Frågeställning').fill('Behandlingsuppföljning');
  await page.getByLabel('Provmaterial').fill('Plasma');
  await page.getByLabel('Svar bevakas senast').fill('2026-10-01');
  await page.getByRole('button', { name: 'Skapa beställning' }).click();
  await expect(page.getByText('I kö', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrera provsvar', exact: true })).toHaveCount(
    0,
  );
  const order = (await f.rows('labOrder'))[0];
  f.behavior.mode = 'wrong-ack';
  await f.runtimes[0].get('integrations').runOnce();
  await page.getByLabel('Aktivt uppdrag').selectOption(f.admin.assignmentId!);
  await page.getByRole('button', { name: 'Integrationer', exact: true }).click();
  await expect(
    page.locator('.integration-table').getByText('Kräver åtgärd', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Ogiltigt mottagningskvitto', { exact: true })).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('quarantined');
  await page.getByRole('button', { name: 'Filtrera', exact: true }).click();
  await expect(page.locator('.integration-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Meddelandedetaljer' }).click();
  await expect(page.getByRole('dialog').getByText(order.id, { exact: true })).toHaveCount(2);
  await page.locator('#dialog-form button[type=submit]').click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('quarantined');
  await page.screenshot({
    path: integrationRoot + 'test-results/integrations-desktop.png',
    fullPage: true,
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: integrationRoot + 'test-results/integrations-mobile.png',
    fullPage: true,
  });
  await page.getByLabel('Aktiv', { exact: true }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Undersöker felaktiga kvitton');
  await page.getByRole('button', { name: 'Bekräfta', exact: true }).click();
  await expect(page.getByLabel('Aktiv', { exact: true })).not.toBeChecked();
  await page.getByLabel('Aktiv', { exact: true }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Kvitto verifierat hos laboratoriet');
  await page.getByRole('button', { name: 'Bekräfta', exact: true }).click();
  await expect(page.getByLabel('Aktiv', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
  await page.getByLabel('Åtgärd och orsak').fill('Laboratoriet skickar nu korrekta kvitton');
  await page.getByRole('dialog').getByRole('button', { name: 'Försök igen', exact: true }).click();
  await expect(page.locator('.integration-table tbody tr')).toHaveCount(0);
  f.behavior.mode = 'accept';
  await f.runtimes[0].get('integrations').runOnce();
  const first = f.result(order);
  await f.receive(first);
  await f.runtimes[0].get('integrations').runOnce();
  await page.getByLabel('Riktning').selectOption('inbox');
  await page.getByLabel('Status', { exact: true }).selectOption('applied');
  await page.getByRole('button', { name: 'Filtrera', exact: true }).click();
  await expect(
    page.locator('.integration-table').getByText('Journalfört', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Aktivt uppdrag').selectOption(f.doctor.assignmentId!);
  await page.getByRole('button', { name: 'Prover och svar', exact: true }).click();
  await expect(page.getByText('Kritiskt · ej granskat', { exact: true })).toBeVisible();
  await expect(page.getByText('Mottagen av labb', { exact: true })).toBeVisible();
  await f.receive(
    f.result(order, {
      supersedesMessageId: first.messageId,
      report: { ...first.report, correctionReason: 'Laboratoriets rättning' },
    }),
  );
  await f.runtimes[0].get('integrations').runOnce();
  await page.getByRole('button', { name: 'Uppdatera provsvar', exact: true }).click();
  await expect(page.getByText('1 ersatta svar', { exact: true })).toBeVisible();
  await page.screenshot({
    path: integrationRoot + 'test-results/integrations-clinical.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
});
