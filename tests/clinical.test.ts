import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, doctor } from './helpers.ts';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
const status = (code: number) => (error: any) => error.status === code;
test('draft/save/sign/immutable/amend lifecycle with optimistic concurrency', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Original',
  });
  const revised = await f.clinical.transition(doctor, note.id, 'save', 1, { text: 'Reviewed' });
  await assert.rejects(
    async () => await f.clinical.transition(doctor, note.id, 'save', 1, { text: 'Lost update' }),
    status(409),
  );
  const signed = await f.clinical.transition(doctor, note.id, 'sign', revised.version, {});
  assert.equal(signed.data.signedBy, doctor.id);
  await assert.rejects(
    async () => await f.clinical.transition(doctor, note.id, 'save', 3, { text: 'Overwrite' }),
    status(409),
  );
  assert.throws(
    () => f.store.db.prepare('UPDATE entities SET data=? WHERE id=?').run('{}', note.id),
    /immutable/,
  );
  const amendment = await f.clinical.transition(doctor, note.id, 'amend', 3, {
    text: 'Correction',
    reason: 'New information',
  });
  assert.equal(amendment.data.amends, note.id);
  assert.equal(amendment.data.status, 'draft');
  assert.equal((await f.store.get(doctor.tenant, note.id))?.data.text, 'Reviewed');
  assert.equal((await f.clinical.history(doctor, note.id)).length, 3);
});
test('encounters require signed notes before close and enforce patient reference integrity', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  await assert.rejects(
    async () => await f.clinical.create(doctor, f.patient.id, 'encounter', { reason: 'Duplicate' }),
    status(409),
  );
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Draft',
  });
  await assert.rejects(
    async () => await f.clinical.transition(doctor, f.encounter.id, 'close', 1, {}),
    status(409),
  );
  await f.clinical.transition(doctor, note.id, 'sign', 1, {});
  await f.clinical.transition(doctor, f.encounter.id, 'close', 1, {});
  await assert.rejects(
    async () =>
      await f.clinical.create(doctor, f.patient.id, 'note', {
        encounterId: f.encounter.id,
        text: 'Late',
      }),
    status(409),
  );
  const other = await f.clinical.register(doctor, {
    name: 'Other',
    birthDate: '1980-01-01',
    identifier: { type: 'local', value: 'TEST-002' },
  });
  await assert.rejects(
    async () =>
      await f.clinical.create(doctor, other.id, 'note', {
        encounterId: f.encounter.id,
        text: 'Wrong patient',
      }),
    status(409),
  );
});
test('quantities enforce code/unit/value contracts and preserve correction history', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const input = {
    encounterId: f.encounter.id,
    code: '8310-5',
    value: 37,
    unit: 'Cel',
    effectiveAt: new Date().toISOString(),
  };
  await assert.rejects(
    async () =>
      await f.clinical.create(doctor, f.patient.id, 'observation', { ...input, unit: 'kg' }),
    status(422),
  );
  const o = await f.clinical.create(doctor, f.patient.id, 'observation', input);
  await f.clinical.transition(doctor, o.id, 'correct', 1, { reason: 'Wrong measurement' });
  assert.equal((await f.store.get(doctor.tenant, o.id))?.data.status, 'entered-in-error');
  assert.equal((await f.clinical.history(doctor, o.id))[0].data.value, 37);
});
test('records and audit survive restart; audit failure rolls back a clinical write', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-test-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = dir + '/ehr.sqlite';
  const f = await fixture(path);
  const before = (await f.store.list(doctor.tenant)).length;
  f.store.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='task.created' BEGIN SELECT RAISE(ABORT,'disk-like failure'); END",
  );
  await assert.rejects(
    async () =>
      await f.clinical.create(doctor, f.patient.id, 'task', {
        title: 'Rollback',
        due: '2027-01-01',
      }),
    /disk-like/,
  );
  assert.equal((await f.store.list(doctor.tenant)).length, before);
  await f.runtime.stop();
  const reopened = new SqliteStore(path);
  t.after(() => reopened.close());
  assert.equal((await reopened.get(doctor.tenant, f.patient.id))?.data.name, 'Syntetisk Patient');
  assert.equal((await reopened.verifyAudit()).ok, true);
  assert.throws(() => reopened.db.exec("UPDATE audit SET hash='tampered'"), /append-only/);
});
test('duplicate identifiers rejected without adding a second patient', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  await assert.rejects(
    async () =>
      await f.clinical.register(doctor, {
        name: 'Duplicate',
        birthDate: '1980-01-01',
        identifier: { type: 'local', value: 'TEST-001' },
      }),
    status(409),
  );
  assert.equal((await f.clinical.patients(doctor)).length, 1);
});

test('concurrent encounter closure and note creation cannot leave a draft in a closed encounter', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const outcomes = await Promise.allSettled([
    f.clinical.transition(doctor, f.encounter.id, 'close', 1, {}),
    f.clinical.create(doctor, f.patient.id, 'note', {
      encounterId: f.encounter.id,
      text: 'Concurrent draft',
    }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((r) => r.status === 'rejected');
  assert.equal(rejected?.reason.status, 409);
  const encounter = await f.store.get(doctor.tenant, f.encounter.id);
  const notes = await f.store.list(doctor.tenant, f.patient.id, 'note');
  assert.equal(notes.length, encounter?.data.status === 'finished' ? 0 : 1);
  assert.equal((await f.store.verifyAudit()).ok, true);
});

test('async access preserves note author restrictions and signature provenance', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const access = f.runtime.get('access');
  const colleague = { ...doctor, id: 'nurse-a' };
  await access.grant(doctor, f.patient.id, colleague.id, 'clinician', '2099-01-01T00:00:00Z');
  access.context = async () => ({
    permissions: ['record.write', 'note.sign'],
    unitId: 'unit-a',
    name: 'Unit A',
  });
  const signer = {
    ...doctor,
    assignmentId: 'assignment-a',
    unitId: 'unit-a',
    authentication: {
      method: 'oidc' as const,
      issuer: 'https://identity.example',
      subject: doctor.id,
      authenticatedAt: 1,
      acr: 'test-mfa',
    },
  };
  const note = await f.clinical.create(signer, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Author-owned draft',
  });
  await assert.rejects(
    () => f.clinical.transition(colleague, note.id, 'save', 1, { text: 'Other author' }),
    status(403),
  );
  await assert.rejects(() => f.clinical.transition(colleague, note.id, 'sign', 1, {}), status(403));
  const signed = await f.clinical.transition(signer, note.id, 'sign', 1, {});
  assert.equal(signed.data.author, doctor.id);
  assert.equal(signed.data.signedBy, doctor.id);
  assert.deepEqual(signed.data.signedUnder, {
    assignmentId: 'assignment-a',
    unitId: 'unit-a',
    authentication: 'oidc',
    acr: 'test-mfa',
  });
  assert.equal((await f.clinical.history(signer, note.id)).length, 2);
});
