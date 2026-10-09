import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../packages/contracts.ts';
import { fromConfig } from '../packages/runtime.ts';
import { root } from './helpers.ts';

const url = process.env.EIR_TEST_OPENEHR_URL;

test(
  'template-first clinical write commits one blood-pressure composition and reads both archetyped values',
  { skip: url ? false : 'EIR_TEST_OPENEHR_URL is not set' },
  async () => {
    const tenant = `t-${randomUUID()}`;
    const actor: Actor = { id: 'doctor-a', tenant, role: 'clinician' };
    const dir = await mkdtemp(join(tmpdir(), 'eir-template-first-openehr-'));
    const profile = join(dir, 'profile.yaml');
    await writeFile(
      profile,
      `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: template-first-openehr-test
patches:
  - insert:
      id: content-openehr
      module: ${JSON.stringify(root + 'plugins/content-openehr.ts')}
      config:
        endpoint: ${JSON.stringify(url)}
        username: ${JSON.stringify(process.env.EIR_TEST_OPENEHR_USER ?? 'ehrbase-user')}
        password: ${JSON.stringify(process.env.EIR_TEST_OPENEHR_PASSWORD ?? 'SuperSecretPassword')}
    before: clinical
  - insert: { id: clinical-models, module: ${JSON.stringify(root + 'plugins/clinical-model-openehr.ts')} }
    before: clinical
  - insert: { id: clinical-repository, module: ${JSON.stringify(root + 'plugins/clinical-repository.ts')}, config: { source: openehr, kinds: [observation] } }
    before: clinical
  - configure: clinical
    config: { canonicalKinds: [observation] }
`,
    );
    const { runtime } = await fromConfig(profile, {
      'eir.storage.sqlite': { path: ':memory:' },
      'eir.care-team': {
        members: [{ id: actor.id, tenant, name: 'Testläkare', profession: 'Läkare' }],
      },
    });
    try {
      const clinical = runtime.get('clinical');
      const patient = await clinical.register(actor, {
        name: 'Syntetisk Patient',
        birthDate: '1985-03-12',
        identifier: { type: 'local', value: `TEST-${randomUUID().toUpperCase()}` },
      });
      const encounter = await clinical.create(actor, patient.id, 'encounter', { reason: 'Test' });
      const pressure = await clinical.create(actor, patient.id, 'observation', {
        encounterId: encounter.id,
        code: '85354-9',
        systolic: 138,
        diastolic: 84,
        unit: 'mm[Hg]',
        effectiveAt: '2026-10-06T09:55:00+02:00',
        clientId: randomUUID(),
      });
      const store = runtime.contributions('contentStore').get('openehr')!;
      const systolic = await store.vitalSeries!(tenant, patient.id, '8480-6', 10);
      const diastolic = await store.vitalSeries!(tenant, patient.id, '8462-4', 10);
      assert.deepEqual(
        systolic.map((point) => point.value),
        [138],
      );
      assert.deepEqual(
        diastolic.map((point) => point.value),
        [84],
      );
      assert.equal(systolic[0].id, diastolic[0].id);
      assert.equal(pressure.data._canonical.contentId, systolic[0].id);
      assert.equal(
        (await clinical.chart(actor, patient.id)).find((row) => row.id === pressure.id)?.data.code,
        '85354-9',
      );
    } finally {
      await runtime.stop();
    }
  },
);
