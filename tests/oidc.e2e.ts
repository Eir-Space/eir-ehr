import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { Runtime } from '../packages/runtime.ts';
import { createApp } from '../apps/app.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { testProvider } from './oidc-provider.ts';
import { root } from './helpers.ts';

test('federated browser login keeps tokens HttpOnly, rejects CSRF, signs with identity and locks revoked staff', async (t) => {
  const provider = await testProvider();
  t.after(() => provider.close());
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = demoWorkforce('clinic-oidc');
  config.bootstrap = config.bootstrap
    .filter((a) => a.role === 'clinician')
    .map((a) => ({ ...a, issuer: provider.issuer }));
  const profile = JSON.parse(await readFile(root + 'eir.demo.config.json', 'utf8'));
  process.env.EIR_BROWSER_OIDC_SECRET = 'test-secret';
  const entries = [];
  for (const entry of profile.plugins) {
    const module =
      entry.module === './plugins/identity-staff-local.ts'
        ? './plugins/identity-oidc.ts'
        : entry.module;
    const plugin = (await import(pathToFileURL(root + module).href)).default;
    entries.push({
      plugin,
      config:
        plugin.id === 'eir.identity.oidc'
          ? {
              issuer: provider.issuer,
              origin,
              clientId: 'eir-test',
              clientSecretEnv: 'EIR_BROWSER_OIDC_SECRET',
              requiredAcr: ['urn:eir:test:strong'],
              localTestOnly: true,
            }
          : plugin.id === 'eir.workforce'
            ? config
            : entry.config,
    });
  }
  const runtime = await new Runtime().start(entries);
  const workforce = runtime.get('workforce');
  const doctor = workforce.actor((await workforce.forIdentity(provider.issuer, 'emma'))[0]);
  await runtime.get('clinical').register(doctor, {
    name: 'Anna Lindberg',
    birthDate: '1980-01-01',
    identifier: { type: 'local', value: 'OIDC-TEST' },
  });
  const app = await createApp(runtime, root);
  await app.listen({ host: '127.0.0.1', port });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await runtime.stop();
    delete process.env.EIR_BROWSER_OIDC_SECRET;
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.getByRole('link', { name: 'Logga in med vårdens e-legitimation' }).click();
  await page.getByRole('heading', { name: 'Anna Lindberg' }).waitFor();
  assert.equal(await page.evaluate(() => document.cookie), '');
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((c) => c.name === 'eir-session')!;
  assert(sessionCookie.httpOnly);
  assert.equal(sessionCookie.sameSite, 'Strict');
  assert(!page.url().includes('code='));
  const noOrigin = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `eir-session=${sessionCookie.value}` },
    payload: {},
  });
  assert.equal(noOrigin.statusCode, 403);
  const malformedAuthorization = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `eir-session=${sessionCookie.value}`, authorization: 'Invalid' },
    payload: {},
  });
  assert.equal(malformedAuthorization.statusCode, 403);
  const evilOrigin = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `eir-session=${sessionCookie.value}`, origin: 'https://evil.invalid' },
    payload: {},
  });
  assert.equal(evilOrigin.statusCode, 403);
  await page.getByRole('button', { name: 'Ny vårdkontakt', exact: true }).click();
  await page.getByLabel('Kontaktorsak').fill('Planerad kontroll');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Ny anteckning' }).click();
  await page.getByLabel('Journaltext', { exact: true }).fill('Uppföljning dokumenterad.');
  await page.getByRole('button', { name: 'Spara', exact: true }).click();
  await page.getByRole('button', { name: 'Signera', exact: true }).click();
  await page.locator('#dialog').getByRole('button', { name: 'Signera', exact: true }).click();
  await page.locator('#content').getByText('Signerad', { exact: true }).waitFor();
  const store = runtime.get('store');
  const signed = (await store.list(doctor.tenant, undefined, 'note'))[0];
  assert.equal(signed.data.signedBy, doctor.id);
  assert.equal(signed.data.signedUnder.authentication, 'oidc');
  assert.equal(signed.data.signedUnder.acr, 'urn:eir:test:strong');
  const assignment = await workforce.current(doctor);
  await store.transaction(async () =>
    store.revise(
      { ...doctor, role: 'administrator' },
      assignment,
      assignment.version,
      { ...assignment.data, enabled: false },
      'test.assignment-revoked',
    ),
  );
  await page.getByRole('button', { name: 'Översikt', exact: true }).click();
  // Fetching patient data after revocation must clear the rendered chart as well.
  await page.locator('.patient-option').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#shell').isVisible(), false);
  assert.equal(await page.locator('#content').textContent(), '');
});
