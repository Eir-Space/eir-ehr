import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { baseApp } from '../apps/http.ts';
import { Runtime } from '../packages/runtime.ts';
import plugin from '../plugins/risk-http.ts';

test('HTTP risk provider binds evidence to input and model; rejects errors, redirects, oversized responses and timeout', async (t) => {
  const tokenEnv = 'EIR_RISK_TEST_' + randomBytes(8).toString('hex'),
    token = randomBytes(32).toString('base64url');
  process.env[tokenEnv] = token;
  t.after(() => {
    delete process.env[tokenEnv];
  });
  const app = await baseApp(10000);
  t.after(() => app.close());
  let mode = 'ok',
    leaked = false;
  app.post('/risk', async (req, reply) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const body = req.body as any;
    if (mode === 'redirect') return reply.redirect('/leak');
    if (mode === 'error') return reply.code(503).send({ private: 'details' });
    if (mode === 'large') return { text: 'x'.repeat(70000) };
    if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      modelId: mode === 'model' ? 'wrong' : body.modelId,
      modelVersion: mode === 'version' ? 'wrong' : body.modelVersion,
      inputHash: mode === 'hash' ? 'wrong' : body.inputHash,
      output: { status: 'insufficient-data', findings: [], missing: ['No observations'] },
    };
  });
  app.post('/leak', async () => {
    leaked = true;
    return {};
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = {
    endpoint: url + '/risk',
    tokenEnv,
    modelId: 'test-model',
    modelVersion: 'v1',
    label: 'Test model',
    intendedUse: 'Contract test',
    localDevelopmentOnly: true,
    timeoutMs: 100,
  };
  const runtime = await new Runtime().start([{ plugin, config }]);
  t.after(() => runtime.stop());
  const input = {
    protocol: 'eir.risk.v1' as const,
    ageYears: 46,
    evaluatedAt: new Date().toISOString(),
    readings: [],
    labs: [],
  };
  assert.equal((await runtime.get('riskEngine').evaluate(input)).status, 'insufficient-data');
  for (const value of ['hash', 'model', 'version', 'large', 'error', 'redirect', 'timeout']) {
    mode = value;
    await assert.rejects(runtime.get('riskEngine').evaluate(input));
  }
  assert.equal(leaked, false);
  await assert.rejects(
    new Runtime().start([{ plugin, config: { ...config, localDevelopmentOnly: false } }]),
    /HTTPS/,
  );
});
