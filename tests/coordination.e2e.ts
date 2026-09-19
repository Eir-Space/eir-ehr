import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createPublicDemo } from '../apps/public-demo.ts';
import { integrationRoot } from './integration-helpers.ts';

test('Samverkan: three unit inboxes, discharge, shared SIP, documents and mobile layout', async (t) => {
  const app = await createPublicDemo(integrationRoot);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await page.screenshot({
      path: integrationRoot + 'test-results/samverkan-last.png',
      fullPage: true,
    });
    await browser.close();
    await app.close();
  });
  const save = async (label = 'Spara') => {
    await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  };
  const open = () => page.getByRole('button', { name: 'Samverkan', exact: true }).click();
  const activate = async () => {
    await page.getByRole('button', { name: 'Moduler', exact: true }).click();
    await page.getByRole('switch', { name: 'Eir Samverkan' }).click();
    await page.getByLabel('Orsak', { exact: true }).fill('Test av gemensam vårdplanering');
    await save('Aktivera');
    await open();
  };
  const switchUnit = async (name: string, first = false) => {
    const option = page
      .locator('#assignment option')
      .filter({ hasText: name })
      .filter({ hasText: 'Vårdpersonal' });
    await page.locator('#assignment').selectOption((await option.getAttribute('value')) as string);
    if (first) await activate();
    else await open();
    await expect(page.getByRole('heading', { name: 'Eir Samverkan' })).toBeVisible();
  };
  const send = async (kind: string, text: string) => {
    await page.getByRole('button', { name: 'Nytt meddelande', exact: true }).click();
    await page.getByLabel('Meddelandetyp', { exact: true }).selectOption(kind);
    await page.getByLabel('Meddelande', { exact: true }).fill(text);
    await save('Skicka');
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  };
  const confirm = async () => {
    await page.getByRole('button', { name: 'SIP', exact: true }).click();
    await page.getByRole('button', { name: 'Bekräfta SIP', exact: true }).click();
    await page
      .getByLabel('Kommentar', { exact: true })
      .fill('Enhetens insatser och ansvar är bekräftade');
    await save();
  };
  await page.goto(address);
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  await activate();
  await page.getByRole('button', { name: 'Nytt samverkansärende' }).click();
  await page.getByLabel('Ärende', { exact: true }).fill('Samordnad hemgång');
  await save();
  await page.getByRole('button', { name: 'Dokumentera samtycke' }).click();
  await page.getByLabel('Samtycke', { exact: true }).selectOption('true');
  await page
    .getByLabel('Hur samtycket lämnades eller återkallades')
    .fill('Patienten samtycker till planering med de tre enheterna');
  await save();
  await send('care-request', 'Bedöm behov av samordning inför hemgång.');
  await switchUnit('Lindängens', true);
  await expect(page.locator('.sam-case')).toHaveCount(1);
  await page.getByRole('button', { name: 'Kvittera', exact: true }).click();
  await send('admission', 'Inskriven på medicinavdelningen.');
  await send('discharge-ready', 'Patienten är bedömd utskrivningsklar.');
  await switchUnit('Björkbackens');
  await page.getByRole('button', { name: 'Ansvar och betalning' }).click();
  await page.getByRole('button', { name: 'Ange fast vårdkontakt' }).click();
  await page.getByLabel('Namn och kontaktuppgift').fill('Emma Sjöberg, Björkbackens vårdcentral');
  await save();
  await page.getByRole('button', { name: 'Bekräfta öppenvårdens insatser' }).click();
  await page.getByLabel('Tillgängliga', { exact: true }).selectOption('true');
  await page.getByLabel('Bedömning', { exact: true }).fill('Hembesök och uppföljning är bokade');
  await save();
  await page.getByRole('button', { name: 'SIP', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa SIP' }).click();
  await page.getByLabel('Patientens prioriteringar', { exact: true }).fill('Kunna återvända hem');
  await page
    .getByLabel('Delaktighet och patientens synpunkter')
    .fill('Anna deltar och önskar stöd första veckan');
  await page.getByLabel('Mötesplats').fill('Digitalt vårdplaneringsmöte');
  await page.locator('[name=person-1]').fill('Emma Sjöberg');
  await page.getByLabel('Behov', { exact: true }).fill('Stöd efter sjukhusvistelse');
  await page.getByLabel('Mål', { exact: true }).fill('Trygg hemgång med tydligt ansvar');
  await page.getByLabel('Insats', { exact: true }).fill('Hembesök dagen efter utskrivning');
  await page.getByLabel('Ansvarig enhet', { exact: true }).selectOption('demo-municipality');
  await page.getByLabel('Ändringsorsak').fill('Första gemensamma planeringen');
  await save();
  await page.getByRole('button', { name: 'Kalla till SIP' }).click();
  await page.getByLabel('Kommentar', { exact: true }).fill('Kallelse till alla deltagande enheter');
  await save();
  await confirm();
  await switchUnit('Lindängens');
  await confirm();
  await page.getByRole('button', { name: 'Meddelanden', exact: true }).click();
  await send('discharge', 'Patienten lämnar avdelningen med planerade insatser.');
  await switchUnit('Sjövik', true);
  await confirm();
  await expect(page.getByRole('button', { name: 'Färdigställ SIP' })).toHaveCount(0);
  await switchUnit('Björkbackens');
  await page.getByRole('button', { name: 'SIP', exact: true }).click();
  await page.getByRole('button', { name: 'Färdigställ SIP' }).click();
  await page
    .getByLabel('Kommentar', { exact: true })
    .fill('Alla enheter har bekräftat aktuell plan');
  await save();
  await expect(page.getByText('Färdig SIP', { exact: true })).toBeVisible();
  await page.screenshot({
    path: integrationRoot + 'test-results/samverkan-desktop.png',
    fullPage: true,
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: integrationRoot + 'test-results/samverkan-mobile.png',
    fullPage: true,
  });
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportera ärende och SIP som PDF' }).click();
  const file = await pdfDownload;
  const bytes = await readFile((await file.path())!);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert((await PDFDocument.load(bytes)).getPageCount() >= 1);
  await page.getByRole('button', { name: 'Bilagor', exact: true }).click();
  await page.getByLabel('Bifoga PDF eller text').setInputFiles({
    name: 'underlag.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Planeringsunderlag för testärendet'),
  });
  await expect(page.getByText('underlag.txt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hämta bilaga' })).toBeVisible();
  assert.deepEqual(errors, []);
});
