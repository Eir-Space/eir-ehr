import test from 'node:test';
import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';

test('change feed resumes without duplicates and never reveals patient-hidden versions', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  const token = f.runtime.get('identity').issue!(doctor);
  const headers = { authorization: `Bearer ${token}` };
  const path = `/api/patients/${f.patient.id}/changes`;
  const initial = (await app.inject({ url: path, headers })).json();
  assert.equal(initial.entries.length, 2);
  const note = f.clinical.create(doctor, f.patient.id, 'note', {
    text: 'Unreleased draft',
    encounterId: f.encounter.id,
  });
  const next = (await app.inject({ url: path + '?after=' + initial.nextCursor, headers })).json();
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].record.id, note.id);
  assert.equal(
    (await app.inject({ url: path + '?after=' + next.nextCursor, headers })).json().entries.length,
    0,
  );
  const self = f.runtime.get('identity').issue!({
    id: 'self',
    tenant: doctor.tenant,
    role: 'patient',
    patientId: f.patient.id,
  });
  const patientView = (
    await app.inject({ url: path, headers: { authorization: `Bearer ${self}` } })
  ).json();
  assert.equal(patientView.entries.length, 2);
  assert.equal(patientView.nextCursor, next.nextCursor);
  const spec = (await app.inject({ url: '/api/openapi.json', headers })).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(
    spec.paths['/patients/{id}/records/{kind}'].post.requestBody.content['application/json'].schema
      .oneOf.length,
    6,
  );
});
test('online backup produces a restorable consistent clinical snapshot', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-backup-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(dir + '/live.sqlite');
  t.after(() => f.runtime.stop());
  await backup(f.store.db, dir + '/backup.sqlite');
  const restored = new DatabaseSync(dir + '/backup.sqlite', { readOnly: true });
  t.after(() => restored.close());
  assert.equal(restored.prepare('SELECT count(*) AS n FROM entities').get()!.n, 2);
  assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.equal(
    restored.prepare('SELECT count(*) AS n FROM audit').get()!.n,
    f.store.db.prepare('SELECT count(*) AS n FROM audit').get()!.n,
  );
});
