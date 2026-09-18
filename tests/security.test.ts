import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
test('care relationship, tenant, role, restriction and proxy expiry all constrain reads', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const access = f.runtime.get('access');
  assert.throws(
    () => f.clinical.chart({ ...doctor, tenant: 'clinic-b' }, f.patient.id),
    /No active/,
  );
  assert.throws(() => f.clinical.chart({ ...doctor, id: 'unassigned' }, f.patient.id), /No active/);
  const proxy = { id: 'guardian', tenant: doctor.tenant, role: 'proxy' as const };
  assert.throws(() => f.clinical.chart(proxy, f.patient.id), /No active/);
  access.grant(doctor, f.patient.id, proxy.id, 'proxy', '2099-01-01T00:00:00Z');
  assert.equal(f.clinical.chart(proxy, f.patient.id).length, 2);
  assert.throws(
    () => f.clinical.create(proxy, f.patient.id, 'task', { title: 'Write', due: '2027-01-01' }),
    /No active/,
  );
  f.store.db
    .prepare('UPDATE grants SET expires=? WHERE actorId=?')
    .run('2000-01-01T00:00:00.000Z', proxy.id);
  assert.throws(() => f.clinical.chart(proxy, f.patient.id), /No active/);
  const self = {
    id: 'patient-login',
    tenant: doctor.tenant,
    role: 'patient' as const,
    patientId: f.patient.id,
  };
  access.block(self, f.patient.id, true);
  assert.throws(() => f.clinical.chart(doctor, f.patient.id), /No active/);
  assert.equal(f.clinical.patients(doctor).length, 0);
  assert.equal(f.clinical.chart(self, f.patient.id).length, 2);
  access.block(self, f.patient.id, false);
  assert.equal(f.clinical.chart(doctor, f.patient.id).length, 2);
  assert.ok(
    f.store.db
      .prepare("SELECT count(*) AS n FROM audit WHERE json_extract(body,'$.outcome')='denied'")
      .get()!.n,
  );
});
test('patients do not see draft notes or AI proposals, including in history/export', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const note = f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Draft',
  });
  await f.runtime.get('aiReview').propose(doctor, f.patient.id, f.encounter.id);
  const self = {
    id: 'self',
    tenant: doctor.tenant,
    role: 'patient' as const,
    patientId: f.patient.id,
  };
  assert.equal(f.clinical.chart(self, f.patient.id).length, 2);
  assert.equal(f.clinical.history(self, note.id).length, 0);
  f.clinical.transition(doctor, note.id, 'sign', 1, {});
  assert.equal(f.clinical.history(self, note.id).length, 1);
});
test('HTTP fails closed, ignores spoofed roles, blocks audit and expires/revokes tokens', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  assert.equal((await app.inject('/api/patients')).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/patients', headers: { 'x-eir-role': 'admin' } })).statusCode,
    401,
  );
  const token = f.runtime.get('identity').issue!(doctor);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ url: '/api/patients', headers })).json().length, 1);
  assert.equal((await app.inject({ url: '/api/audit', headers })).statusCode, 403);
  assert.equal(
    (
      await app.inject({
        url: '/api/patients',
        headers: { ...headers, origin: 'https://evil.example' },
      })
    ).statusCode,
    403,
  );
  const denied = await app.inject({
    method: 'POST',
    url: `/api/patients/${f.patient.id}/records/note`,
    headers,
    payload: { text: 'bad', encounterId: 'nope', status: 'signed' },
  });
  assert.equal(denied.statusCode, 422);
  await app.inject({ method: 'POST', url: '/api/logout', headers, payload: {} });
  assert.equal((await app.inject({ url: '/api/patients', headers })).statusCode, 401);
  const expired = f.runtime.get('identity').issue!(doctor);
  f.store.db.exec("UPDATE sessions SET expires='2000-01-01T00:00:00.000Z'");
  assert.equal(
    (await app.inject({ url: '/api/patients', headers: { authorization: `Bearer ${expired}` } }))
      .statusCode,
    401,
  );
});
