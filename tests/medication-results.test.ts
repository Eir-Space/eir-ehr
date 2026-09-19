import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { fromConfig } from '../packages/runtime.ts';
const fails = (status: number) => (error: any) => error.status === status;
const med = () => ({
  clientId: randomUUID(),
  name: 'Test medicine',
  dosageText: null,
  indication: '',
  source: 'patient',
  sourceDetail: 'Patient interview',
  status: 'active',
});
const orderInput = (encounterId: string) => ({
  clientId: randomUUID(),
  encounterId,
  test: 'Test analysis',
  question: 'Clinical question',
  specimen: 'Plasma',
  assigneeId: doctor.id,
  due: '2027-01-01',
  priority: 'routine',
});
const reportInput = () => ({
  source: 'Test laboratory',
  messageId: randomUUID(),
  collectedAt: '2026-01-01T09:00:00Z',
  reportedAt: '2026-01-01T10:00:00Z',
  results: [
    {
      name: 'Test analyte',
      value: '7,1',
      unit: 'mmol/L',
      reference: 'Source supplied',
      flag: 'critical',
    },
  ],
});
const reviewInput = (reportId: string, taskVersion: number) => ({
  reportId,
  taskVersion,
  assessment: 'Source report checked',
  action: 'Responsible team contacted immediately',
  communication: 'Patient contacted',
  criticalAcknowledged: true,
  disposition: 'completed',
});
test('medication reconciliation snapshots medicines and allergies, rejects stale reviews and preserves history', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const meds = f.runtime.get('medications'),
    input = med();
  const added = await meds.add(doctor, f.patient.id, input);
  assert.equal((await meds.add(doctor, f.patient.id, input)).id, added.id);
  await assert.rejects(
    async () => await meds.add(doctor, f.patient.id, { ...input, name: 'Different' }),
    fails(409),
  );
  const state = await meds.list(doctor, f.patient.id);
  const check = {
    clientId: randomUUID(),
    snapshot: state.snapshot,
    source: 'Patient interview',
    note: 'Dose still unverified',
    confirmed: true,
    noCurrentMedicines: false,
  };
  const review = await meds.reconcile(doctor, f.patient.id, check);
  assert.equal((await meds.reconcile(doctor, f.patient.id, check)).id, review.id);
  assert.equal((await meds.list(doctor, f.patient.id)).current, true);
  const { clientId, ...fields } = input;
  const updated = await meds.update(doctor, added.id, 1, {
    ...fields,
    status: 'on-hold',
    reason: 'Patient reports temporary interruption',
  });
  assert.equal(updated.version, 2);
  await assert.rejects(
    async () => await meds.update(doctor, added.id, 1, { ...fields, reason: 'Stale edit' }),
    fails(409),
  );
  assert.equal((await meds.list(doctor, f.patient.id)).current, false);
  await assert.rejects(
    async () => await meds.reconcile(doctor, f.patient.id, { ...check, clientId: randomUUID() }),
    fails(409),
  );
  const snap = (await meds.list(doctor, f.patient.id)).snapshot;
  await f.clinical.create(doctor, f.patient.id, 'allergy', {
    substance: 'Test',
    reaction: 'Reported reaction',
    criticality: 'unable-to-assess',
  });
  await assert.rejects(
    async () =>
      await meds.reconcile(doctor, f.patient.id, {
        ...check,
        clientId: randomUUID(),
        snapshot: snap,
      }),
    fails(409),
  );
  await meds.reconcile(doctor, f.patient.id, {
    ...check,
    clientId: randomUUID(),
    snapshot: (await meds.list(doctor, f.patient.id)).snapshot,
  });
  assert.equal((await meds.list(doctor, f.patient.id)).review?.data.reviewNumber, 2);
  assert.equal((await f.clinical.history(doctor, added.id))[0].data.status, 'active');
  await assert.rejects(
    async () => await f.clinical.transition(doctor, review.id, 'save', 1, {}),
    fails(422),
  );
});
test('absence of medication entries is unknown until explicitly reconciled; voided entries cannot be restored', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const meds = f.runtime.get('medications');
  assert.equal((await meds.list(doctor, f.patient.id)).current, false);
  const data = {
    clientId: randomUUID(),
    snapshot: [],
    source: 'Interview',
    note: 'No current medicines reported',
    confirmed: true,
    noCurrentMedicines: false,
  };
  await assert.rejects(async () => await meds.reconcile(doctor, f.patient.id, data), fails(422));
  await meds.reconcile(doctor, f.patient.id, { ...data, noCurrentMedicines: true });
  assert.equal((await meds.list(doctor, f.patient.id)).current, true);
  const input = med(),
    r = await meds.add(doctor, f.patient.id, input);
  const { clientId, ...fields } = input;
  await meds.update(doctor, r.id, 1, {
    ...fields,
    status: 'entered-in-error',
    reason: 'Wrong statement',
  });
  await assert.rejects(
    async () => await meds.update(doctor, r.id, 2, { ...fields, reason: 'Restore' }),
    fails(409),
  );
  assert.equal((await meds.list(doctor, f.patient.id)).current, false);
});
test('orders create owned follow-up atomically; source message retries are idempotent and cannot replace content', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const labs = f.runtime.get('laboratories');
  const input = orderInput(f.encounter.id),
    order = await labs.order(doctor, f.patient.id, input);
  assert.equal((await labs.order(doctor, f.patient.id, input)).id, order.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'task')).length, 1);
  const reportData = reportInput(),
    report = await labs.receive(doctor, order.id, 1, reportData);
  assert.equal((await labs.receive(doctor, order.id, 1, reportData)).id, report.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReport')).length, 1);
  await assert.rejects(
    async () =>
      await labs.receive(doctor, order.id, 2, {
        ...reportData,
        results: [{ ...reportData.results[0], value: '8' }],
      }),
    fails(409),
  );
  await assert.rejects(
    async () => await labs.receive(doctor, order.id, 2, reportInput()),
    fails(422),
  );
  const task = (await f.store.list(doctor.tenant, f.patient.id, 'task'))[0];
  assert.equal(task.data.priority, 'urgent');
  for (const action of ['complete', 'cancel', 'reopen', 'reschedule'])
    await assert.rejects(
      async () =>
        await f.clinical.transition(doctor, task.id, action, task.version, {
          resolution: 'Bypass',
        }),
      fails(409),
    );
  await assert.rejects(
    async () => await labs.cancel(doctor, order.id, 2, { reason: 'Hide result' }),
    fails(409),
  );
  await assert.rejects(
    async () =>
      await labs.review(doctor, order.id, 2, {
        ...reviewInput(report.id, task.version),
        criticalAcknowledged: false,
      }),
    fails(422),
  );
  const reviewed = await labs.review(doctor, order.id, 2, reviewInput(report.id, task.version));
  assert.equal(reviewed.data.author, doctor.id);
  assert.equal((await f.store.get(doctor.tenant, task.id))?.data.status, 'completed');
  await assert.rejects(
    async () => await labs.review(doctor, order.id, 2, reviewInput(report.id, task.version)),
    fails(409),
  );
});
test('corrected reports reopen review, preserve previous acknowledgement and reject stale or reassigned reviews', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const labs = f.runtime.get('laboratories'),
    team = f.runtime.get('careTeam');
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  const first = await labs.receive(doctor, order.id, 1, reportInput());
  let task = (await f.store.list(doctor.tenant, f.patient.id, 'task'))[0];
  await labs.review(doctor, order.id, 2, reviewInput(first.id, task.version));
  const corrected = await labs.receive(doctor, order.id, 3, {
    ...reportInput(),
    correctionReason: 'Laboratory corrected value',
  });
  task = (await f.store.get(doctor.tenant, task.id))!;
  assert.equal(task.data.status, 'requested');
  assert.equal(task.data.completedAt, undefined);
  assert.equal(corrected.data.supersedes, first.id);
  await assert.rejects(
    async () => await labs.review(doctor, order.id, 4, reviewInput(first.id, task.version)),
    fails(409),
  );
  const nurse = { ...doctor, id: 'nurse-a' };
  await assert.rejects(
    async () =>
      await team.task(doctor, task.id, 'assign', task.version, {
        assigneeId: nurse.id,
        reason: 'Cover',
      }),
    fails(403),
  );
  await f.runtime
    .get('access')
    .grant(doctor, f.patient.id, nurse.id, 'clinician', '2099-01-01T00:00:00Z');
  const assigned = await team.task(doctor, task.id, 'assign', task.version, {
    assigneeId: nurse.id,
    reason: 'Cover',
  });
  await assert.rejects(
    async () => await labs.review(doctor, order.id, 4, reviewInput(corrected.id, task.version)),
    fails(409),
  );
  await assert.rejects(
    async () => await labs.review(doctor, order.id, 4, reviewInput(corrected.id, assigned.version)),
    fails(403),
  );
  await labs.review(nurse, order.id, 4, reviewInput(corrected.id, assigned.version));
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReview')).length, 2);
  assert.equal((await f.store.get(doctor.tenant, first.id))?.data.status, 'final');
});
test('lab orders validate references/times and cancellation cannot leave orphaned follow-up', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const labs = f.runtime.get('laboratories');
  await assert.rejects(
    async () =>
      await labs.order(doctor, f.patient.id, {
        ...orderInput(f.encounter.id),
        assigneeId: 'unknown',
      }),
    fails(422),
  );
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labOrder')).length, 0);
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  await assert.rejects(
    async () =>
      await labs.receive(doctor, order.id, 1, {
        ...reportInput(),
        collectedAt: '2099-01-01T00:00:00Z',
      }),
    fails(422),
  );
  await assert.rejects(
    async () => await labs.receive(doctor, order.id, 1, { ...reportInput(), results: [] }),
  );
  await labs.cancel(doctor, order.id, 1, { reason: 'No longer needed' });
  assert.equal(
    (await f.store.list(doctor.tenant, f.patient.id, 'task'))[0].data.status,
    'cancelled',
  );
  await assert.rejects(
    async () => await labs.receive(doctor, order.id, 2, reportInput()),
    fails(409),
  );
  const other = await f.clinical.register(doctor, {
    name: 'Other',
    birthDate: '1980-01-01',
    identifier: { type: 'local', value: 'OTHER-2' },
  });
  await assert.rejects(
    async () => await labs.order(doctor, other.id, orderInput(f.encounter.id)),
    fails(409),
  );
});
test('result and review writes roll back together with their tasks; restart preserves reconciled state', async (t) => {
  const dir = mkdtempSync(tmpdir() + '/eir-meds-labs-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(dir + '/ehr.sqlite');
  const labs = f.runtime.get('laboratories'),
    meds = f.runtime.get('medications');
  const medication = await meds.add(doctor, f.patient.id, med());
  await meds.reconcile(doctor, f.patient.id, {
    clientId: randomUUID(),
    snapshot: (await meds.list(doctor, f.patient.id)).snapshot,
    source: 'Patient',
    note: 'Dose to verify',
    confirmed: true,
    noCurrentMedicines: false,
  });
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  f.store.db.exec(
    "CREATE TRIGGER fail_result BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='task.lab-result' BEGIN SELECT RAISE(ABORT,'write failure'); END",
  );
  await assert.rejects(
    async () => await labs.receive(doctor, order.id, 1, reportInput()),
    /write failure/,
  );
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReport')).length, 0);
  assert.equal((await f.store.get(doctor.tenant, order.id))?.version, 1);
  f.store.db.exec('DROP TRIGGER fail_result');
  const report = await labs.receive(doctor, order.id, 1, reportInput());
  const task = (await f.store.list(doctor.tenant, f.patient.id, 'task'))[0];
  f.store.db.exec(
    "CREATE TRIGGER fail_review BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='task.lab-review' BEGIN SELECT RAISE(ABORT,'write failure'); END",
  );
  await assert.rejects(
    async () => await labs.review(doctor, order.id, 2, reviewInput(report.id, task.version)),
    /write failure/,
  );
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReview')).length, 0);
  assert.equal((await f.store.get(doctor.tenant, task.id))?.data.status, 'requested');
  f.store.db.exec('DROP TRIGGER fail_review');
  await labs.review(doctor, order.id, 2, reviewInput(report.id, task.version));
  await f.runtime.stop();
  const reopened = await fromConfig(root + 'eir.config.json', {
    'eir.storage.sqlite': { path: dir + '/ehr.sqlite' },
  });
  t.after(async () => await reopened.runtime.stop());
  assert.equal(
    (await reopened.runtime.get('medications').list(doctor, f.patient.id)).current,
    true,
  );
  assert.equal(
    (await reopened.runtime.get('store').get(doctor.tenant, medication.id))?.data.name,
    'Test medicine',
  );
  assert.equal(
    (await reopened.runtime.get('store').get(doctor.tenant, task.id))?.data.status,
    'completed',
  );
  assert.equal((await reopened.runtime.get('store').verifyAudit()).ok, true);
});
test('workflow APIs enforce identity, tenant and role across chart, history, feed and export', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  const meds = f.runtime.get('medications'),
    labs = f.runtime.get('laboratories');
  const medication = await meds.add(doctor, f.patient.id, med());
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  const report = await labs.receive(doctor, order.id, 1, reportInput());
  const token = async (a: any) => ({
    authorization: `Bearer ${await f.runtime.get('identity').issue!(a)}`,
  });
  const headers = await token(doctor);
  assert.equal(
    (await app.inject({ url: `/api/patients/${f.patient.id}/medications` })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/lab-orders/${order.id}/cancel`,
        headers: await token({ ...doctor, tenant: 'another' }),
        payload: { version: 2, data: { reason: 'Wrong tenant' } },
      })
    ).statusCode,
    404,
  );
  const self = { ...doctor, id: 'self', role: 'patient', patientId: f.patient.id };
  const proxy = { ...doctor, id: 'proxy', role: 'proxy', patientId: f.patient.id };
  await f.runtime
    .get('access')
    .grant(doctor, f.patient.id, proxy.id, 'proxy', '2099-01-01T00:00:00Z');
  for (const actor of [self, proxy]) {
    const auth = await token(actor);
    assert.equal(
      (await app.inject({ url: `/api/patients/${f.patient.id}/medications`, headers: auth }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/patients/${f.patient.id}/lab-orders`,
          headers: auth,
          payload: orderInput(f.encounter.id),
        })
      ).statusCode,
      403,
    );
    const chart = (
      await app.inject({ url: `/api/patients/${f.patient.id}/chart`, headers: auth })
    ).json();
    assert.deepEqual(chart.map((r: any) => r.kind).sort(), ['encounter', 'patient']);
    for (const id of [medication.id, order.id, report.id])
      assert.deepEqual(
        (await app.inject({ url: `/api/records/${id}/history`, headers: auth })).json(),
        [],
      );
    const changes = (
      await app.inject({ url: `/api/patients/${f.patient.id}/changes`, headers: auth })
    ).json();
    assert.deepEqual(changes.entries.map((r: any) => r.record.kind).sort(), [
      'encounter',
      'patient',
    ]);
    const bundle = (
      await app.inject({ url: `/api/patients/${f.patient.id}/export/fhir`, headers: auth })
    ).json();
    assert.equal(bundle.entry.length, 2);
  }
  const spec = (await app.inject({ url: '/api/openapi.json', headers })).json();
  assert.ok(spec.paths['/lab-orders/{id}/review'].post.requestBody);
  const response = await app.inject({
    method: 'POST',
    url: `/api/medications/${medication.id}`,
    headers,
    payload: { version: 1, data: { ...med(), role: 'clinician' } },
  });
  assert.equal(response.statusCode, 422);
  await f.runtime.get('access').block(self as any, f.patient.id, true);
  assert.equal(
    (await app.inject({ url: `/api/patients/${f.patient.id}/medications`, headers })).statusCode,
    403,
  );
});
test('AI evidence includes medication provenance and only latest reports; any clinical change invalidates drafts', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const meds = f.runtime.get('medications'),
    labs = f.runtime.get('laboratories'),
    ai = f.runtime.get('aiReview');
  const input = med(),
    medication = await meds.add(doctor, f.patient.id, input);
  const proposal = await ai.propose(doctor, f.patient.id, f.encounter.id);
  assert.ok(
    proposal.data.evidence.some(
      (e: any) => e.ref === `${medication.id}@1` && e.text.includes('okänd'),
    ),
  );
  const { clientId, ...fields } = input;
  await meds.update(doctor, medication.id, 1, {
    ...fields,
    status: 'stopped',
    reason: 'Reported stopped',
  });
  await assert.rejects(async () => await ai.review(doctor, proposal.id, 1, 'accept'), fails(409));
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  const report = await labs.receive(doctor, order.id, 1, reportInput());
  const before = await ai.propose(doctor, f.patient.id, f.encounter.id);
  const corrected = await labs.receive(doctor, order.id, 2, {
    ...reportInput(),
    correctionReason: 'Corrected source',
  });
  await assert.rejects(async () => await ai.review(doctor, before.id, 1, 'accept'), fails(409));
  const after = await ai.propose(doctor, f.patient.id, f.encounter.id);
  assert.ok(after.data.evidence.some((e: any) => e.ref === `${corrected.id}@1`));
  assert.ok(!after.data.evidence.some((e: any) => e.ref === `${report.id}@1`));
  const bundle = await f.runtime.get('fhir').bundle(doctor, f.patient.id);
  const resources = bundle.entry.map((e: any) => e.resource);
  assert.equal(resources.filter((r: any) => r.resourceType === 'MedicationStatement').length, 1);
  assert.equal(
    resources.filter(
      (r: any) => r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationDispense',
    ).length,
    0,
  );
  const diagnostic = resources.find((r: any) => r.resourceType === 'DiagnosticReport');
  assert.equal(diagnostic.id, corrected.id);
  assert.equal(diagnostic.status, 'corrected');
  assert.equal(diagnostic.contained[0].valueString, '7,1 mmol/L');
  assert.equal(diagnostic.contained[0].interpretation[0].coding[0].code, 'AA');
  assert.equal(diagnostic.result[0].reference, '#' + diagnostic.contained[0].id);
  assert.ok(bundle.entry.some((r: any) => r.fullUrl === diagnostic.basedOn[0].reference));
});

test('concurrent lab corrections retain one current report and reviews acknowledge it only once', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const labs = f.runtime.get('laboratories');
  const order = await labs.order(doctor, f.patient.id, orderInput(f.encounter.id));
  const original = await labs.receive(doctor, order.id, 1, reportInput());
  const corrections = await Promise.allSettled([
    labs.receive(doctor, order.id, 2, { ...reportInput(), correctionReason: 'First correction' }),
    labs.receive(doctor, order.id, 2, {
      ...reportInput(),
      correctionReason: 'Competing correction',
    }),
  ]);
  assert.equal(corrections.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(corrections.find((r) => r.status === 'rejected')?.reason.status, 409);
  const current = await f.store.get(doctor.tenant, order.id);
  assert(current);
  const report = await f.store.get(doctor.tenant, current.data.reportId);
  assert.equal(report?.data.supersedes, original.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReport')).length, 2);
  const task = (await f.store.list(doctor.tenant, f.patient.id, 'task'))[0];
  const reviews = await Promise.allSettled([
    labs.review(
      doctor,
      order.id,
      current.version,
      reviewInput(current.data.reportId, task.version),
    ),
    labs.review(
      doctor,
      order.id,
      current.version,
      reviewInput(current.data.reportId, task.version),
    ),
  ]);
  assert.equal(reviews.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(reviews.find((r) => r.status === 'rejected')?.reason.status, 409);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'labReview')).length, 1);
  assert.equal((await f.store.get(doctor.tenant, task.id))?.data.status, 'completed');
  assert.equal((await f.store.get(doctor.tenant, order.id))?.data.reviewedReportId, report?.id);
});

test('concurrent reconciliations preserve review numbering and allergy changes invalidate their snapshot', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const meds = f.runtime.get('medications');
  await meds.add(doctor, f.patient.id, med());
  const input = {
    snapshot: (await meds.list(doctor, f.patient.id)).snapshot,
    source: 'Patient interview',
    note: 'Concurrent reconciliation',
    confirmed: true,
    noCurrentMedicines: false,
  };
  const reviews = await Promise.all([
    meds.reconcile(doctor, f.patient.id, { ...input, clientId: randomUUID() }),
    meds.reconcile(doctor, f.patient.id, { ...input, clientId: randomUUID() }),
  ]);
  assert.deepEqual(reviews.map((r) => r.data.reviewNumber).sort(), [1, 2]);
  const outcomes = await Promise.allSettled([
    f.clinical.create(doctor, f.patient.id, 'allergy', {
      substance: 'Newly reported substance',
      reaction: 'Patient reported reaction',
      criticality: 'unable-to-assess',
    }),
    meds.reconcile(doctor, f.patient.id, { ...input, clientId: randomUUID() }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  if (outcomes[1].status === 'rejected') assert.equal(outcomes[1].reason.status, 409);
  const state = await meds.list(doctor, f.patient.id);
  assert.equal(state.current, false);
  assert.notDeepEqual(state.snapshot, input.snapshot);
  assert.deepEqual(state.review?.data.snapshot, input.snapshot);
});
