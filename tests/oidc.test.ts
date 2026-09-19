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
  t.after(async () => {
    await runtime.stop();
    delete process.env.EIR_TEST_OIDC_SECRET;
  });
  const identity = runtime.get('identity'),
    browser = identity.browser!;
  const store = runtime.get('store') as import('../plugins/storage-sqlite.ts').SqliteStore;
  assert.equal(identity.issue, undefined);
  const flow = async () => {
    const start = await browser.begin();
    const authorization = new URL(start.url);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
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
  await identity.revoke!(token);
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
  const wrongPkce = await browser.begin();
  const changedChallenge = new URL(wrongPkce.url);
  changedChallenge.searchParams.set('code_challenge', 'A'.repeat(43));
  const pkceResponse = await fetch(changedChallenge, { redirect: 'manual' });
  const pkceCallback = new URL(pkceResponse.headers.get('location')!);
  await assert.rejects(browser.callback(pkceCallback, wrongPkce.binding), /Authentication failed/);
  await assert.rejects(browser.callback(pkceCallback, wrongPkce.binding), /already used/);
  for (const claims of [
    { aud: 'other-app' },
    { iss: 'https://untrusted.invalid' },
    { nonce: 'wrong' },
    { exp: 1 },
    { acr: 'weak' },
    { acr: null },
    { sub: 'unprovisioned' },
    { sub: null },
    { auth_time: 1 },
    { auth_time: null },
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
  const oneUse = await flow();
  const simultaneous = await Promise.allSettled([
    browser.callback(oneUse.callback, oneUse.binding),
    browser.callback(oneUse.callback, oneUse.binding),
  ]);
  assert.equal(simultaneous.filter((result) => result.status === 'fulfilled').length, 1);
  const reused = simultaneous.find((result) => result.status === 'rejected');
  assert(reused?.status === 'rejected');
  assert.match(reused.reason.message, /already used/);
  const failedSession = await flow();
  const sessionFailure = new Error('Session write failed');
  const saveSession = t.mock.method(store, 'saveSession', async () => {
    throw sessionFailure;
  });
  await assert.rejects(browser.callback(failedSession.callback, failedSession.binding), {
    message: 'Authentication failed or staff assignment unavailable',
    cause: sessionFailure,
  });
  saveSession.mock.restore();
  await assert.rejects(
    browser.callback(failedSession.callback, failedSession.binding),
    /already used/,
  );
  const expired = await flow();
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
