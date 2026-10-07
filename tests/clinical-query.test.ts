import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../packages/contracts.ts';
import { createClinicalQuery } from '../packages/clinical-query.ts';
import { fromConfig } from '../packages/runtime.ts';
import { createApp } from '../apps/app.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
import { memory } from './memory-content.ts';
import { doctor, root } from './helpers.ts';

const doctorB: Actor = { id: 'doctor-b', tenant: 'clinic-b', role: 'clinician' };
const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;
const at = (day: number) => `2026-10-0${day}T08:00:00+02:00`;

async function setup() {
  memory.reset();
  const dir = await mkdtemp(join(tmpdir(), 'eir-query-'));
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: query-test
patches:
  - insert: { id: content-memory, module: ${JSON.stringify(root + 'tests/memory-content.ts')} }
    before: ai-review
  - insert: { id: projection, module: ${JSON.stringify(root + 'plugins/projection.ts')}, config: { target: memory, tenants: [clinic-a], backoffBaseMs: 0 } }
    before: ai-review
  - insert: { id: clinical-query, module: ${JSON.stringify(root + 'plugins/clinical-query.ts')}, config: { source: memory } }
    before: ai-review
`,
  );
  const { runtime } = await fromConfig(join(dir, 'p.yaml'), {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [
        { id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' },
        { id: 'doctor-b', tenant: 'clinic-b', name: 'Other clinician', profession: 'Läkare' },
      ],
    },
  });
  const clinical = runtime.get('clinical');
  const store = runtime.get('store') as SqliteStore;
  const patient = await clinical.register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: 'TEST-QUERY' },
  });
  const encounter = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Test' });
  const obs = (value: number, day: number, code = '8867-4', unit = '/min') =>
    clinical.create(doctor, patient.id, 'observation', {
      encounterId: encounter.id,
      code,
      value,
      unit,
      effectiveAt: at(day),
    });
  return {
    runtime,
    clinical,
    store,
    patient,
    obs,
    query: runtime.get('clinicalQuery'),
    projection: runtime.get('projection'),
  };
}
const link = async (f: Awaited<ReturnType<typeof setup>>, entityId: string) =>
  (await f.store.list('clinic-a', undefined, 'contentLink')).find(
    (l) => l.data.entityId === entityId,
  )!;

test('a verified series is served newest first with ledger provenance and full coverage', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const a = await f.obs(60, 1);
  const b = await f.obs(70, 3);
  const c = await f.obs(65, 2);
  await f.projection.runOnce();
  const answer = await f.query.vitals(doctor, f.patient.id, { code: '8867-4' });
  assert.deepEqual(
    answer.points.map((p) => p.value),
    [70, 65, 60],
  );
  assert.deepEqual(
    answer.points.map((p) => p.ref),
    [`${b.id}@1`, `${c.id}@1`, `${a.id}@1`],
  );
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.coverage, {
    ledger: 3,
    served: 3,
    notProjected: 0,
    unmapped: 0,
    stale: 0,
    diverged: 0,
    missing: 0,
  });
  assert.equal(answer.source, 'memory');
  const limited = await f.query.vitals(doctor, f.patient.id, { code: '8867-4', limit: 1 });
  assert.equal(limited.points.length, 1);
  const windowed = await f.query.vitals(doctor, f.patient.id, {
    code: '8867-4',
    from: at(2),
    to: at(2),
  });
  assert.deepEqual(
    windowed.points.map((p) => p.value),
    [65],
  );
  assert.equal(windowed.coverage.ledger, 1, 'coverage follows the requested window');
  assert.equal(windowed.complete, true);
});

test('every way a record can fail to be served is counted, so the answer says it is incomplete', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const fine = await f.obs(60, 1);
  const stale = await f.obs(61, 2);
  const diverged = await f.obs(62, 3);
  const missing = await f.obs(63, 4);
  await f.projection.runOnce();
  const unprojected = await f.obs(64, 5);
  // stale: the ledger moved on after projection
  await f.store.revise(
    doctor,
    (await f.store.get('clinic-a', stale.id))!,
    1,
    { ...stale.data },
    'test.revise',
  );
  // diverged: the copy no longer agrees with the legal record
  [...memory.records.values()].find(
    (r) => r.versions[0].data.value === 62,
  )!.versions[0].data.value = 99;
  // missing: the copy was deleted
  memory.records.delete(String((await link(f, missing.id)).data.contentId));
  // foreign: a record in the target that no ledger link explains
  await memory.insert(doctor, 'observation', f.patient.id, {
    code: '8867-4',
    value: 1,
    unit: '/min',
    effectiveAt: at(6),
  });
  const answer = await f.query.vitals(doctor, f.patient.id, { code: '8867-4' });
  assert.deepEqual(
    answer.points.map((p) => p.entityId),
    [fine.id],
  );
  assert.deepEqual(answer.coverage, {
    ledger: 5,
    served: 1,
    notProjected: 1,
    unmapped: 0,
    stale: 1,
    diverged: 1,
    missing: 1,
  });
  assert.equal(answer.foreign, 1);
  assert.equal(answer.complete, false);
  void diverged;
  void unprojected;
});

test('unmappable records are reported as unmapped; corrected records are not part of the question', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  memory.unsupportedCodes.add('8310-5');
  await f.obs(37.1, 1, '8310-5', 'Cel');
  const wrong = await f.obs(70, 2);
  const right = await f.obs(71, 3);
  await f.clinical.transition(doctor, wrong.id, 'correct', 1, { reason: 'Felregistrerad' });
  await f.projection.runOnce();
  const pulse = await f.query.vitals(doctor, f.patient.id, { code: '8867-4' });
  assert.deepEqual(
    pulse.points.map((p) => p.entityId),
    [right.id],
  );
  assert.equal(pulse.coverage.ledger, 1, 'the corrected record is excluded');
  assert.equal(pulse.complete, true);
  const temp = await f.query.vitals(doctor, f.patient.id, { code: '8310-5' });
  assert.deepEqual([temp.points.length, temp.coverage.unmapped, temp.complete], [0, 1, false]);
});

test('problems are served with the ledger status and can be filtered by it', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const terms = f.runtime
    .get('terminology')
    .search('infektion', 50)
    .items.filter((x) => x.selectable);
  const make = (term: (typeof terms)[number]) =>
    f.clinical.create(doctor, f.patient.id, 'condition', {
      code: { system: term.system, code: term.code, display: term.display },
    });
  const active = await make(terms[0]);
  const wrong = await make(terms[1]);
  await f.clinical.transition(doctor, wrong.id, 'correct', 1, { reason: 'Fel diagnos' });
  await f.projection.runOnce();
  const all = await f.query.problems(doctor, f.patient.id);
  assert.deepEqual(
    all.problems.map((p) => [p.entityId, p.status, p.code]),
    [[active.id, 'active', terms[0].code]],
  );
  assert.equal(all.complete, true);
  assert.equal(
    (await f.query.problems(doctor, f.patient.id, { status: 'resolved' })).problems.length,
    0,
  );
});

test('access is checked on the ledger and audited; patients and other clinics are refused', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  await f.obs(60, 1);
  await f.projection.runOnce();
  const calls = memory.calls.get;
  await assert.rejects(f.query.vitals(doctorB, f.patient.id, { code: '8867-4' }), (e) =>
    [403, 404].includes((e as { status: number }).status),
  );
  const self = { ...doctor, id: 'self', role: 'patient' as const, patientId: f.patient.id };
  await assert.rejects(f.query.vitals(self, f.patient.id, { code: '8867-4' }), status(403));
  assert.equal(
    memory.calls.get,
    calls,
    'nothing was read from the content store for a refused caller',
  );
  await f.query.vitals(doctor, f.patient.id, { code: '8867-4' });
  const rows = (await f.store.auditEntries('clinic-a', f.patient.id)) as {
    actor: string;
    action: string;
  }[];
  assert.ok(rows.some((r) => r.actor === doctor.id && r.action === 'query.vitals'));
  assert.equal((await f.store.verifyAudit()).ok, true);
});

test('callers choose a query, never query text, and inputs are validated', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  for (const bad of [
    { code: "8867-4' OR 1=1 --" },
    { code: '8867-4', from: 'yesterday' },
    { code: '8867-4', limit: 5000 },
    { code: '8867-4', extra: 1 } as never,
  ])
    await assert.rejects(f.query.vitals(doctor, f.patient.id, bad));
  const bare = createClinicalQuery({
    store: f.store,
    access: f.runtime.get('access'),
    options: { source: 'none' },
    source: () => ({ ...memory, vitalSeries: undefined }) as never,
  });
  await assert.rejects(bare.vitals(doctor, f.patient.id, { code: '8867-4' }), status(501));
});

test('the HTTP route serves the same verified answer and is documented', async (t) => {
  const f = await setup();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  const first = await f.obs(72, 1);
  await f.projection.runOnce();
  const headers = { authorization: `Bearer ${await f.runtime.get('identity').issue!(doctor)}` };
  const res = await app.inject({
    url: `/api/patients/${f.patient.id}/query/vitals?code=8867-4`,
    headers,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.points.map((p: { ref: string }) => p.ref),
    [`${first.id}@1`],
  );
  assert.equal(body.complete, true);
  assert.equal(
    (await app.inject({ url: `/api/patients/${f.patient.id}/query/vitals?code=bad`, headers }))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/patients/${f.patient.id}/query/vitals?code=8867-4&x=1`,
        headers,
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await app.inject({ url: `/api/patients/${f.patient.id}/query/vitals?code=8867-4` }))
      .statusCode,
    401,
  );
  const spec = (await app.inject({ url: '/api/openapi.json', headers })).json();
  assert.ok(spec.paths['/patients/{id}/query/vitals'].get);
});
