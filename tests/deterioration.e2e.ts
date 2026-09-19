import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createPublicDemo } from '../apps/public-demo.ts';
import { integrationRoot } from './integration-helpers.ts';

test('optional monitoring: enable, enroll, automatic vital warning, clinical response and disable on desktop/mobile', async (t) => {
  const app = await createPublicDemo(integrationRoot);
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(address);
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  await page.getByRole('button', { name: 'Moduler', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Vitalövervakning' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Vitalövervakning' }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Test av aktiverad övervakning');
  await page.getByRole('dialog').getByRole('button', { name: 'Aktivera', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Vitalövervakning' })).toBeChecked();
  await page.screenshot({
    path: integrationRoot + 'test-results/modules-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Vitalövervakning', exact: true }).click();
  await page.getByRole('button', { name: 'Starta patientövervakning' }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Följa vitalparametrar under vårdkontakten');
  await page.getByRole('dialog').getByRole('button', { name: 'Starta', exact: true }).click();
  await expect(page.locator('[data-monitor-row]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Öppna patientjournal' }).click();
  await page.getByRole('button', { name: 'Registrera', exact: true }).click();
  await page.getByLabel('Mätning', { exact: true }).selectOption('9279-1');
  await page.getByLabel('Värde', { exact: true }).fill('30');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByRole('button', { name: 'Vitalövervakning', exact: true }).click();
  await expect(page.getByText('Öppet larm', { exact: true })).toBeVisible({ timeout: 35000 });
  await expect(page.getByText('Andningsfrekvens: 30 /min', { exact: true })).toBeVisible();
  await page.screenshot({
    path: integrationRoot + 'test-results/monitoring-desktop.png',
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
    path: integrationRoot + 'test-results/monitoring-mobile.png',
    fullPage: true,
  });
  for (const action of ['acknowledge', 'reassess', 'resolve']) {
    await page.getByRole('button', { name: 'Dokumentera bedömning' }).click();
    await page.getByLabel('Händelse', { exact: true }).selectOption(action);
    await page
      .getByLabel('Bedömning', { exact: true })
      .fill('Patienten bedömd, mätvärden verifierade');
    await page
      .getByLabel('Fortsatt plan', { exact: true })
      .fill('Fortsatt uppföljning dokumenterad av ansvarig');
    await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await expect(page.getByText('Öppet larm', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Moduler', exact: true }).click();
  await page.getByRole('switch', { name: 'Vitalövervakning' }).click();
  await page.getByLabel('Orsak', { exact: true }).fill('Planerat avslut av övervakning');
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng av', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Vitalövervakning' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Vitalövervakning', exact: true }).click();
  await expect(page.getByText('Modulen avstängd', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kontrollera nu' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  assert.deepEqual(errors, []);
});
