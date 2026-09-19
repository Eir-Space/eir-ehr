import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor, Entity } from '../packages/contracts.ts';
import { postgresTestOptions } from './postgres-helpers.ts';
import {
  expectStatus,
  failClinicalAudit,
  postgresClinicalFixture,
} from './postgres-clinical-helpers.ts';

const booking = (practitionerId: string) => ({
  practitionerId,
  localStart: '2027-01-11T09:00',
  durationMinutes: 30,
  reason: 'Synthetic follow-up',
  type: 'visit',
});
const medication = () => ({
  clientId: randomUUID(),
  name: 'Synthetic medication statement',
  dosageText: null,
  indication: '',
  source: 'patient',
  sourceDetail: 'Synthetic patient interview',
  status: 'active',
});
const orderInput = (encounterId: string, assigneeId: string) => ({
  clientId: randomUUID(),
  encounterId,
  assigneeId,
  test: 'Synthetic analysis',
  question: 'Synthetic clinical question',
  specimen: 'Plasma',
  due: '2027-01-12',
  priority: 'routine',
});
const reportInput = () => ({
  source: 'Synthetic laboratory',
  messageId: randomUUID(),
  collectedAt: '2026-01-01T09:00:00Z',
  reportedAt: '2026-01-01T10:00:00Z',
  results: [
    {
      name: 'Synthetic analyte',
      value: '7.1',
      unit: 'mmol/L',
      reference: 'Source range',
      flag: 'critical',
    },
  ],
});
const reviewInput = (reportId: string, taskVersion: number) => ({
  reportId,
  taskVersion,
  assessment: 'Synthetic source reviewed',
  action: 'Synthetic follow-up recorded',
  communication: 'Synthetic patient contacted',
  criticalAcknowledged: true,
});

test(
  'postgres HTTP: independent runtimes share staff sessions, own notes, stale CAS and signed lifecycle',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const { http, patient, encounter } = f;
    const doctor = f.actors[0].doctor,
      colleague = f.actors[1].colleague;
    const sessionA = expectStatus(await http<{ actor: Actor }>(0, 'doctor', '/session'));
    const sessionB = expectStatus(await http<{ actor: Actor }>(1, 'doctor', '/session'));
    assert.equal(sessionA.actor.id, doctor.id);
    assert.equal(sessionB.actor.assignmentId, sessionA.actor.assignmentId);
    assert.equal(
      expectStatus(await http<{ actor: Actor }>(1, 'colleague', '/session')).actor.id,
      colleague.id,
    );
    assert.equal((await fetch(f.urls[1] + `/api/patients/${patient.id}/chart`)).status, 401);
    const [doctorNote, colleagueNote] = (
      await Promise.all([
        http(0, 'doctor', `/patients/${patient.id}/records/note`, {
          encounterId: encounter.id,
          clientId: randomUUID(),
          text: 'Doctor draft',
        }),
        http(1, 'colleague', `/patients/${patient.id}/records/note`, {
          encounterId: encounter.id,
          clientId: randomUUID(),
          text: 'Colleague draft',
        }),
      ])
    ).map((response) => expectStatus(response, 201));
    assert.equal(doctorNote.data.author, doctor.id);
    assert.equal(colleagueNote.data.author, colleague.id);
    expectStatus(
      await http(1, 'colleague', `/records/${doctorNote.id}/save`, {
        version: 1,
        data: { text: 'Wrong author' },
      }),
      403,
    );
    expectStatus(
      await http(0, 'doctor', `/records/${colleagueNote.id}/sign`, { version: 1, data: {} }),
      403,
    );

    const saves = await Promise.all([
      http(0, 'doctor', `/records/${doctorNote.id}/save`, {
        version: 1,
        data: { text: 'Session A revision' },
      }),
      http(1, 'doctor', `/records/${doctorNote.id}/save`, {
        version: 1,
        data: { text: 'Session B revision' },
      }),
    ]);
    assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409], JSON.stringify(saves));
    const winner = saves.find((r) => r.status === 200)!.body;
    assert.equal(winner.version, 2);
    const history = expectStatus(
      await http<Entity[]>(1, 'doctor', `/records/${doctorNote.id}/history`),
    );
    assert.deepEqual(
      history.map((r) => r.version),
      [1, 2],
    );
    assert.equal(history[1].data.text, winner.data.text);
    expectStatus(
      await http(0, 'doctor', `/records/${encounter.id}/close`, { version: 1, data: {} }),
      409,
    );
    const signed = expectStatus(
      await http(1, 'doctor', `/records/${doctorNote.id}/sign`, { version: 2, data: {} }),
    );
    assert.equal(signed.data.signedBy, doctor.id);
    assert.deepEqual(signed.data.signedUnder, {
      assignmentId: doctor.assignmentId,
      unitId: doctor.unitId,
      authentication: 'local',
      acr: null,
    });
    expectStatus(
      await http(0, 'doctor', `/records/${doctorNote.id}/save`, {
        version: signed.version,
        data: { text: 'Overwrite signature' },
      }),
      409,
    );
    expectStatus(
      await http(1, 'colleague', `/records/${colleagueNote.id}/sign`, { version: 1, data: {} }),
    );
    const closed = expectStatus(
      await http(0, 'doctor', `/records/${encounter.id}/close`, { version: 1, data: {} }),
    );
    assert.equal(closed.data.status, 'finished');
    const chart = expectStatus(
      await http<Entity[]>(1, 'colleague', `/patients/${patient.id}/chart`),
    );
    assert.equal(chart.filter((r) => r.kind === 'note' && r.data.status === 'signed').length, 2);
    const bundle = expectStatus(
      await http<{ entry: { resource: { resourceType: string; docStatus?: string } }[] }>(
        0,
        'doctor',
        `/patients/${patient.id}/export/fhir`,
      ),
    );
    assert.equal(
      bundle.entry.filter(
        (r) => r.resource.resourceType === 'DocumentReference' && r.resource.docStatus === 'final',
      ).length,
      2,
    );
    assert.equal((await f.runtimes[1].get('store').verifyAudit()).ok, true);
  },
);

test(
  'postgres HTTP: concurrent overlapping appointments admit one booking across runtimes',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const input = booking(f.actors[0].doctor.id);
    const responses = await Promise.all([
      f.http(0, 'doctor', `/patients/${f.patient.id}/appointments`, input),
      f.http(1, 'colleague', `/patients/${f.patient.id}/appointments`, input),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409], JSON.stringify(responses));
    const first = responses.find((r) => r.status === 201)!.body;
    assert.equal(first.data.startsAt, '2027-01-11T08:00:00Z');
    const workspace = expectStatus(
      await f.http<{ appointments: Entity[] }>(1, 'colleague', '/care-team?day=2027-01-11'),
    );
    assert.deepEqual(
      workspace.appointments.map((r) => r.id),
      [first.id],
    );
    expectStatus(
      await f.http(1, 'colleague', `/patients/${f.patient.id}/appointments`, {
        ...input,
        localStart: '2027-01-11T09:30',
      }),
      201,
    );
    assert.equal(
      (await f.runtimes[0].get('store').list(f.configA.tenant, f.patient.id, 'appointment')).length,
      2,
    );
    assert.equal((await f.runtimes[1].get('store').verifyAudit()).ok, true);
  },
);

test(
  'postgres HTTP: duplicate concurrent lab deliveries return one report and update follow-up once',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const { http, patient, encounter } = f;
    const order = expectStatus(
      await http(
        0,
        'doctor',
        `/patients/${patient.id}/lab-orders`,
        orderInput(encounter.id, f.actors[1].colleague.id),
      ),
      201,
    );
    const data = reportInput();
    const reports = (
      await Promise.all([
        http(0, 'doctor', `/lab-orders/${order.id}/receive`, { version: 1, data }),
        http(1, 'colleague', `/lab-orders/${order.id}/receive`, { version: 1, data }),
      ])
    ).map((response) => expectStatus(response));
    assert.equal(reports[0].id, reports[1].id);
    const store = f.runtimes[1].get('store');
    const storedReports = await store.list(f.configA.tenant, patient.id, 'labReport');
    const tasks = await store.list(f.configA.tenant, patient.id, 'task');
    assert.equal(storedReports.length, 1);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].version, 2);
    assert.equal(tasks[0].data.reportId, reports[0].id);
    assert.equal(tasks[0].data.priority, 'urgent');
    assert.equal((await store.get(f.configA.tenant, order.id))?.version, 2);
    expectStatus(
      await http(0, 'doctor', `/lab-orders/${order.id}/receive`, {
        version: 2,
        data: { ...data, results: [{ ...data.results[0], value: 'Changed' }] },
      }),
      409,
    );
    expectStatus(
      await http(0, 'doctor', `/lab-orders/${order.id}/review`, {
        version: 2,
        data: reviewInput(reports[0].id, tasks[0].version),
      }),
      403,
    );
    expectStatus(
      await http(1, 'colleague', `/lab-orders/${order.id}/review`, {
        version: 2,
        data: reviewInput(reports[0].id, tasks[0].version),
      }),
    );
    assert.equal((await store.get(f.configA.tenant, tasks[0].id))?.data.status, 'completed');
    const audits = await store.auditEntries(f.configA.tenant, patient.id);
    assert.equal(audits.filter((r) => r.action === 'labReport.created').length, 1);
    assert.equal(audits.filter((r) => r.action === 'task.lab-result').length, 1);
    assert.equal((await store.verifyAudit()).ok, true);
  },
);

test(
  'postgres HTTP: medication and allergy changes across replicas reject stale reconciliation',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const { http, patient } = f;
    const input = medication();
    const added = expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/medications`, input),
      201,
    );
    type MedicationState = { snapshot: string[]; current: boolean; review: Entity | null };
    const before = expectStatus(
      await http<MedicationState>(1, 'colleague', `/patients/${patient.id}/medications`),
    );
    const review = {
      clientId: randomUUID(),
      snapshot: before.snapshot,
      source: 'Synthetic interview',
      note: 'Reconciled synthetic statement',
      confirmed: true,
      noCurrentMedicines: false,
    };
    const { clientId, ...fields } = input;
    expectStatus(
      await http(0, 'doctor', `/medications/${added.id}`, {
        version: 1,
        data: { ...fields, status: 'on-hold', reason: 'Synthetic temporary interruption' },
      }),
    );
    expectStatus(
      await http(1, 'colleague', `/patients/${patient.id}/medication-reviews`, review),
      409,
    );
    assert.equal(
      (await f.runtimes[0].get('store').list(f.configA.tenant, patient.id, 'medicationReview'))
        .length,
      0,
    );
    const updated = expectStatus(
      await http<MedicationState>(1, 'colleague', `/patients/${patient.id}/medications`),
    );
    expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/records/allergy`, {
        substance: 'Synthetic substance',
        reaction: 'Synthetic reaction',
        criticality: 'unable-to-assess',
      }),
      201,
    );
    expectStatus(
      await http(1, 'colleague', `/patients/${patient.id}/medication-reviews`, {
        ...review,
        snapshot: updated.snapshot,
      }),
      409,
    );
    const current = expectStatus(
      await http<MedicationState>(1, 'colleague', `/patients/${patient.id}/medications`),
    );
    expectStatus(
      await http(1, 'colleague', `/patients/${patient.id}/medication-reviews`, {
        ...review,
        snapshot: current.snapshot,
      }),
      201,
    );
    const reconciled = expectStatus(
      await http<MedicationState>(0, 'doctor', `/patients/${patient.id}/medications`),
    );
    assert.equal(reconciled.current, true);
    assert.deepEqual(reconciled.review?.data.snapshot, current.snapshot);
    assert.equal(reconciled.review?.data.author, f.actors[1].colleague.id);
    assert.equal((await f.runtimes[0].get('store').verifyAudit()).ok, true);
  },
);

test(
  'postgres HTTP: lab lifecycle failures roll back orders, reports, reviews and linked task versions',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const { http, patient, encounter, admin } = f;
    const store = f.runtimes[1].get('store');
    const input = orderInput(encounter.id, f.actors[0].doctor.id);
    await failClinicalAudit(admin, 'task.created');
    const failedOrder = await http(0, 'doctor', `/patients/${patient.id}/lab-orders`, input);
    expectStatus(failedOrder, 503);
    assert.doesNotMatch(JSON.stringify(failedOrder.body), /synthetic-clinical-failure/);
    assert.deepEqual(await store.list(f.configA.tenant, patient.id, 'labOrder'), []);
    assert.deepEqual(await store.list(f.configA.tenant, patient.id, 'task'), []);
    await admin.query('DROP TRIGGER zz_clinical_audit_failure ON eir.audit');
    const order = expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/lab-orders`, input),
      201,
    );
    const task = (await store.list(f.configA.tenant, patient.id, 'task'))[0];

    await failClinicalAudit(admin, 'task.lab-result');
    const reportData = reportInput();
    expectStatus(
      await http(1, 'colleague', `/lab-orders/${order.id}/receive`, {
        version: 1,
        data: reportData,
      }),
      503,
    );
    assert.deepEqual(await store.list(f.configA.tenant, patient.id, 'labReport'), []);
    assert.deepEqual(await store.get(f.configA.tenant, order.id), order);
    assert.deepEqual(await store.get(f.configA.tenant, task.id), task);
    assert.equal((await store.history(f.configA.tenant, order.id)).length, 1);
    await admin.query('DROP TRIGGER zz_clinical_audit_failure ON eir.audit');
    const report = expectStatus(
      await http(1, 'colleague', `/lab-orders/${order.id}/receive`, {
        version: 1,
        data: reportData,
      }),
    );
    const receivedOrder = await store.get(f.configA.tenant, order.id);
    const receivedTask = await store.get(f.configA.tenant, task.id);
    assert(receivedTask);
    await failClinicalAudit(admin, 'task.lab-review');
    expectStatus(
      await http(0, 'doctor', `/lab-orders/${order.id}/review`, {
        version: 2,
        data: reviewInput(report.id, receivedTask.version),
      }),
      503,
    );
    assert.deepEqual(await store.list(f.configA.tenant, patient.id, 'labReview'), []);
    assert.deepEqual(await store.get(f.configA.tenant, order.id), receivedOrder);
    assert.deepEqual(await store.get(f.configA.tenant, task.id), receivedTask);
    assert.equal((await store.history(f.configA.tenant, order.id)).length, 2);
    assert.equal((await store.history(f.configA.tenant, task.id)).length, 2);
    const failedAudits = await store.auditEntries(f.configA.tenant, patient.id);
    assert.equal(
      failedAudits.filter((r) => r.action === 'labReview.created' || r.action === 'labOrder.review')
        .length,
      0,
    );
    await admin.query('DROP TRIGGER zz_clinical_audit_failure ON eir.audit');
    expectStatus(
      await http(0, 'doctor', `/lab-orders/${order.id}/review`, {
        version: 2,
        data: reviewInput(report.id, receivedTask.version),
      }),
    );
    assert.equal((await store.get(f.configA.tenant, task.id))?.data.status, 'completed');
    assert.equal((await store.verifyAudit()).ok, true);
  },
);

test(
  'postgres HTTP: encounter completion publishes no partial state when booking audit fails',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    t.after(f.cleanup);
    const { http, patient, encounter, admin } = f;
    const appointment = expectStatus(
      await http(
        0,
        'doctor',
        `/patients/${patient.id}/appointments`,
        booking(f.actors[0].doctor.id),
      ),
      201,
    );
    const started = expectStatus(
      await http(0, 'doctor', `/appointments/${appointment.id}/start`, { version: 1, data: {} }),
    );
    assert.equal(started.data.encounterId, encounter.id);
    const note = expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/records/note`, {
        encounterId: encounter.id,
        text: 'Synthetic completed visit',
      }),
      201,
    );
    expectStatus(await http(0, 'doctor', `/records/${note.id}/sign`, { version: 1, data: {} }));
    const feed = expectStatus(
      await http<{ nextCursor: number }>(1, 'colleague', `/patients/${patient.id}/changes`),
    );
    await failClinicalAudit(admin, 'appointment.completed');
    expectStatus(
      await http(0, 'doctor', `/records/${encounter.id}/close`, { version: 1, data: {} }),
      503,
    );
    const store = f.runtimes[1].get('store');
    assert.deepEqual(await store.get(f.configA.tenant, encounter.id), encounter);
    assert.deepEqual(await store.get(f.configA.tenant, appointment.id), started);
    assert.equal((await store.history(f.configA.tenant, encounter.id)).length, 1);
    const unchanged = expectStatus(
      await http<{ entries: unknown[] }>(
        1,
        'colleague',
        `/patients/${patient.id}/changes?after=${feed.nextCursor}`,
      ),
    );
    assert.deepEqual(unchanged.entries, []);
    await admin.query('DROP TRIGGER zz_clinical_audit_failure ON eir.audit');
    expectStatus(
      await http(1, 'doctor', `/records/${encounter.id}/close`, { version: 1, data: {} }),
    );
    const changed = expectStatus(
      await http<{ entries: { record: Entity }[] }>(
        0,
        'doctor',
        `/patients/${patient.id}/changes?after=${feed.nextCursor}`,
      ),
    );
    assert.deepEqual(
      changed.entries.map((r) => [r.record.kind, r.record.data.status]),
      [
        ['encounter', 'finished'],
        ['appointment', 'completed'],
      ],
    );
    assert.equal((await store.verifyAudit()).ok, true);
  },
);
