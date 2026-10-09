import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
import { memory } from './memory-content.ts';
import { doctor, root } from './helpers.ts';

const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;
const at = (day: number) => `2026-10-0${day}T08:00:00+02:00`;

async function setup(history: Record<string, unknown> | null = { perCode: 5 }) {
  memory.reset();
  const dir = await mkdtemp(join(tmpdir(), 'eir-ai-history-'));
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: ai-history-test
patches:
  - insert: { id: content-memory, module: ${JSON.stringify(root + 'tests/memory-content.ts')} }
    before: ai-review
  - insert: { id: projection, module: ${JSON.stringify(root + 'plugins/projection.ts')}, config: { target: memory, tenants: [clinic-a], backoffBaseMs: 0 } }
    before: ai-review
  - insert: { id: clinical-query, module: ${JSON.stringify(root + 'plugins/clinical-query.ts')}, config: { source: memory } }
    before: ai-review
${history ? `  - configure: ai-review\n    config: { history: ${JSON.stringify(history)} }\n` : ''}`,
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
    identifier: { type: 'local', value: 'TEST-AIH' },
  });
  const obs = (encounterId: string, value: number, day: number) =>
    clinical.create(doctor, patient.id, 'observation', {
      encounterId,
      code: '8867-4',
      value,
      unit: '/min',
      effectiveAt: at(day),
    });
  // An earlier, finished encounter with three readings, then the open one.
  const earlier = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Tidigare' });
  const old = [
    await obs(earlier.id, 60, 1),
    await obs(earlier.id, 62, 2),
    await obs(earlier.id, 64, 3),
  ];
  await clinical.transition(doctor, earlier.id, 'close', earlier.version, {});
  const current = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Nu' });
  const today = await obs(current.id, 72, 5);
  await clinical.create(doctor, patient.id, 'note', {
    encounterId: current.id,
    text: 'Syntetisk anteckning',
  });
  await runtime.get('projection').runOnce();
  return {
    runtime,
    clinical,
    store: runtime.get('store'),
    patient,
    old,
    today,
    current,
    review: runtime.get('aiReview'),
  };
}
const refs = (p: { data: Record<string, any> }) =>
  (p.data.evidence as { ref: string }[]).map((e) => e.ref);

test('earlier readings verified by the content store become pinned evidence, and the proposal is accepted', async (t) => {
  const f = await setup({ perCode: 2 });
  t.after(() => f.runtime.stop());
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  // The two newest earlier readings, not the oldest, and the current encounter's own reading as before.
  const [o1, o2, o3] = f.old;
  assert.deepEqual(proposal.data.historyRefs, [`${o3.id}@1`, `${o2.id}@1`]);
  assert.ok(refs(proposal).includes(`${f.today.id}@1`));
  assert.ok(!refs(proposal).includes(`${o1.id}@1`));
  const history = proposal.data.evidence.filter((e: { ref: string }) =>
    proposal.data.historyRefs.includes(e.ref),
  );
  assert.match(history[0].text, /: 64 \/min \(/, 'text is built from the ledger record');
  assert.equal(proposal.data.historyContext.complete, true);
  const reviewed = await f.review.review(doctor, proposal.id, proposal.version, 'accept');
  assert.equal(reviewed.data.status, 'accepted');
  assert.ok(reviewed.data.noteId);
});

test('correcting an earlier reading after the proposal invalidates it', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  assert.ok(proposal.data.historyRefs.length === 3);
  await f.clinical.transition(doctor, f.old[1].id, 'correct', 1, { reason: 'Felregistrerad' });
  await assert.rejects(
    f.review.review(doctor, proposal.id, proposal.version, 'accept'),
    status(409),
  );
  const fresh = await f.review.propose(doctor, f.patient.id, f.current.id);
  assert.ok(
    !refs(fresh).some((r) => r.startsWith(f.old[1].id)),
    'corrected readings are never evidence',
  );
  assert.equal(fresh.data.historyRefs.length, 2);
});

test('readings the content store cannot vouch for are never evidence, and the proposal says so', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  // diverged: the copy no longer matches the legal record
  [...memory.records.values()].find(
    (r) => r.versions[0].data.value === 62,
  )!.versions[0].data.value = 99;
  // not projected: a reading made after the last projection run
  const late = await f.clinical.create(doctor, f.patient.id, 'observation', {
    encounterId: f.current.id,
    code: '8867-4',
    value: 80,
    unit: '/min',
    effectiveAt: at(6),
  });
  void late;
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  const [o1, , o3] = f.old;
  assert.deepEqual(proposal.data.historyRefs, [`${o3.id}@1`, `${o1.id}@1`]);
  assert.equal(proposal.data.historyContext.complete, false);
  assert.ok(!JSON.stringify(proposal.data.evidence).includes('99 /min'));
});

test('a content-store outage degrades to ledger-only evidence and is recorded', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  memory.failNext = { list: 1000 };
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  assert.deepEqual(proposal.data.historyRefs, []);
  assert.equal(proposal.data.historyContext.complete, false);
  assert.ok(
    proposal.data.historyContext.codes.every((c: { status: string }) => c.status === 'unavailable'),
  );
  assert.ok(refs(proposal).includes(`${f.today.id}@1`), 'the encounter evidence is unaffected');
  assert.ok(!JSON.stringify(proposal.data).includes('Syntetisk Patient'));
});

test('history is off unless configured, even when a query service exists', async (t) => {
  const f = await setup(null);
  t.after(() => f.runtime.stop());
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  assert.equal(proposal.data.historyRefs, undefined);
  assert.equal(proposal.data.historyContext, undefined);
  assert.ok(!refs(proposal).some((r) => f.old.some((o) => r.startsWith(o.id))));
  assert.equal(
    (await f.review.review(doctor, proposal.id, proposal.version, 'accept')).data.status,
    'accepted',
  );
});

test('a change to the current encounter still invalidates the proposal, as before', async (t) => {
  const f = await setup();
  t.after(() => f.runtime.stop());
  const proposal = await f.review.propose(doctor, f.patient.id, f.current.id);
  await f.clinical.create(doctor, f.patient.id, 'observation', {
    encounterId: f.current.id,
    code: '8867-4',
    value: 90,
    unit: '/min',
    effectiveAt: at(6),
  });
  await assert.rejects(
    f.review.review(doctor, proposal.id, proposal.version, 'accept'),
    status(409),
  );
});
