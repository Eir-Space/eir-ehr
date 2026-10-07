import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../packages/contracts.ts';
import { fromConfig } from '../packages/runtime.ts';
import { createProjection } from '../packages/projection.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
import { memory } from './memory-content.ts';
import { doctor, root } from './helpers.ts';

const doctorB: Actor = { id: 'doctor-b', tenant: 'clinic-b', role: 'clinician' };
const past = '2026-10-06T09:55:00+02:00';

async function setup(config: Record<string, unknown> = {}) {
  memory.reset();
  const dir = await mkdtemp(join(tmpdir(), 'eir-projection-'));
  const conf = JSON.stringify({
    target: 'memory',
    tenants: ['clinic-a'],
    backoffBaseMs: 0,
    ...config,
  });
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: projection-test
patches:
  - insert: { id: content-memory, module: ${JSON.stringify(root + 'tests/memory-content.ts')} }
    before: ai-review
  - insert: { id: projection, module: ${JSON.stringify(root + 'plugins/projection.ts')}, config: ${conf} }
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
    identifier: { type: 'local', value: 'TEST-PROJ' },
  });
  const encounter = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Test' });
  const pulse = (value = 72) =>
    clinical.create(doctor, patient.id, 'observation', {
      encounterId: encounter.id,
      code: '8867-4',
      value,
      unit: '/min',
      effectiveAt: past,
    });
  const note = () =>
    clinical.create(doctor, patient.id, 'note', {
      encounterId: encounter.id,
      text: 'Syntetisk anteckning',
    });
  return {
    runtime,
    clinical,
    store,
    patient,
    encounter,
    pulse,
    note,
    projection: runtime.get('projection'),
  };
}
const only = <T>(list: T[]) => {
  assert.equal(list.length, 1);
  return list[0];
};

test('projection copies every kind, records links, and a second run writes nothing', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  await f.pulse();
  await f.note();
  const term = f.runtime
    .get('terminology')
    .search('infektion', 50)
    .items.find((x) => x.selectable)!;
  await f.clinical.create(doctor, f.patient.id, 'condition', {
    code: { system: term.system, code: term.code, display: term.display },
  });
  const first = only(await f.projection.runOnce());
  assert.deepEqual([first.scanned, first.projected, first.failed, first.unmapped], [3, 3, 0, 0]);
  assert.equal(memory.records.size, 3);
  const links = await f.store.list('clinic-a', undefined, 'contentLink');
  assert.equal(links.length, 3);
  assert.ok(links.every((l) => l.data.status === 'synced' && l.data.contentId));
  const writes = memory.calls.insert + memory.calls.revise;
  const second = only(await f.projection.runOnce());
  assert.deepEqual([second.upToDate, second.projected], [3, 0]);
  assert.equal(memory.calls.insert + memory.calls.revise, writes);
  assert.deepEqual(only(await f.projection.reconcile()).counts, { ok: 3 });
});

test('a record with several versions, ending signed, is replayed in order', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const n = await f.note();
  const saved = await f.clinical.transition(doctor, n.id, 'save', 1, { text: 'Reviderad' });
  await f.clinical.transition(doctor, n.id, 'sign', saved.version, {});
  only(await f.projection.runOnce());
  const remote = [...memory.records.values()][0];
  assert.deepEqual(
    remote.versions.map((v) => v.version),
    [1, 2, 3],
  );
  assert.deepEqual(
    remote.versions.map((v) => v.data.status),
    ['draft', 'draft', 'signed'],
  );
  assert.equal(remote.versions[2].data.signedBy, doctor.id);
  // A later ledger revision (an amendment cannot reopen it) is not needed; the signed state stays.
  assert.deepEqual(only(await f.projection.reconcile()).counts, { ok: 1 });
});

test('a crash after the content was written does not duplicate it on retry', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  await f.pulse();
  memory.crashAfterInsert = 1;
  assert.equal(only(await f.projection.runOnce()).failed, 1);
  assert.equal(memory.records.size, 1);
  const retry = only(await f.projection.runOnce());
  assert.equal(retry.projected, 1);
  assert.equal(memory.records.size, 1, 'no duplicate composition');
  assert.equal(memory.calls.insert, 1, 'the retry found the record by its origin key');
  assert.deepEqual(only(await f.projection.reconcile()).counts, { ok: 1 });
});

test('a crash part-way through a history resumes from the target version', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const n = await f.note();
  const saved = await f.clinical.transition(doctor, n.id, 'save', 1, { text: 'Två' });
  await f.clinical.transition(doctor, n.id, 'save', saved.version, { text: 'Tre' });
  memory.failNext = { revise: 1 };
  assert.equal(only(await f.projection.runOnce()).failed, 1);
  assert.equal([...memory.records.values()][0].versions.length, 1);
  assert.equal(only(await f.projection.runOnce()).projected, 1);
  const remote = [...memory.records.values()][0];
  assert.deepEqual(
    remote.versions.map((v) => v.data.text),
    ['Syntetisk anteckning', 'Två', 'Tre'],
  );
  assert.equal(memory.calls.insert, 1);
});

test('data the target cannot represent is recorded once and does not block other records', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  memory.unsupportedCodes.add('29463-7');
  await f.clinical.create(doctor, f.patient.id, 'observation', {
    encounterId: f.encounter.id,
    code: '29463-7',
    value: 80,
    unit: 'kg',
    effectiveAt: past,
  });
  await f.pulse();
  const first = only(await f.projection.runOnce());
  assert.deepEqual([first.projected, first.unmapped], [1, 1]);
  const second = only(await f.projection.runOnce());
  assert.deepEqual([second.unmapped, second.projected], [1, 0]);
  assert.equal(memory.calls.insert, 2, 'the unmapped record is not retried');
  const counts = only(await f.projection.reconcile()).counts;
  assert.deepEqual(counts, { ok: 1, unmapped: 1 });
});

test('an outage is recorded safely, backed off, and recovers by itself', async (t) => {
  const f = await setup({ backoffBaseMs: 60000 });
  t.after(() => f.runtime.stop());
  await f.pulse();
  memory.failNext = { insert: 1 };
  assert.equal(only(await f.projection.runOnce()).failed, 1);
  const link = only(await f.store.list('clinic-a', undefined, 'contentLink'));
  assert.equal(link.data.status, 'error');
  assert.equal(link.data.reason, 'target unavailable');
  assert.ok(
    !JSON.stringify(link.data).includes('Syntetisk'),
    'error text never reaches the ledger',
  );
  assert.equal(only(await f.projection.runOnce()).deferred, 1, 'within the backoff window');
  assert.equal(memory.calls.insert, 1);
  // Same ledger, no backoff: the next run recovers.
  const g = await setup({ backoffBaseMs: 0 });
  t.after(() => g.runtime.stop());
  await g.pulse();
  memory.failNext = { insert: 2 };
  assert.equal(only(await g.projection.runOnce()).failed, 1);
  assert.equal(only(await g.projection.runOnce()).failed, 1);
  assert.equal(only(await g.projection.runOnce()).projected, 1);
});

test('reconcile classifies every kind of drift and exposes only ids', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const a = await f.pulse(60);
  const b = await f.pulse(61);
  const c = await f.pulse(62);
  const d = await f.pulse(63);
  const n = await f.note();
  await f.projection.runOnce();
  const remoteOf = async (id: string) => {
    const link = (await f.store.list('clinic-a', undefined, 'contentLink')).find(
      (l) => l.data.entityId === id,
    )!;
    return memory.records.get(String(link.data.contentId))!;
  };
  await f.pulse(64); // unlinked: created after the run
  await f.clinical.transition(doctor, n.id, 'save', 1, { text: 'Ny version' }); // behind
  (await remoteOf(a.id)).versions[0].data.value = 99; // diverged
  const gone = await remoteOf(b.id);
  memory.records.delete(gone.versions[0].id); // missing
  const ahead = await remoteOf(c.id);
  await memory.revise(doctor, ahead.versions[0], 1, { ...ahead.versions[0].data, value: 63 }); // ahead
  void d;
  const report = only(await f.projection.reconcile());
  assert.deepEqual(report.counts, {
    ok: 1,
    unlinked: 1,
    behind: 1,
    diverged: 1,
    missing: 1,
    ahead: 1,
  });
  assert.equal(report.samples.diverged[0], a.id);
  assert.ok(!JSON.stringify(report).includes('Syntetisk'));
  assert.equal(report.entities, 6);
});

test('only configured tenants are projected, and a duplicate link is reported', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const other = await f.clinical.register(doctorB, {
    name: 'Annan Patient',
    birthDate: '1970-01-01',
    identifier: { type: 'local', value: 'TEST-OTHER' },
  });
  const enc = await f.clinical.create(doctorB, other.id, 'encounter', { reason: 'Test' });
  await f.clinical.create(doctorB, other.id, 'note', { encounterId: enc.id, text: 'Annan klinik' });
  await f.pulse();
  await f.projection.runOnce();
  assert.equal(memory.records.size, 1);
  assert.ok([...memory.records.values()].every((r) => r.versions[0].tenant === 'clinic-a'));
  assert.equal((await f.store.list('clinic-b', undefined, 'contentLink')).length, 0);
  const link = only(await f.store.list('clinic-a', undefined, 'contentLink'));
  await f.store.insert(
    { id: 'x', tenant: 'clinic-a', role: 'integration' },
    'contentLink',
    link.patientId,
    { ...link.data },
  );
  assert.equal(only(await f.projection.reconcile()).counts['duplicate-link'], 1);
});

test('every disclosure is on the verified audit chain, and links never appear in the chart', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  await f.pulse();
  await f.projection.runOnce();
  assert.equal((await f.store.verifyAudit()).ok, true);
  const rows = (await f.store.auditEntries('clinic-a', f.patient.id)) as {
    actor: string;
    action: string;
  }[];
  const projected = rows.filter((r) => r.actor === 'projection');
  assert.ok(projected.some((r) => r.action === 'contentLink.synced'));
  assert.ok(projected.some((r) => r.action === 'contentLink.created'));
  const chart = await f.clinical.chart(doctor, f.patient.id);
  assert.ok(!chart.some((e) => e.kind === 'contentLink'));
});

test('a target without idempotent insert is refused', async () => {
  const noKey = { ...memory, findByOrigin: undefined } as unknown as typeof memory;
  const projection = createProjection({
    store: {} as never,
    content: () => noKey,
    options: { target: 'x', tenants: ['t'] },
  });
  await assert.rejects(projection.runOnce(), /idempotent/);
  await assert.rejects(projection.reconcile(), /idempotent/);
});
