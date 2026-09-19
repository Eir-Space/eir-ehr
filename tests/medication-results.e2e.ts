import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { createPublicDemo } from '../apps/public-demo.ts';
await test('clinician reconciles medicines, records critical results, reviews and handles a corrected report', async (t) => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(() => browser?.close());
  const f = await fixture(),
    app = await createApp(f.runtime, root);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByLabel('Sessionsnyckel').fill(await f.runtime.get('identity').issue!(doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('button', { name: 'Läkemedel', exact: true }).click();
  await expect(page.getByText('Inte avstämd', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dokumentera läkemedel' }).click();
  await page.getByLabel('Läkemedel och styrka').fill('Testpreparat 10 mg');
  await page.getByLabel('Indikation', { exact: true }).fill('Dokumenterad användning');
  await page.getByLabel('Underlag / uppgiftslämnare').fill('Patientintervju, dos ännu okänd');
  await page.getByLabel('Jag har kontrollerat uppgiften mot underlaget').check();
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.locator('.medication-row')).toHaveCount(1);
  await expect(page.getByText('Dosering okänd', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stäm av listan' }).click();
  await page.getByLabel('Underlag för avstämning').fill('Patient och tillgänglig journal');
  await page
    .getByLabel('Avstämning och kvarstående frågor')
    .fill('Dos behöver verifieras vid nästa kontakt.');
  await page.getByLabel('Jag har gått igenom läkemedel och överkänslighet').check();
  await page.getByRole('button', { name: 'Bekräfta avstämning' }).click();
  await expect(page.getByText('Listan avstämd', { exact: true })).toBeVisible();
  await page.screenshot({ path: root + 'test-results/medications-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Ändra', exact: true }).click();
  await page.getByLabel('Användning', { exact: true }).selectOption('on-hold');
  await page.getByLabel('Orsak till ändring').fill('Patienten uppger uppehåll');
  await page.getByLabel('Jag har kontrollerat uppgiften mot underlaget').check();
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByText('Listan har ändrats efter avstämning')).toBeVisible();
  await page.getByRole('button', { name: 'Prover och svar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny provbeställning' }).click();
  await page.getByLabel('Analys / undersökning').fill('Elektrolytstatus');
  await page.getByLabel('Frågeställning').fill('Behandlingsuppföljning');
  await page.getByLabel('Provmaterial').fill('Plasma');
  await page.getByLabel('Svar bevakas senast').fill('2026-10-01');
  await page.getByRole('button', { name: 'Skapa beställning' }).click();
  await expect(page.getByText('Inväntar svar', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inkorg', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Slutför uppgift' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Öppna provbeställning' }).click();
  await page.getByRole('button', { name: 'Registrera provsvar', exact: true }).click();
  await page.getByLabel('Svarskälla / laboratorium').fill('Exempellaboratoriet');
  await page.getByLabel('Svar-ID från källan').fill('UI-001');
  await page.getByLabel('Analysnamn 1').fill('P-Test');
  await page.getByLabel('Resultat 1', { exact: true }).fill('7,1');
  await page.getByLabel('Enhet 1').fill('mmol/L');
  await page.getByLabel('Referensintervall 1').fill('Enligt källan');
  await page.getByLabel('Avvikelse 1').selectOption('critical');
  await page.getByRole('button', { name: 'Lägg till analys' }).click();
  await page.getByLabel('Analysnamn 2').fill('Annan analys');
  await page.getByLabel('Resultat 2', { exact: true }).fill('Ej påvisat');
  await page
    .getByLabel('Värden, enheter, referenser och avvikelsemarkeringar är kontrollerade mot svaret')
    .check();
  await page.getByRole('button', { name: 'Registrera svar', exact: true }).click();
  await expect(page.getByText('Kritiskt · ej granskat', { exact: true })).toBeVisible();
  await page.screenshot({ path: root + 'test-results/labs-desktop.png', fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/labs-mobile.png', fullPage: true });
  async function review() {
    await page.getByRole('button', { name: 'Granska och åtgärda' }).click();
    await page.getByLabel('Bedömning', { exact: true }).fill('Källsvaret granskat');
    await page.getByLabel('Fortsatt uppföljning').selectOption('completed');
    await page.getByLabel('Åtgärd / uppföljningsplan').fill('Ansvarigt team kontaktat');
    await page
      .getByLabel('Patientkontakt / kommunikationsplan')
      .fill('Patientkontakt dokumenterad');
    await page
      .getByLabel('Jag har uppmärksammat det kritiska svaret och dokumenterat åtgärden')
      .check();
    await page.getByRole('button', { name: 'Signera granskning' }).click();
    await expect(page.getByText('Granskat', { exact: true })).toBeVisible();
  }
  await review();
  await page.getByRole('button', { name: 'Registrera rättat svar' }).click();
  await page.getByLabel('Svar-ID från källan').fill('UI-002');
  await page.getByLabel('Orsak till rättat svar').fill('Rättelse från laboratoriet');
  await expect(page.getByLabel('Analysnamn 2')).toHaveValue('Annan analys');
  await page.getByLabel('Resultat 1', { exact: true }).fill('7,2');
  await page
    .getByLabel('Värden, enheter, referenser och avvikelsemarkeringar är kontrollerade mot svaret')
    .check();
  await page.getByRole('button', { name: 'Registrera svar', exact: true }).click();
  await expect(page.getByText('Kritiskt · ej granskat', { exact: true })).toBeVisible();
  await expect(page.getByText('1 ersatta svar', { exact: true })).toBeVisible();
  await review();
  await page.getByRole('button', { name: 'Inkorg', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(0);
  await page.getByLabel('Status', { exact: true }).selectOption('closed');
  await expect(page.locator('.task-row')).toHaveCount(1);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReview')).length, 2);
  assert.deepEqual(errors, []);
});
await test('public medication and lab release exposes seeded data and completes result review', async (t) => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(() => browser?.close());
  let address = process.env.EIR_DEMO_TEST_URL;
  if (!address) {
    const app = await createPublicDemo(root);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    t.after(async () => await app.close());
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  await page.goto(address);
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  await page.getByRole('button', { name: 'Läkemedel', exact: true }).click();
  await expect(page.getByText('Enalapril 5 mg, tablett', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prover och svar', exact: true }).click();
  await expect(page.getByText('P-Kreatinin', { exact: true })).toBeVisible();
  await page.screenshot({ path: root + 'test-results/labs-public.png', fullPage: true });
  await page.getByRole('button', { name: 'Granska och åtgärda' }).click();
  await page.getByLabel('Bedömning', { exact: true }).fill('Exempelsvaret granskat');
  await page.getByLabel('Åtgärd / uppföljningsplan').fill('Uppföljning vid planerad kontakt');
  await page.getByLabel('Patientkontakt / kommunikationsplan').fill('Genomgång vid återbesök');
  await page
    .getByLabel('Åtgärd senast (UTC)')
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Signera granskning' }).click();
  await expect(page.getByText('Granskat', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Historik', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Exempelsvaret granskat', { exact: true }),
  ).toBeVisible();
});
