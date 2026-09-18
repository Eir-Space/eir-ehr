import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { createPublicDemo } from '../apps/public-demo.ts';

test('care team books, checks in, signs, closes, assigns and resolves work at desktop and mobile sizes', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  f.runtime
    .get('access')
    .grant(doctor, f.patient.id, 'nurse-a', 'clinician', '2099-01-01T00:00:00Z');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'America/New_York',
  });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByLabel('Sessionsnyckel').fill(f.runtime.get('identity').issue!(doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('button', { name: 'Arbetslista', exact: true }).click();
  await page.getByRole('button', { name: 'Boka besök', exact: true }).click();
  await page.getByLabel('Tid (Europe/Stockholm)').fill('2026-09-21T09:00');
  await page.getByLabel('Kontaktorsak').fill('Återbesök');
  await page.getByRole('button', { name: 'Boka', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByLabel('Datum', { exact: true }).fill('2026-09-21');
  await expect(page.locator('.appointment-row')).toHaveCount(1);
  await expect(page.locator('.slot-time strong')).toHaveText('09:00');
  await page.getByRole('button', { name: 'Markera ankomst' }).click();
  await expect(page.getByText('Anlänt', { exact: true })).toBeVisible();
  await page.screenshot({ path: root + 'test-results/care-team-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Öppna vårdkontakt' }).click();
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page
    .getByLabel('Journaltext', { exact: true })
    .fill('Besöket genomfört. Plan dokumenterad.');
  await expect(page.locator('.draft-status')).toContainText('Sparat');
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.getByRole('button', { name: 'Signera', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Signera', exact: true }).click();
  await page.getByRole('button', { name: 'Avsluta kontakt', exact: true }).click();
  await page.getByRole('button', { name: 'Arbetslista', exact: true }).click();
  await expect(page.locator('.appointment-row .badge')).toHaveText('Klar');
  await page.getByRole('button', { name: 'Inkorg', exact: true }).click();
  await page.getByRole('button', { name: 'Ny uppgift', exact: true }).click();
  await page.getByLabel('Uppgift', { exact: true }).fill('Telefonuppföljning');
  await page.getByLabel('Senast', { exact: true }).fill('2026-09-20');
  await page.getByRole('dialog').getByLabel('Ansvarig', { exact: true }).selectOption('nurse-a');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Slutför uppgift' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Byt ansvarig' }).click();
  await page.getByLabel('Ny ansvarig').selectOption(doctor.id);
  await page.getByLabel('Orsak till överlämning').fill('Täcker kollegans frånvaro');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByRole('button', { name: 'Slutför uppgift' }).click();
  await page.getByLabel('Åtgärd / resultat').fill('Patienten kontaktad, uppföljning bokad');
  await page.getByRole('button', { name: 'Slutför', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(0);
  await page.getByLabel('Status', { exact: true }).selectOption('closed');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.locator('.work-resolution')).toHaveText(
    'Patienten kontaktad, uppföljning bokad',
  );
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole('button', { name: 'Arbetslista', exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole('button', { name: 'Inkorg', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + 'test-results/care-team-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
});

test('autosave recovers after reload, preserves text offline, and refuses concurrent overwrite', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  const token = f.runtime.get('identity').issue!(doctor);
  async function login() {
    await page.getByLabel('Sessionsnyckel').fill(token);
    await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
    await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  }
  await page.goto(address);
  await login();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page.getByLabel('Journaltext', { exact: true }).fill('Återställbart utkast');
  await expect(page.locator('.draft-status')).toContainText('Sparat');
  await page.reload();
  await login();
  await expect(page.getByText('Återställbart utkast', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redigera' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Journaltext', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel('Journaltext', { exact: true }).fill('Text under nätavbrott');
  await expect(page.locator('.draft-status')).toContainText('Inte sparat');
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#dialog-error')).not.toHaveText('');
  await expect(page.getByLabel('Journaltext', { exact: true })).toHaveValue(
    'Text under nätavbrott',
  );
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Försök spara igen' }).click();
  await expect(page.locator('.draft-status')).toContainText('Sparat');
  const note = f.store.list(doctor.tenant, f.patient.id, 'note')[0];
  f.clinical.transition(doctor, note.id, 'save', note.version, { text: 'Kollegans uppdatering' });
  await page.getByLabel('Journaltext', { exact: true }).fill('Mitt andra utkast');
  await expect(page.locator('.draft-conflict')).toBeVisible();
  await expect(page.getByLabel('Journaltext', { exact: true })).toHaveValue('Mitt andra utkast');
  assert.equal(f.store.get(doctor.tenant, note.id)?.data.text, 'Kollegans uppdatering');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Läs in sparad version' }).click();
  await expect(page.getByLabel('Journaltext', { exact: true })).toHaveValue(
    'Kollegans uppdatering',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
});

test('public care-team release exposes seeded worklists and working inbox on the deployed API', async (t) => {
  let address = process.env.EIR_DEMO_TEST_URL;
  if (!address) {
    const app = await createPublicDemo(root);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    t.after(() => app.close());
  }
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  let releaseDirectory!: () => void;
  const directoryReady = new Promise<void>((resolve) => {
    releaseDirectory = resolve;
  });
  let directoryRequested = false;
  await page.route(
    '**/api/patients',
    async (route) => {
      directoryRequested = true;
      await directoryReady;
      await route.continue();
    },
    { times: 1 },
  );
  await page.goto(address);
  await page.getByRole('button', { name: 'Öppna journalen' }).click();
  try {
    await expect.poll(() => directoryRequested).toBe(true);
    await expect(page.locator('#shell')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Öppna journalen' })).toBeDisabled();
  } finally {
    releaseDirectory();
  }
  await page.getByRole('button', { name: 'Arbetslista', exact: true }).click();
  await expect(page.locator('.appointment-row')).toHaveCount(4);
  await page.screenshot({ path: root + 'test-results/care-team-public.png', fullPage: true });
  await page.getByRole('button', { name: 'Inkorg', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(10);
  await page.getByLabel('Ansvarig', { exact: true }).selectOption('demo-clinician');
  await expect(page.locator('.task-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Slutför uppgift' }).first().click();
  await page.getByLabel('Åtgärd / resultat').fill('Uppföljning genomförd i testarbetsytan');
  await page.getByRole('button', { name: 'Slutför', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(5);
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  await expect(page.locator('#login')).toBeVisible();
});

test('a lost create response does not duplicate a draft and closing drains newer text after an in-flight save', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    // Close the browser before Fastify waits for its last in-flight chart refresh.
    await browser?.close();
    await app.close();
    f.runtime.stop();
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(address);
  await page.getByLabel('Sessionsnyckel').fill(f.runtime.get('identity').issue!(doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page.route(
    '**/records/note',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByLabel('Journaltext', { exact: true }).fill('Servern tog emot texten');
  await expect(page.locator('.draft-status')).toContainText('Sparat');
  assert.equal(f.store.list(doctor.tenant, f.patient.id, 'note').length, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving = false;
  await page.route(
    '**/records/*/save',
    async (route) => {
      saving = true;
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.getByLabel('Journaltext', { exact: true }).fill('Första uppdateringen');
    await expect.poll(() => saving).toBe(true);
    await page.getByLabel('Journaltext', { exact: true }).fill('Senaste uppdateringen');
    await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  } finally {
    release();
  }
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const notes = f.store.list(doctor.tenant, f.patient.id, 'note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].data.text, 'Senaste uppdateringen');
  assert.equal(notes[0].version, 3);
});
