import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, fromConfig } from '../packages/runtime.ts';
import type { AIProvider, Plugin } from '../packages/contracts.ts';
import router from '../plugins/ai-router.ts';
import modelExtractive from '../plugins/model-extractive.ts';
import modelOllama from '../plugins/model-ollama.ts';
import { root, doctor } from './helpers.ts';

const evidence = [{ ref: 'e@1', text: 'Syntetiskt test: puls 72 /min.' }];
const fake = (key: string, provider: AIProvider): Plugin => ({
  id: `test.model.${key}`,
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['aiModel'],
  setup: (ctx) => ctx.contribute('aiModel', key, provider),
});
const ok =
  (model: string): AIProvider['generate'] =>
  async (ev) => ({
    text: ev[0].text,
    citations: ev,
    model,
    mode: 'model',
  });

test('router falls through failing and missing models to the first that answers', async () => {
  const bad: AIProvider = {
    id: 'bad',
    meta: { network: 'loopback', usesLanguageModel: true },
    generate: async () => {
      throw new Error('clinical text must not leak: Syntetiskt');
    },
  };
  const good: AIProvider = {
    id: 'good',
    meta: { network: 'none', usesLanguageModel: false },
    generate: ok('good-model'),
  };
  const runtime = await new Runtime().start([
    { plugin: fake('bad', bad) },
    { plugin: fake('good', good) },
    { plugin: router, config: { chain: ['absent', 'bad', 'good'] } },
  ]);
  const out = await runtime.get('aiProvider').generate(evidence);
  assert.equal(out.model, 'good-model');
  await runtime.stop();
});

test('router never calls a model above maxNetwork or without declared reach, and fails closed', async () => {
  let called = 0;
  const cloud: AIProvider = {
    id: 'cloud',
    meta: { network: 'any', usesLanguageModel: true },
    generate: async (ev) => (called++, ok('cloud')(ev)),
  };
  const undeclared: AIProvider = { id: 'u', generate: async (ev) => (called++, ok('u')(ev)) };
  const runtime = await new Runtime().start([
    { plugin: fake('cloud', cloud) },
    { plugin: fake('undeclared', undeclared) },
    { plugin: router, config: { chain: ['cloud', 'undeclared'], maxNetwork: 'loopback' } },
  ]);
  await assert.rejects(
    runtime.get('aiProvider').generate(evidence),
    (e: Error) =>
      /No AI model answered/.test(e.message) &&
      /cloud: blocked/.test(e.message) &&
      !e.message.includes('Syntetiskt'),
  );
  assert.equal(called, 0);
  await runtime.stop();
});

test('router times out a hung model and falls back', async () => {
  const hung: AIProvider = {
    id: 'hung',
    meta: { network: 'loopback', usesLanguageModel: true },
    generate: () => new Promise(() => {}),
  };
  const good: AIProvider = {
    id: 'g',
    meta: { network: 'none', usesLanguageModel: false },
    generate: ok('fast'),
  };
  const runtime = await new Runtime().start([
    { plugin: fake('hung', hung) },
    { plugin: fake('good', good) },
    { plugin: router, config: { chain: ['hung', 'good'], timeoutMs: 1000 } },
  ]);
  assert.equal((await runtime.get('aiProvider').generate(evidence)).model, 'fast');
  await runtime.stop();
});

test('contributions must be declared and keys are unique; teardown removes them', async () => {
  const good: AIProvider = { id: 'g', generate: ok('m') };
  const undeclared: Plugin = { ...fake('a', good), contributes: [] };
  await assert.rejects(
    new Runtime().start([{ plugin: undeclared }]),
    /provides or contributes nothing/,
  );
  await assert.rejects(
    new Runtime().start([
      { plugin: fake('a', good) },
      { plugin: { ...fake('a', good), id: 'test.model.a2' } },
    ]),
    /Invalid contribution/,
  );
  const runtime = await new Runtime().start([{ plugin: fake('a', good) }]);
  assert.equal(runtime.contributions('aiModel').size, 1);
  await runtime.stop();
  assert.equal(runtime.contributions('aiModel').size, 0);
});

test('real model plugins register named candidates; two Ollama models can coexist', async () => {
  const runtime = await new Runtime().start([
    { plugin: modelOllama, config: { key: 'small', model: 'a' } },
    { plugin: { ...modelOllama, id: 'eir.model.ollama2' }, config: { key: 'large', model: 'b' } },
    { plugin: modelExtractive },
  ]);
  assert.deepEqual([...runtime.contributions('aiModel').keys()].sort(), [
    'extractive',
    'large',
    'small',
  ]);
  await runtime.stop();
  await assert.rejects(
    new Runtime().start([
      { plugin: modelOllama, config: { endpoint: 'http://example.com:11434', model: 'a' } },
    ]),
    /loopback/,
  );
});

test('AI review falls back from an unreachable local model to the extractive provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eir-router-'));
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: router-e2e
patches:
  - remove: ai-extractive
  - insert: { id: ai-router, module: ${JSON.stringify(root + 'plugins/ai-router.ts')}, config: { chain: [dead, extractive] } }
    before: ai-review
  - insert: { id: model-dead, module: ${JSON.stringify(root + 'plugins/model-ollama.ts')}, config: { key: dead, model: none, endpoint: 'http://127.0.0.1:9' } }
    before: ai-review
  - insert: { id: model-extractive, module: ${JSON.stringify(root + 'plugins/model-extractive.ts')} }
    before: ai-review
`,
  );
  const { runtime } = await fromConfig(join(dir, 'p.yaml'), {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [{ id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' }],
    },
  });
  const clinical = runtime.get('clinical');
  const patient = await clinical.register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: 'TEST-ROUTER' },
  });
  const encounter = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Test' });
  await clinical.create(doctor, patient.id, 'note', {
    encounterId: encounter.id,
    text: 'Syntetisk anteckning om återbesök.',
  });
  const proposal = await runtime.get('aiReview').propose(doctor, patient.id, encounter.id);
  assert.match(String(proposal.data.model), /extractive/);
  assert.match(String(proposal.data.provider), /^router:dead>extractive$/);
  await runtime.stop();
});
