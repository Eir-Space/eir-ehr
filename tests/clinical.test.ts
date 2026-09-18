import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, doctor } from './helpers.ts';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
const status = (code: number) => (error: any) => error.status === code;

test('draft/save/sign/immutable/amend lifecycle with optimistic concurrency', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const note = f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Original',
  });
  const revised = f.clinical.transition(doctor, note.id, 'save', 1, { text: 'Reviewed' });
  assert.throws(
    () => f.clinical.transition(doctor, note.id, 'save', 1, { text: 'Lost update' }),
    status(409),
  );
  const signed = f.clinical.transition(doctor, note.id, 'sign', revised.version, {});
  assert.equal(signed.data.signedBy, doctor.id);
  assert.throws(
    () => f.clinical.transition(doctor, note.id, 'save', 3, { text: 'Overwrite' }),
    status(409),
  );
  assert.throws(
    () => f.store.db.prepare('UPDATE entities SET data=? WHERE id=?').run('{}', note.id),
    /immutable/,
  );
  const amendment = f.clinical.transition(doctor, note.id, 'amend', 3, {
    text: 'Correction',
    reason: 'New information',
  });
  assert.equal(amendment.data.amends, note.id);
  assert.equal(amendment.data.status, 'draft');
  assert.equal(f.store.get(doctor.tenant, note.id)?.data.text, 'Reviewed');
  assert.equal(f.clinical.history(doctor, note.id).length, 3);
});
test('encounters require signed notes before close and enforce patient reference integrity', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  assert.throws(
    () => f.clinical.create(doctor, f.patient.id, 'encounter', { reason: 'Duplicate' }),
    status(409),
  );
  const note = f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Draft',
  });
  assert.throws(() => f.clinical.transition(doctor, f.encounter.id, 'close', 1, {}), status(409));
  f.clinical.transition(doctor, note.id, 'sign', 1, {});
  f.clinical.transition(doctor, f.encounter.id, 'close', 1, {});
  assert.throws(
    () =>
      f.clinical.create(doctor, f.patient.id, 'note', {
        encounterId: f.encounter.id,
        text: 'Late',
      }),
    status(409),
  );
  const other = f.clinical.register(doctor, {
    name: 'Other',
    birthDate: '1980-01-01',
    identifier: { type: 'local', value: 'TEST-002' },
  });
  assert.throws(
    () =>
      f.clinical.create(doctor, other.id, 'note', {
        encounterId: f.encounter.id,
        text: 'Wrong patient',
      }),
    status(409),
  );
});
test('quantities enforce code/unit/value contracts and preserve correction history', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const input = {
    encounterId: f.encounter.id,
    code: '8310-5',
    value: 37,
    unit: 'Cel',
    effectiveAt: new Date().toISOString(),
  };
  assert.throws(
    () => f.clinical.create(doctor, f.patient.id, 'observation', { ...input, unit: 'kg' }),
    status(422),
  );
  const o = f.clinical.create(doctor, f.patient.id, 'observation', input);
  f.clinical.transition(doctor, o.id, 'correct', 1, { reason: 'Wrong measurement' });
  assert.equal(f.store.get(doctor.tenant, o.id)?.data.status, 'entered-in-error');
  assert.equal(f.clinical.history(doctor, o.id)[0].data.value, 37);
});
test('records and audit survive restart; audit failure rolls back a clinical write', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-test-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = dir + '/ehr.sqlite';
  const f = await fixture(path);
  const before = f.store.list(doctor.tenant).length;
  f.store.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='task.created' BEGIN SELECT RAISE(ABORT,'disk-like failure'); END",
  );
  assert.throws(
    () => f.clinical.create(doctor, f.patient.id, 'task', { title: 'Rollback', due: '2027-01-01' }),
    /disk-like/,
  );
  assert.equal(f.store.list(doctor.tenant).length, before);
  f.runtime.stop();
  const reopened = new SqliteStore(path);
  t.after(() => reopened.db.close());
  assert.equal(reopened.get(doctor.tenant, f.patient.id)?.data.name, 'Syntetisk Patient');
  assert.equal(reopened.verifyAudit().ok, true);
  assert.throws(() => reopened.db.exec("UPDATE audit SET hash='tampered'"), /append-only/);
});
test('duplicate identifiers rejected without adding a second patient', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  assert.throws(
    () =>
      f.clinical.register(doctor, {
        name: 'Duplicate',
        birthDate: '1980-01-01',
        identifier: { type: 'local', value: 'TEST-001' },
      }),
    status(409),
  );
  assert.equal(f.clinical.patients(doctor).length, 1);
});
