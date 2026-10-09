import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
import { riskInput } from '../packages/deterioration.ts';
import { project } from '../plugins/fhir-r4.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
import { doctor, root } from './helpers.ts';
import { memory } from './memory-content.ts';

const at = '2026-10-06T09:55:00+02:00';

async function setup() {
  memory.reset();
  const dir = await mkdtemp(join(tmpdir(), 'eir-template-first-'));
  const profile = join(dir, 'profile.yaml');
  await writeFile(
    profile,
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: template-first-test
patches:
  - insert: { id: content-memory, module: ${JSON.stringify(root + 'tests/memory-content.ts')} }
    before: clinical
  - insert: { id: clinical-models, module: ${JSON.stringify(root + 'plugins/clinical-model-openehr.ts')} }
    before: clinical
  - insert: { id: clinical-repository, module: ${JSON.stringify(root + 'plugins/clinical-repository.ts')}, config: { source: memory, kinds: [observation] } }
    before: clinical
  - configure: clinical
    config: { canonicalKinds: [observation] }
  - insert: { id: clinical-query, module: ${JSON.stringify(root + 'plugins/clinical-query.ts')}, config: { source: memory } }
    after: clinical
`,
  );
  const { runtime } = await fromConfig(profile, {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [{ id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' }],
    },
  });
  const clinical = runtime.get('clinical');
  const clinicalQuery = runtime.get('clinicalQuery');
  const store = runtime.get('store') as SqliteStore;
  const patient = await clinical.register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: `TEST-${randomUUID().toUpperCase()}` },
  });
  const encounter = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Test' });
  return { runtime, clinical, clinicalQuery, store, patient, encounter };
}

test('template-first vital writes canonical content first and recovers idempotently', async () => {
  const f = await setup();
  try {
    const clientId = randomUUID();
    memory.crashAfterInsert = 1;
    const input = {
      encounterId: f.encounter.id,
      code: '8867-4',
      value: 70,
      unit: '/min',
      effectiveAt: at,
      clientId,
    };
    const made = await f.clinical.create(doctor, f.patient.id, 'observation', input);
    const again = await f.clinical.create(doctor, f.patient.id, 'observation', input);
    assert.equal(again.id, made.id);
    assert.equal(memory.records.size, 1);
    assert.equal(made.data._canonical.repository, 'memory');
    assert.equal(made.data._canonical.templateId, 'IDCR - Vital Signs Encounter.v1');
    assert.match(made.data._canonical.templateSha256, /^[a-f0-9]{64}$/);

    const writes = await f.store.list(doctor.tenant, f.patient.id, 'clinicalWrite');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.status, 'completed');
    assert.equal(writes[0].data.requestHash.length, 64);
    for (const clinicalField of ['code', 'value', 'unit', 'effectiveAt', 'components']) {
      assert.equal(clinicalField in writes[0].data, false);
    }

    const chart = await f.clinical.chart(doctor, f.patient.id);
    assert.equal(chart.filter((row) => row.kind === 'observation').length, 1);
    assert.equal(
      chart.some((row) => row.kind === 'clinicalWrite' || row.kind === 'contentLink'),
      false,
    );
  } finally {
    await f.runtime.stop();
  }
});

test('chart and history resolve the canonical repository, while SQL remains a rebuildable mirror', async () => {
  const f = await setup();
  try {
    const made = await f.clinical.create(doctor, f.patient.id, 'observation', {
      encounterId: f.encounter.id,
      code: '8867-4',
      value: 70,
      unit: '/min',
      effectiveAt: at,
      clientId: randomUUID(),
    });
    const contentId = made.data._canonical.contentId;
    const canonical = (await memory.get(doctor.tenant, contentId))!;
    await memory.revise(doctor, canonical, canonical.version, { ...canonical.data, value: 73 });

    const rawMirror = await f.store.get(doctor.tenant, made.id);
    assert.equal(rawMirror!.data.value, 70);
    const resolved = (await f.clinical.chart(doctor, f.patient.id)).find(
      (row) => row.id === made.id,
    );
    assert.equal(resolved!.data.value, 73);
    assert.equal(resolved!.data._canonical.version, 2);
    assert.equal(project(resolved!)!.meta.versionId, '2');
    const series = await f.clinicalQuery.vitals(doctor, f.patient.id, { code: '8867-4' });
    assert.equal(series.complete, true);
    assert.deepEqual(
      series.points.map((point) => point.value),
      [73],
    );
    assert.deepEqual(
      (await f.clinical.history(doctor, made.id)).map((row) => row.data.value),
      [70, 73],
    );

    f.store.db.exec(
      "CREATE TRIGGER fail_canonical_correction BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='observation.canonical-correct' BEGIN SELECT RAISE(ABORT,'audit failure'); END",
    );
    await assert.rejects(
      f.clinical.transition(doctor, made.id, 'correct', made.version, {
        reason: 'Fel patient',
      }),
      /audit failure/,
    );
    assert.equal((await f.store.get(doctor.tenant, made.id))!.data.status, 'final');
    assert.equal((await memory.get(doctor.tenant, contentId))!.data.status, 'entered-in-error');
    f.store.db.exec('DROP TRIGGER fail_canonical_correction');
    const corrected = await f.clinical.transition(doctor, made.id, 'correct', made.version, {
      reason: 'Fel patient',
    });
    assert.equal(corrected.data.status, 'entered-in-error');
    assert.equal(corrected.data._canonical.version, 3);
    assert.equal((await memory.get(doctor.tenant, contentId))!.data.status, 'entered-in-error');
  } finally {
    await f.runtime.stop();
  }
});

test('a canonical commit survives SQL finalization failure and retry creates no duplicate', async () => {
  const f = await setup();
  try {
    const input = {
      encounterId: f.encounter.id,
      code: '8867-4',
      value: 70,
      unit: '/min',
      effectiveAt: at,
      clientId: randomUUID(),
    };
    f.store.db.exec(
      "CREATE TRIGGER fail_canonical_create BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='observation.canonical-created' BEGIN SELECT RAISE(ABORT,'audit failure'); END",
    );
    await assert.rejects(
      f.clinical.create(doctor, f.patient.id, 'observation', input),
      /audit failure/,
    );
    assert.equal(memory.records.size, 1);
    assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'observation')).length, 0);
    const operation = (await f.store.list(doctor.tenant, f.patient.id, 'clinicalWrite'))[0];
    assert.equal(operation.data.status, 'repository-committed');

    f.store.db.exec('DROP TRIGGER fail_canonical_create');
    const recovered = await f.clinical.create(doctor, f.patient.id, 'observation', input);
    assert.equal(recovered.data.value, 70);
    assert.equal(memory.records.size, 1);
    assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'observation')).length, 1);
  } finally {
    await f.runtime.stop();
  }
});

test('the active template rejects unmapped weight and captures blood pressure as one composition', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.clinical.create(doctor, f.patient.id, 'observation', {
        encounterId: f.encounter.id,
        code: '29463-7',
        value: 80,
        unit: 'kg',
        effectiveAt: at,
        clientId: randomUUID(),
      }),
      (error: any) => error.status === 422,
    );
    const pressure = await f.clinical.create(doctor, f.patient.id, 'observation', {
      encounterId: f.encounter.id,
      code: '85354-9',
      systolic: 138,
      diastolic: 84,
      unit: 'mm[Hg]',
      effectiveAt: at,
      clientId: randomUUID(),
    });
    assert.deepEqual(
      pressure.data.components.map((item: any) => [item.code, item.value]),
      [
        ['8480-6', 138],
        ['8462-4', 84],
      ],
    );
    const input = riskInput(f.patient, f.encounter.id, [pressure], new Date().toISOString());
    assert.deepEqual(
      input.readings.map((reading) => [reading.code, reading.value]),
      [
        ['8462-4', 84],
        ['8480-6', 138],
      ],
    );
    const resource = project(pressure)!;
    assert.equal(resource.resourceType, 'Observation');
    assert.equal(resource.code.coding[0].code, '85354-9');
    assert.equal(resource.component.length, 2);
  } finally {
    await f.runtime.stop();
  }
});

test('a changed request cannot reuse a canonical write operation id', async () => {
  const f = await setup();
  try {
    const clientId = randomUUID();
    const base = {
      encounterId: f.encounter.id,
      code: '8867-4',
      unit: '/min',
      effectiveAt: at,
      clientId,
    };
    await f.clinical.create(doctor, f.patient.id, 'observation', { ...base, value: 70 });
    await assert.rejects(
      f.clinical.create(doctor, f.patient.id, 'observation', { ...base, value: 71 }),
      (error: any) => error.status === 409,
    );
    assert.equal(memory.records.size, 1);
  } finally {
    await f.runtime.stop();
  }
});

test('a live operation lease prevents concurrent canonical inserts', async () => {
  const f = await setup();
  const originalInsert = memory.insert;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  memory.insert = async (...args) => {
    started();
    await gate;
    return await originalInsert.call(memory, ...args);
  };
  try {
    const input = {
      encounterId: f.encounter.id,
      code: '8867-4',
      value: 70,
      unit: '/min',
      effectiveAt: at,
      clientId: randomUUID(),
    };
    const first = f.clinical.create(doctor, f.patient.id, 'observation', input);
    await writing;
    await assert.rejects(
      f.clinical.create(doctor, f.patient.id, 'observation', input),
      (error: any) => error.status === 409,
    );
    release();
    await first;
    assert.equal(memory.records.size, 1);
  } finally {
    release();
    memory.insert = originalInsert;
    await f.runtime.stop();
  }
});
