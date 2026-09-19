import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
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
    await f.runtime.stop();
  });
  const token = await f.runtime.get('identity').issue!(doctor);
  const headers = { authorization: `Bearer ${token}` };
  const path = `/api/patients/${f.patient.id}/changes`;
  const initial = (await app.inject({ url: path, headers })).json();
  assert.equal(initial.entries.length, 2);
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
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
  const self = await f.runtime.get('identity').issue!({
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

test('clinical read services share authorization, records and audit in one transaction', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const team = f.runtime.get('careTeam');
  const task = await team.createTask(doctor, f.patient.id, {
    title: 'Read scope',
    due: '2026-09-21',
  });
  const context = new AsyncLocalStorage<object>();
  const reads = new Set<object>();
  const checks = new Set<object>();
  const audits = new Set<object>();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn) => transaction(() => context.run(context.getStore() ?? {}, fn));
  const access = f.runtime.get('access');
  const check = access.check.bind(access);
  access.check = async (...args) => {
    await check(...args);
    const scope = context.getStore();
    if (scope) checks.add(scope);
  };
  const list = f.store.list.bind(f.store);
  f.store.list = async (...args) => {
    const scope = context.getStore();
    assert(scope, 'Record lists must be read inside the service transaction');
    reads.add(scope);
    return await list(...args);
  };
  const history = f.store.history.bind(f.store);
  f.store.history = async (...args) => {
    const scope = context.getStore();
    assert(scope, 'History must be read inside the service transaction');
    reads.add(scope);
    return await history(...args);
  };
  const audit = f.store.audit.bind(f.store);
  f.store.audit = async (...args) => {
    const scope = context.getStore();
    if (scope) audits.add(scope);
    await audit(...args);
  };
  const services = [
    () => f.clinical.patients(doctor),
    () => f.clinical.chart(doctor, f.patient.id),
    () => f.clinical.history(doctor, task.id),
    () => f.runtime.get('fhir').bundle(doctor, f.patient.id),
    () => f.runtime.get('medications').list(doctor, f.patient.id),
    () => team.workspace(doctor, '2026-09-21'),
  ];
  for (const read of services) {
    reads.clear();
    checks.clear();
    audits.clear();
    await read();
    assert.equal(reads.size, 1);
    const [scope] = reads;
    assert(checks.has(scope), 'Authorization must use the same transaction as the records');
    assert(audits.has(scope), 'Read audit must use the same transaction as the records');
  }
});

test('read services recheck authorization when access is revoked after preflight', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const access = f.runtime.get('access');
  const check = access.check.bind(access);
  const services = [
    () => f.clinical.chart(doctor, f.patient.id),
    () => f.clinical.history(doctor, f.encounter.id),
    () => f.runtime.get('fhir').bundle(doctor, f.patient.id),
    () => f.runtime.get('medications').list(doctor, f.patient.id),
  ];
  for (const read of services) {
    await f.store.restrict(doctor.tenant, f.patient.id, false);
    let revoke = true;
    access.check = async (...args) => {
      await check(...args);
      if (revoke) {
        revoke = false;
        await f.store.restrict(doctor.tenant, f.patient.id, true);
      }
    };
    await assert.rejects(read, (error: any) => error.status === 403);
  }
});
test('online backup produces a restorable consistent clinical snapshot', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-backup-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(dir + '/live.sqlite');
  t.after(async () => await f.runtime.stop());
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
