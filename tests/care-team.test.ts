import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
const status = (code: number) => (error: any) => error.status === code;
const booking = {
  practitionerId: doctor.id,
  localStart: '2026-09-21T09:00',
  durationMinutes: 30,
  reason: 'Uppföljning',
  type: 'visit',
};
const nurse = { ...doctor, id: 'nurse-a' };
test('appointments reject provider/patient overlaps, allow adjacent slots, reschedule and retain versions', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const team = f.runtime.get('careTeam');
  await f.runtime
    .get('access')
    .grant(doctor, f.patient.id, nurse.id, 'clinician', '2099-01-01T00:00:00Z');
  const a = await team.book(doctor, f.patient.id, booking);
  assert.equal(a.data.startsAt, '2026-09-21T07:00:00Z');
  await assert.rejects(async () => await team.book(doctor, f.patient.id, booking), status(409));
  await assert.rejects(
    async () => await team.book(doctor, f.patient.id, { ...booking, practitionerId: nurse.id }),
    status(409),
  );
  const p = await f.clinical.register(doctor, {
    name: 'Other patient',
    birthDate: '2000-01-01',
    identifier: { type: 'local', value: 'OTHER' },
  });
  await assert.rejects(async () => await team.book(doctor, p.id, booking), status(409));
  await team.book(doctor, p.id, { ...booking, localStart: '2026-09-21T09:30' });
  const moved = await team.appointment(doctor, a.id, 'reschedule', a.version, {
    ...booking,
    localStart: '2026-09-21T11:00',
  });
  await assert.rejects(
    async () => await team.appointment(doctor, a.id, 'arrive', a.version, {}),
    status(409),
  );
  const cancelled = await team.appointment(doctor, a.id, 'cancel', moved.version, {
    reason: 'Patienten bokar om senare',
  });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal((await f.clinical.history(doctor, a.id)).length, 3);
  await assert.rejects(
    async () => await team.appointment(doctor, a.id, 'start', cancelled.version, {}),
    status(409),
  );
  await team.book(doctor, f.patient.id, { ...booking, localStart: '2026-09-21T11:00' });
});
test('clinic time is independent of server/browser zone and rejects invalid/ambiguous daylight-saving times', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const team = f.runtime.get('careTeam');
  for (const localStart of ['2026-03-29T02:30', '2026-10-25T02:30', '2026-02-30T10:00']) {
    await assert.rejects(
      async () => await team.book(doctor, f.patient.id, { ...booking, localStart }),
      status(422),
    );
  }
  const winter = await team.book(doctor, f.patient.id, {
    ...booking,
    localStart: '2026-12-01T09:00',
  });
  assert.equal(winter.data.startsAt, '2026-12-01T08:00:00Z');
  const overnight = await team.book(doctor, f.patient.id, {
    ...booking,
    localStart: '2026-09-21T23:50',
  });
  assert(
    (await team.workspace(doctor, '2026-09-22')).appointments.some((r) => r.id === overnight.id),
  );
  await assert.rejects(async () => await team.appointment(doctor, winter.id, 'no-show', 1, {}));
});
test('check-in/start links an encounter; signing and closing completes the booking atomically', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const team = f.runtime.get('careTeam');
  const a = await team.book(doctor, f.patient.id, booking);
  const arrived = await team.appointment(doctor, a.id, 'arrive', 1, {});
  const started = await team.appointment(doctor, a.id, 'start', arrived.version, {});
  assert.equal(started.data.encounterId, f.encounter.id);
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Anteckning',
  });
  await assert.rejects(
    async () => await f.clinical.transition(doctor, f.encounter.id, 'close', 1, {}),
    status(409),
  );
  assert.equal((await f.store.get(doctor.tenant, a.id))?.data.status, 'in-progress');
  await f.clinical.transition(doctor, note.id, 'sign', 1, {});
  await f.clinical.transition(doctor, f.encounter.id, 'close', 1, {});
  assert.equal((await f.store.get(doctor.tenant, a.id))?.data.status, 'completed');
  const b = await team.book(doctor, f.patient.id, { ...booking, localStart: '2026-09-22T09:00' });
  const next = await team.appointment(doctor, b.id, 'start', 1, {});
  assert.notEqual(next.data.encounterId, f.encounter.id);
  assert.equal(
    (await f.store.get(doctor.tenant, next.data.encounterId))?.data.status,
    'in-progress',
  );
});
test('task handover requires a known colleague with active access; only current owner completes', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const row = await f.clinical.create(doctor, f.patient.id, 'task', {
    title: 'Ring patienten',
    due: '2026-09-20',
  });
  assert.equal(row.data.assigneeId, doctor.id);
  await assert.rejects(
    async () =>
      await f.clinical.transition(doctor, row.id, 'assign', 1, {
        assigneeId: nurse.id,
        reason: 'Överlämning',
      }),
    status(403),
  );
  await assert.rejects(
    async () =>
      await f.clinical.transition(doctor, row.id, 'assign', 1, {
        assigneeId: 'doctor-b',
        reason: 'Överlämning',
      }),
    status(422),
  );
  await f.runtime
    .get('access')
    .grant(doctor, f.patient.id, nurse.id, 'clinician', '2099-01-01T00:00:00Z');
  const assigned = await f.clinical.transition(doctor, row.id, 'assign', 1, {
    assigneeId: nurse.id,
    reason: 'Frånvarotäckning',
  });
  await assert.rejects(
    async () => await f.clinical.transition(doctor, row.id, 'complete', assigned.version, {}),
    status(403),
  );
  const started = await f.clinical.transition(nurse, row.id, 'start', assigned.version, {});
  const done = await f.clinical.transition(nurse, row.id, 'complete', started.version, {
    resolution: 'Patienten kontaktad',
  });
  assert.equal(done.data.completedBy, nurse.id);
  await assert.rejects(
    async () => await f.clinical.transition(nurse, row.id, 'complete', started.version, {}),
    status(409),
  );
  const reopened = await f.clinical.transition(doctor, row.id, 'reopen', done.version, {
    reason: 'Ny uppföljning behövs',
  });
  assert.equal(reopened.data.status, 'requested');
  assert.equal(reopened.data.completedBy, undefined);
  const moved = await f.clinical.transition(doctor, row.id, 'reschedule', reopened.version, {
    due: '2026-09-22',
    reason: 'Överenskommet',
  });
  assert.equal(moved.data.due, '2026-09-22');
  assert.equal((await f.clinical.history(doctor, row.id)).length, 6);
});
test('workspace, patient chart/history/change feed cannot disclose internal work or other tenants', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  const team = f.runtime.get('careTeam');
  const a = await team.book(doctor, f.patient.id, booking);
  const task = await team.createTask(doctor, f.patient.id, {
    title: 'Internal follow-up',
    due: '2026-09-21',
  });
  assert.equal((await team.workspace(doctor, '2026-09-21')).appointments.length, 1);
  assert.equal(
    (await team.workspace({ ...doctor, id: 'unassigned' }, '2026-09-21')).tasks.length,
    0,
  );
  assert.equal(
    (await team.workspace({ ...doctor, tenant: 'other' }, '2026-09-21')).appointments.length,
    0,
  );
  const self = {
    id: 'self',
    tenant: doctor.tenant,
    role: 'patient' as const,
    patientId: f.patient.id,
  };
  await assert.rejects(async () => await team.workspace(self, '2026-09-21'), status(403));
  assert.equal((await f.clinical.history(self, task.id)).length, 0);
  assert(
    !(await f.clinical.chart(self, f.patient.id)).some((r) => r.id === a.id || r.id === task.id),
  );
  const token = await f.runtime.get('identity').issue!(self);
  const response = await app.inject({
    url: `/api/patients/${f.patient.id}/changes`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert(
    !response.json().entries.some((r: any) => ['task', 'appointment'].includes(r.record.kind)),
  );
  await f.runtime.get('access').block(self, f.patient.id, true);
  assert.equal((await team.workspace(doctor, '2026-09-21')).appointments.length, 0);
  await assert.rejects(
    async () => await team.appointment(doctor, a.id, 'arrive', 1, {}),
    status(403),
  );
  assert((await f.store.auditEntries(doctor.tenant)).some((r) => r.outcome === 'denied'));
});
test('draft retry is idempotent and never overwrites another version or signed text', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const input = { encounterId: f.encounter.id, clientId: randomUUID(), text: 'Recovered draft' };
  const note = await f.clinical.create(doctor, f.patient.id, 'note', input);
  assert.equal((await f.clinical.create(doctor, f.patient.id, 'note', input)).id, note.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'note')).length, 1);
  await assert.rejects(
    async () => await f.clinical.create(doctor, f.patient.id, 'note', { ...input, text: 'Other' }),
    status(409),
  );
  await f.clinical.transition(doctor, note.id, 'sign', 1, {});
  await assert.rejects(
    async () => await f.clinical.create(doctor, f.patient.id, 'note', input),
    status(409),
  );
});
test('booking/task/draft state survives restart and encounter completion rolls back on audit failure', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-team-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = dir + '/ehr.sqlite';
  const f = await fixture(path);
  const team = f.runtime.get('careTeam');
  const a = await team.book(doctor, f.patient.id, booking);
  await team.appointment(doctor, a.id, 'start', 1, {});
  f.store.db.exec(
    "CREATE TRIGGER fail_booking_audit BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='appointment.completed' BEGIN SELECT RAISE(ABORT,'audit failure'); END",
  );
  await assert.rejects(
    async () => await f.clinical.transition(doctor, f.encounter.id, 'close', 1, {}),
    /audit failure/,
  );
  assert.equal((await f.store.get(doctor.tenant, f.encounter.id))?.data.status, 'in-progress');
  const task = await team.createTask(doctor, f.patient.id, {
    title: 'Persistent task',
    due: '2026-09-21',
  });
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Server-side draft',
  });
  await f.runtime.stop();
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal((await store.get(doctor.tenant, a.id))?.data.status, 'in-progress');
  assert.equal((await store.get(doctor.tenant, task.id))?.data.assigneeId, doctor.id);
  assert.equal((await store.get(doctor.tenant, note.id))?.data.text, 'Server-side draft');
  assert((await store.verifyAudit()).ok);
});

test('concurrent bookings and appointment starts preserve overlap and encounter ownership', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const team = f.runtime.get('careTeam');
  const bookings = await Promise.allSettled([
    team.book(doctor, f.patient.id, booking),
    team.book(doctor, f.patient.id, booking),
  ]);
  assert.equal(bookings.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(bookings.find((r) => r.status === 'rejected')?.reason.status, 409);
  const first = (await f.store.list(doctor.tenant, f.patient.id, 'appointment'))[0];
  const second = await team.book(doctor, f.patient.id, {
    ...booking,
    localStart: '2026-09-22T09:00',
  });
  const starts = await Promise.allSettled([
    team.appointment(doctor, first.id, 'start', 1, {}),
    team.appointment(doctor, second.id, 'start', 1, {}),
  ]);
  assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(starts.find((r) => r.status === 'rejected')?.reason.status, 409);
  const active = (await f.store.list(doctor.tenant, f.patient.id, 'appointment')).filter(
    (r) => r.data.status === 'in-progress',
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].data.encounterId, f.encounter.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'encounter')).length, 1);
});
