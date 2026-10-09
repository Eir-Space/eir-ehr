import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveProfile } from '../packages/profile.ts';
import { assertMatches, checkPolicy, manifestSchema } from '../packages/plugin-manifest.ts';
import { fromConfig, loadProfile } from '../packages/runtime.ts';
import extractive from '../plugins/ai-extractive.ts';

const rendererLines = 'chartRenderers: [table]\ndefaultRenderer: table\n';
async function dir(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'eir-profile-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

test('layers apply in order: parents, own rows, then own patches', async () => {
  const root = await dir({
    'base.yaml': `profile: base\n${rendererLines}plugins:\n  - { id: a, module: ./a.ts, config: { x: 1 } }\n  - { id: b, module: ./b.ts }\n`,
    'top.yaml': `extends: [./base.yaml]\nprofile: top\npatches:\n  - configure: a\n    config: { y: 2 }\n  - insert: { id: c, module: ./c.ts }\n    after: a\n  - disable: b\n`,
  });
  const p = await resolveProfile(join(root, 'top.yaml'));
  assert.equal(p.profile, 'top');
  assert.deepEqual(
    p.rows.map((r) => [r.id, r.enabled]),
    [
      ['a', true],
      ['c', true],
      ['b', false],
    ],
  );
  assert.deepEqual(p.rows[0].config, { x: 1, y: 2 });
  assert.equal(p.rows[0].module, resolve(root, 'a.ts'));
  assert.ok(p.trace.some((t) => t.includes('insert c')));
});

test('replace swaps the whole row and remove deletes it', async () => {
  const root = await dir({
    'base.yaml': `profile: base\n${rendererLines}plugins:\n  - { id: a, module: ./a.ts, config: { x: 1 } }\n  - { id: b, module: ./b.ts }\n`,
    'top.yaml': `extends: [./base.yaml]\npatches:\n  - replace: a\n    with: { module: ./a2.ts }\n  - remove: b\n`,
  });
  const p = await resolveProfile(join(root, 'top.yaml'));
  assert.deepEqual(
    p.rows.map((r) => [r.id, r.config]),
    [['a', {}]],
  );
  assert.ok(p.rows[0].module.endsWith('a2.ts'));
});

test('invalid profiles fail with clear errors', async () => {
  const root = await dir({
    'cycle-a.yaml': `extends: [./cycle-b.yaml]\nprofile: a\n${rendererLines}`,
    'cycle-b.yaml': 'extends: [./cycle-a.yaml]\n',
    'unknown.yaml': `profile: u\n${rendererLines}patches:\n  - remove: nothing\n`,
    'dup.yaml': `profile: d\n${rendererLines}plugins:\n  - { id: a, module: ./a.ts }\npatches:\n  - insert: { id: a, module: ./a.ts }\n`,
    'norenderer.yaml': 'profile: n\n',
    'extra.yaml': `profile: e\n${rendererLines}surprise: true\n`,
  });
  await assert.rejects(resolveProfile(join(root, 'cycle-a.yaml')), /cycle/);
  await assert.rejects(resolveProfile(join(root, 'unknown.yaml')), /unknown row/);
  await assert.rejects(resolveProfile(join(root, 'dup.yaml')), /duplicates row/);
  await assert.rejects(resolveProfile(join(root, 'norenderer.yaml')), /renderer/);
  await assert.rejects(resolveProfile(join(root, 'extra.yaml')));
});

test('manifest must match the plugin code', () => {
  const m = manifestSchema.parse({
    id: extractive.id,
    version: extractive.version,
    apiVersion: 2,
    provides: extractive.provides,
  });
  assertMatches(m, extractive);
  assert.throws(() => assertMatches({ ...m, version: '9.9.9' }, extractive), /version/);
  assert.throws(() => assertMatches({ ...m, provides: ['store'] }, extractive), /provides/);
  assert.throws(() => manifestSchema.parse({ ...m, network: 'internet' }));
});

test('policy rejects excess egress, denied data classes and unevidenced language models', () => {
  const base = {
    id: 'eir.test',
    version: '1.0.0',
    apiVersion: 2 as const,
    provides: ['aiProvider'],
  };
  const cloud = manifestSchema.parse({
    ...base,
    network: 'any',
    dataClasses: ['identified-clinical'],
    intendedUse: { purpose: 'draft', usesLanguageModel: true },
  });
  const policy = {
    maxNetwork: 'loopback' as const,
    denyDataClasses: ['identified-clinical' as const],
    requireEvidenceForLanguageModels: true,
    requireManifest: true,
    allowedIsolation: ['process' as const],
  };
  const out = checkPolicy(policy, [{ id: 'cloud', manifest: cloud }, { id: 'bare' }]);
  assert.equal(out.length, 5);
  assert.ok(out.some((v) => v.includes('bare: no manifest')));
  assert.deepEqual(
    checkPolicy(
      {
        ...policy,
        requireManifest: false,
        maxNetwork: 'any',
        denyDataClasses: [],
        requireEvidenceForLanguageModels: false,
        allowedIsolation: ['in-process'],
      },
      [{ id: 'cloud', manifest: cloud }],
    ),
    [],
  );
});

test('layered YAML swaps the AI provider on top of the demo JSON and starts', async () => {
  const profile = resolve('eir.demo.config.json');
  const root = await dir({
    'overlay.yaml': `extends: [${JSON.stringify(profile)}]\nprofile: overlay\npatches:\n  - configure: storage-sqlite\n    config: { path: ':memory:' }\n  - disable: ai-review\n  - disable: fhir-r4\n`,
  });
  const { config, loaded } = await loadProfile(join(root, 'overlay.yaml'));
  assert.equal(config.profile, 'overlay');
  assert.ok(!loaded.some((l) => l.plugin.id === 'eir.ai.review'));
  assert.ok(loaded.some((l) => l.manifest?.id === 'eir.ai.extractive'));
});

test('existing JSON profiles still load and start', async () => {
  const { runtime, config } = await fromConfig(resolve('eir.config.json'), {
    'eir.storage.sqlite': { path: ':memory:' },
  });
  assert.ok(runtime.has('aiProvider'));
  assert.deepEqual(config.chartRenderers, ['timeline', 'table']);
  await runtime.stop();
});

test('startup refuses a profile that violates its own policy', async () => {
  const root = await dir({
    'strict.yaml': `profile: s\n${rendererLines}policy: { requireManifest: true }\nplugins:\n  - { module: ${JSON.stringify(resolve('plugins/country-se.ts'))} }\n`,
  });
  await assert.rejects(fromConfig(join(root, 'strict.yaml')), /policy violations.*no manifest/);
});
