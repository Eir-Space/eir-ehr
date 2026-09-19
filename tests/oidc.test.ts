import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../packages/runtime.ts';
import storage from '../plugins/storage-sqlite.ts';
import workforcePlugin from '../plugins/workforce.ts';
import identityPlugin from '../plugins/identity-oidc.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { testProvider } from './oidc-provider.ts';

test('OIDC validates signed issuer/audience/nonce/assurance, PKCE, identity mapping and one-use browser transactions', async (t) => {
  const provider = await testProvider();
  t.after(() => provider.close());
  const config = demoWorkforce('clinic-a');
  config.bootstrap = config.bootstrap.map((a) => ({ ...a, issuer: provider.issuer }));
  process.env.EIR_TEST_OIDC_SECRET = 'test-secret';
  const runtime = await new Runtime().start([
    { plugin: storage, config: { path: ':memory:' } },
    { plugin: workforcePlugin, config },
    {
      plugin: identityPlugin,
      config: {
        issuer: provider.issuer,
        origin: 'http://127.0.0.1:4919',
        clientId: 'eir-test',
        clientSecretEnv: 'EIR_TEST_OIDC_SECRET',
        requiredAcr: ['urn:eir:test:strong'],
        localTestOnly: true,
      },
    },
  ]);
  t.after(() => {
    runtime.stop();
    delete process.env.EIR_TEST_OIDC_SECRET;
  });
  const identity = runtime.get('identity'),
    browser = identity.browser!;
  assert.equal(identity.issue, undefined);
  const flow = async () => {
    const start = await browser.begin();
    const response = await fetch(start.url, { redirect: 'manual' });
    return { ...start, callback: new URL(response.headers.get('location')!) };
  };
  const valid = await flow();
  const token = await browser.callback(valid.callback, valid.binding).catch((error) => {
    throw new Error(String(error.cause?.error_description ?? error.cause ?? error));
  });
  const actor = await identity.authenticate(token);
  assert.equal(actor.authentication?.method, 'oidc');
  assert.equal(actor.authentication?.subject, 'emma');
  assert.equal(actor.authentication?.acr, 'urn:eir:test:strong');
  await assert.rejects(browser.callback(valid.callback, valid.binding), /already used/);
  identity.revoke!(token);
  await assert.rejects(identity.authenticate(token));
  const swapped = await flow(),
    wrongBrowser = await flow();
  await assert.rejects(
    browser.callback(swapped.callback, wrongBrowser.binding),
    /Authentication failed/,
  );
  const badState = await flow();
  badState.callback.searchParams.set('state', 'wrong');
  await assert.rejects(browser.callback(badState.callback, badState.binding));
  for (const claims of [
    { aud: 'other-app' },
    { iss: 'https://untrusted.invalid' },
    { nonce: 'wrong' },
    { exp: 1 },
    { acr: 'weak' },
    { sub: 'unprovisioned' },
    { auth_time: 1 },
    { auth_time: Math.floor(Date.now() / 1000) + 1000 },
  ]) {
    provider.control.claims = claims;
    const attempt = await flow();
    await assert.rejects(
      browser.callback(attempt.callback, attempt.binding),
      /Authentication failed/,
    );
  }
  provider.control.claims = {};
  provider.control.badSignature = true;
  const forged = await flow();
  await assert.rejects(browser.callback(forged.callback, forged.binding), /Authentication failed/);
  provider.control.badSignature = false;
  const expired = await flow();
  const store = runtime.get('store') as import('../plugins/storage-sqlite.ts').SqliteStore;
  store.db.exec("UPDATE login_transactions SET expires='2000-01-01T00:00:00.000Z'");
  await assert.rejects(browser.callback(expired.callback, expired.binding), /expired/);
  await assert.rejects(
    new Runtime().start([
      { plugin: storage, config: { path: ':memory:' } },
      { plugin: workforcePlugin, config },
      {
        plugin: identityPlugin,
        config: {
          issuer: provider.issuer,
          origin: 'http://127.0.0.1:4919',
          clientId: 'eir-test',
          clientSecretEnv: 'EIR_TEST_OIDC_SECRET',
          requiredAcr: ['urn:eir:test:strong'],
        },
      },
    ]),
    /HTTPS/,
  );
});
