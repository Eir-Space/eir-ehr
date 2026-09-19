import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { followUpFixture } from './follow-up-helpers.ts';
import { sampleReport, integrationRoot } from './integration-helpers.ts';

test('clinical oversight, review, contact attempt, completion and history across desktop and mobile', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  const { order } = await f.create();
  const runtime = f.runtimes[0];
  await runtime.get('laboratories').receive(f.doctor, order.id, order.version, {
    ...sampleReport(),
    source: 'Test laboratory',
    messageId: randomUUID(),
  });
  await runtime.get('followUp').runOnce();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(f.urls[0]);
  await page.getByLabel('Sessionsnyckel').fill(await runtime.get('identity').issue!(f.doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('button', { name: 'Bevakning', exact: true }).click();
  await expect(page.getByText('Kritiskt · Ej granskat', { exact: true })).toBeVisible();
  await expect(page.getByText('Levererat till aviseringstjänst')).toBeVisible();
  await page.screenshot({
    path: integrationRoot + 'test-results/follow-up-desktop.png',
    fullPage: true,
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: integrationRoot + 'test-results/follow-up-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Öppna journal', exact: true }).click();
  await page.getByRole('button', { name: 'Granska och åtgärda' }).click();
  await page.getByLabel('Bedömning', { exact: true }).fill('Kritiskt svar granskat');
  await page.getByLabel('Åtgärd / uppföljningsplan').fill('Kontakta patienten');
  await page.getByLabel('Patientkontakt / kommunikationsplan').fill('Telefonkontakt planerad');
  await page
    .getByLabel('Jag har uppmärksammat det kritiska svaret och dokumenterat åtgärden')
    .check();
  await expect(page.getByLabel('Fortsatt uppföljning')).toHaveValue('action-required');
  await page
    .getByLabel('Åtgärd senast (UTC)')
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Signera granskning' }).click();
  await page.getByRole('button', { name: 'Bevakning', exact: true }).click();
  await expect(
    page.locator('#content').getByText('Åtgärd kvarstår', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dokumentera uppföljning' }).click();
  await page.getByLabel('Dokumentation').fill('Första kontaktförsöket utan svar');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(
    page.locator('#content').getByText('Åtgärd kvarstår', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dokumentera uppföljning' }).click();
  await page.getByLabel('Händelse').selectOption('complete');
  await page.getByLabel('Dokumentation').fill('Patienten nådd och alla åtgärder slutförda');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.locator('[data-follow-up-row]')).toHaveCount(0);
  await page.getByLabel('Uppgiftsstatus').selectOption('closed');
  await expect(page.locator('[data-follow-up-row]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Uppföljningshistorik' }).click();
  await expect(page.getByText('Första kontaktförsöket utan svar', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Patienten nådd och alla åtgärder slutförda', { exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).last().click();
  await page.getByRole('button', { name: 'Min ersättare' }).click();
  await page.getByLabel('Ersättare', { exact: true }).selectOption(f.colleague.id);
  await page.getByLabel('Från (UTC)').fill(new Date().toISOString().slice(0, 16));
  await page
    .getByLabel('Till (UTC)')
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await page.getByLabel('Orsak', { exact: true }).fill('Planerad frånvaro under passet');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta täckningsperiod' })).toBeVisible();
  await page.getByRole('button', { name: 'Avsluta täckningsperiod' }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Åter i tjänst');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta täckningsperiod' })).toHaveCount(0);
  await page.locator('[data-follow-up-freshness]').evaluate((node: HTMLElement) => {
    node.dataset.followUpFreshness = '2026-01-01T00:00:00Z';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText('Automatisk bevakning ej bekräftad', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});
