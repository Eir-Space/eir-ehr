import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { integrationFixture } from './integration-helpers.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { Runtime } from '../packages/runtime.ts';
import paymentPlugin from '../plugins/coordination-payment.ts';
import type { Actor } from '../packages/contracts.ts';
import { followUpFixture } from './follow-up-helpers.ts';

async function fixture(pg = false) {
  const f = await integrationFixture(pg, {}, 0, (tenant) => ({
    'eir.workforce': demoWorkforce(tenant, true),
    'eir.deterioration': { worker: false },
  }));
  const runtime = f.runtimes[0],
    workforce = runtime.get('workforce');
  const actors = (await workforce.forIdentity('https://local.eir.invalid', 'emma'))
    .filter((a) => a.data.role === 'clinician')
    .map((a) => workforce.actor(a));
  for (const actor of actors)
    await runtime.get('modules').set(actor, 'coordination', {
      enabled: true,
      version: 0,
      reason: 'Synthetic coordination test',
    });
  const hospital = actors.find((a) => a.unitId === 'demo-hospital')!,
    municipality = actors.find((a) => a.unitId === 'demo-municipality')!;
  const service = runtime.get('coordination');
  const row = await service.create(f.doctor, {
    patientId: f.patient.id,
    title: 'Samordnad hemgång',
    pathway: 'inpatient',
    participants: [hospital.unitId, municipality.unitId],
  });
  const units = actors.map((a) => a.unitId!);
  const consent = async (granted = true) => {
    const record = (await runtime.get('store').get(f.tenant, row.id))!;
    return service.consent(f.doctor, row.id, {
      version: record.version,
      granted,
      unitIds: units,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      note: 'Patientens uttryckliga samtycke dokumenterat',
    });
  };
  const send = async (actor: Actor, type: string, other: Record<string, unknown> = {}) => {
    const record = (await runtime.get('store').get(f.tenant, row.id))!;
    return service.send(actor, row.id, {
      version: record.version,
      type,
      body: 'Synthetic clinical coordination content',
      recipients: units.filter((u) => u !== actor.unitId),
      ...(type === 'admission'
        ? { expectedDischargeAt: new Date(Date.now() + 86400000).toISOString() }
        : {}),
      ...other,
    });
  };
  const action = async (actor: Actor, data: Record<string, unknown>) => {
    const record = (await runtime.get('store').get(f.tenant, row.id))!;
    return service.action(actor, row.id, { ...data, version: record.version });
  };
  return { ...f, runtime, service, row, hospital, municipality, units, consent, send, action };
}
test('case sharing is consented, unit scoped and never grants underlying chart access', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await assert.rejects(f.service.detail(f.hospital, f.row.id), /consent/);
  assert.equal((await f.service.workspace(f.hospital)).items.length, 0);
  await f.consent();
  assert.equal((await f.service.workspace(f.hospital)).items.length, 1);
  assert.equal((await f.api(f.hospital, `/patients/${f.patient.id}/chart`)).status, 403);
  await assert.rejects(f.service.detail({ ...f.hospital, tenant: 'foreign' }, f.row.id));
  const message = await f.send(f.doctor, 'care-request', { recipients: [f.hospital.unitId] });
  const municipal = await f.service.detail(f.municipality, f.row.id);
  assert.equal(municipal.messages.length, 0);
  assert.equal(
    JSON.stringify(municipal).includes('Synthetic clinical coordination content'),
    false,
  );
  const hospital = await f.service.detail(f.hospital, f.row.id);
  assert.equal(hospital.messages[0].id, message.id);
  await assert.rejects(f.service.receipt(f.doctor, message.id, 1), /recipient/);
  await f.service.receipt(f.hospital, message.id, hospital.receipts[0].version);
  await assert.rejects(f.service.receipt(f.hospital, message.id, 1), /already/);
  assert.equal((await f.service.workspace(f.hospital)).items[0].unread, 0);
  const chart = await f.runtime.get('clinical').chart(f.doctor, f.patient.id);
  assert(!chart.some((r) => r.kind.startsWith('sam')));
});
test('withdrawal, expiry, protected records and read-only membership block further sharing', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  await f.action(f.doctor, {
    action: 'participant',
    unitId: f.hospital.unitId,
    active: true,
    readOnly: true,
    reason: 'Read-only participation',
  });
  await assert.rejects(f.send(f.hospital, 'admission'), /read-only/);
  assert.ok(await f.service.detail(f.hospital, f.row.id));
  await f.runtime.get('modules').set(f.doctor, 'coordination', {
    enabled: false,
    version: 1,
    reason: 'Module maintenance window',
  });
  await f.consent(false);
  await assert.rejects(f.service.detail(f.hospital, f.row.id), /consent/);
  await f.runtime.get('modules').set(f.doctor, 'coordination', {
    enabled: true,
    version: 2,
    reason: 'Module maintenance finished',
  });
  await f.consent();
  const store = f.runtime.get('store');
  const expired = (await store.get(f.tenant, f.row.id))!;
  await store.revise(
    f.doctor,
    expired,
    expired.version,
    {
      ...expired.data,
      consent: { ...expired.data.consent, validUntil: '2020-01-01T00:00:00.000Z' },
    },
    'test.expired-consent',
  );
  await assert.rejects(f.service.detail(f.hospital, f.row.id), /consent/);
  await f.consent();
  const patient = (await store.get(f.tenant, f.patient.id))!;
  const protectedPatient = await store.revise(
    f.doctor,
    patient,
    patient.version,
    { ...patient.data, protectedIdentity: true },
    'test.protected',
  );
  await assert.rejects(f.service.detail(f.hospital, f.row.id), /restricted/);
  await store.revise(
    f.doctor,
    protectedPatient,
    protectedPatient.version,
    patient.data,
    'test.unprotected',
  );
  await f.runtime.get('store').restrict(f.tenant, f.patient.id, true);
  await assert.rejects(f.service.detail(f.hospital, f.row.id), /restricted/);
  assert.equal((await f.service.workspace(f.hospital)).items.length, 0);
});
test('discharge workflow enforces sender, sequence, readiness and auditable retraction', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  await assert.rejects(f.send(f.doctor, 'admission'), /hospital/);
  await assert.rejects(f.send(f.hospital, 'discharge-ready'), /admitted/);
  const admission = await f.send(f.hospital, 'admission');
  const ready = await f.send(f.hospital, 'discharge-ready');
  await assert.rejects(
    f.service.voidMessage(f.hospital, admission.id, admission.version, 'Incorrect earlier event'),
    /later/,
  );
  await assert.rejects(f.send(f.hospital, 'discharge'), /Confirm/);
  await f.action(f.doctor, { action: 'contact', name: 'Emma Sjöberg, primärvård' });
  await f.action(f.doctor, {
    action: 'availability',
    available: true,
    reason: 'Insatserna är planerade och tillgängliga',
  });
  const discharge = await f.send(f.hospital, 'discharge');
  assert.equal((await f.service.detail(f.doctor, f.row.id)).record.data.phase, 'discharged');
  await f.service.voidMessage(
    f.hospital,
    discharge.id,
    discharge.version,
    'Felregistrerad utskrivning',
  );
  assert.equal((await f.service.detail(f.doctor, f.row.id)).record.data.phase, 'ready');
  await f.service.voidMessage(f.hospital, ready.id, ready.version, 'Behöver fortsatt slutenvård');
  assert.equal((await f.service.detail(f.doctor, f.row.id)).record.data.phase, 'admitted');
  assert.equal((await f.runtime.get('store').history(f.tenant, discharge.id)).length, 2);
  assert.equal((await f.runtime.get('store').verifyAudit()).ok, true);
});
test('SIP is structured, confirmed by each contributor and revision bound', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  await f.action(f.doctor, { action: 'contact', name: 'Emma Sjöberg' });
  const sip = f.runtime.get('sipPlans');
  const fields = {
    patientPriorities: 'Kunna bo hemma',
    participation: 'Patienten deltog och godkände målen',
    meetingAt: new Date(Date.now() + 86400000).toISOString(),
    location: 'Digitalt möte',
    followUpOn: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    participants: [{ name: 'Test patient', role: 'patient' }],
    goals: [
      {
        need: 'Stöd i hemmet',
        goal: 'Trygg hemgång',
        intervention: 'Planerat hembesök',
        responsibleUnitId: f.municipality.unitId,
        dueOn: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        status: 'planned',
        followUp: '',
      },
    ],
  };
  let plan = await sip.save(f.doctor, f.row.id, {
    version: 0,
    fields,
    reason: 'Gemensam planering',
  });
  plan = await sip.action(f.doctor, f.row.id, {
    version: plan.version,
    action: 'invite',
    reason: 'Kallelse med aktuellt underlag',
  });
  await assert.rejects(
    sip.action(f.doctor, f.row.id, {
      version: plan.version,
      action: 'finalize',
      reason: 'Attempt before confirmations',
    }),
    /Every/,
  );
  await assert.rejects(
    sip.save(f.doctor, f.row.id, {
      version: plan.version,
      fields,
      reason: 'Cannot silently change invited plan',
    }),
    /Reopen/,
  );
  for (const actor of [f.doctor, f.hospital, f.municipality])
    plan = await sip.action(actor, f.row.id, {
      version: plan.version,
      action: 'accept',
      reason: 'Enhetens ansvar bekräftat',
    });
  plan = await sip.action(f.doctor, f.row.id, {
    version: plan.version,
    action: 'finalize',
    reason: 'Samtliga parter överens',
  });
  assert.equal(plan.data.status, 'agreed');
  const approvedVersion = plan.version;
  plan = await sip.action(f.doctor, f.row.id, {
    version: plan.version,
    action: 'reopen',
    reason: 'Ny uppföljningsomgång',
  });
  assert.deepEqual(plan.data.confirmations, {});
  assert(
    (await f.runtime.get('store').history(f.tenant, plan.id)).some(
      (r) => r.version === approvedVersion && r.data.status === 'agreed',
    ),
  );
  await f.action(f.doctor, {
    action: 'participant',
    unitId: f.hospital.unitId,
    active: true,
    readOnly: true,
    reason: 'Observer participation only',
  });
  const revised = (await sip.get(f.doctor, f.row.id))!;
  assert.equal(revised.data.status, 'draft');
  assert.deepEqual(revised.data.confirmations, {});
  await assert.rejects(
    f.action(f.doctor, {
      action: 'participant',
      unitId: f.municipality.unitId,
      active: false,
      readOnly: false,
      reason: 'Cannot remove accountable party',
    }),
    /responsibilities/,
  );
});

test('inbox exports are permission checked, spreadsheet-safe and audited', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  const store = f.runtime.get('store'),
    row = (await store.get(f.tenant, f.row.id))!;
  await store.revise(
    f.doctor,
    row,
    row.version,
    { ...row.data, title: '=DANGEROUS()' },
    'test.formula',
  );
  const report = await f.service.report(f.doctor);
  assert.match(Buffer.from(report.base64, 'base64').toString(), /'=DANGEROUS\(\)/);
  const assignment = (await store.get(f.tenant, f.doctor.assignmentId!))!;
  await store.revise(
    f.doctor,
    assignment,
    assignment.version,
    {
      ...assignment.data,
      permissions: assignment.data.permissions.filter((p: string) => p !== 'coordination.export'),
    },
    'test.revoke-export',
  );
  await assert.rejects(f.service.report(f.doctor));
  assert.equal((await f.api(f.doctor, '/coordination/report')).status, 403);
  assert((await store.verifyAudit()).ok);
});

test('PDF uploads default to quarantine and never masquerade as scanned documents', async (t) => {
  const f = await integrationFixture(false, {}, 0, (tenant) => ({
    'eir.workforce': demoWorkforce(tenant, true),
    'eir.coordination.documents': { developmentPdfDownloads: false },
  }));
  t.after(f.cleanup);
  const runtime = f.runtimes[0];
  await runtime
    .get('modules')
    .set(f.doctor, 'coordination', { enabled: true, version: 0, reason: 'Test document workflow' });
  const service = runtime.get('coordination');
  let row = await service.create(f.doctor, {
    patientId: f.patient.id,
    title: 'Dokumentprov',
    pathway: 'outpatient',
    participants: ['demo-hospital'],
  });
  row = await service.consent(f.doctor, row.id, {
    version: row.version,
    granted: true,
    unitIds: ['demo-primary-care', 'demo-hospital'],
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    note: 'Samtycke till dokumentdelning',
  });
  const doc = await PDFDocument.create();
  doc.addPage();
  const file = await runtime.get('coordinationDocuments').upload(f.doctor, row.id, {
    name: 'underlag.pdf',
    contentType: 'application/pdf',
    base64: Buffer.from(await doc.save()).toString('base64'),
  });
  assert.equal(file.data.state, 'quarantined');
  await assert.rejects(
    runtime.get('coordinationDocuments').download(f.doctor, file.id),
    /quarantined/,
  );
});

for (const pg of [false, true])
  test(
    `${pg ? 'PostgreSQL' : 'SQLite'} coordination notifications: verified HTTP delivery, retry identity, withdrawal and concurrent claim`,
    { skip: pg && !process.env.EIR_TEST_POSTGRES_URL },
    async (t) => {
      const f = await followUpFixture(pg, 0, false, (tenant) => ({
        'eir.workforce': demoWorkforce(tenant, true),
        'eir.deterioration': { worker: false },
        'eir.coordination.directory': {
          units: [
            {
              unitId: 'demo-primary-care',
              organisationId: 'primary',
              organisationName: 'Primary',
              kind: 'primary-care',
            },
            {
              unitId: 'demo-hospital',
              organisationId: 'hospital',
              organisationName: 'Hospital',
              kind: 'hospital',
              notificationRecipient: 'opaque-hospital-inbox',
            },
          ],
        },
      }));
      t.after(f.cleanup);
      const runtime = f.runtimes[0],
        service = runtime.get('coordination'),
        store = runtime.get('store');
      await runtime.get('modules').set(f.doctor, 'coordination', {
        enabled: true,
        version: 0,
        reason: 'Enable notification testing',
      });
      let row = await service.create(f.doctor, {
        patientId: f.patient.id,
        title: 'Hemgång',
        pathway: 'outpatient',
        participants: ['demo-hospital'],
      });
      const scope = {
        granted: true,
        unitIds: ['demo-primary-care', 'demo-hospital'],
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        note: 'Samtycke till planering',
      };
      row = await service.consent(f.doctor, row.id, { ...scope, version: row.version });
      const send = async () => {
        row = (await store.get(f.tenant, row.id))!;
        return service.send(f.doctor, row.id, {
          version: row.version,
          type: 'planning',
          body: 'Secret clinical content',
          recipients: ['demo-hospital'],
        });
      };
      await send();
      f.behavior.mode = 'lose-ack';
      await runtime.get('coordinationNotifications').runOnce();
      let notification = (await f.rows('samNotification'))[0];
      assert.equal(notification.data.status, 'pending');
      assert.equal(f.messages.size, 1);
      await store.revise(
        f.doctor,
        notification,
        notification.version,
        { ...notification.data, availableAt: '2020-01-01T00:00:00.000Z' },
        'test.retry-due',
      );
      f.behavior.mode = 'accept';
      await Promise.all(f.runtimes.map((r) => r.get('coordinationNotifications').runOnce()));
      notification = (await f.rows('samNotification'))[0];
      assert.equal(notification.data.status, 'delivered');
      assert.equal(f.messages.size, 1);
      assert.equal(f.attempts.length, 2);
      assert.equal(f.attempts[0].messageId, f.attempts[1].messageId);
      assert(!JSON.stringify(f.attempts).includes('Anna'));
      assert(!JSON.stringify(f.attempts).includes('Secret clinical content'));
      await send();
      row = (await store.get(f.tenant, row.id))!;
      await service.consent(f.doctor, row.id, { ...scope, version: row.version, granted: false });
      await runtime.get('coordinationNotifications').runOnce();
      assert.equal(f.attempts.length, 2);
      assert((await f.rows('samNotification')).some((r) => r.data.status === 'cancelled'));
    },
  );
test('attachments, PDF exports and download authorization use real persisted bytes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  const documents = f.runtime.get('coordinationDocuments');
  const content = Buffer.from('Syntetiskt planeringsunderlag');
  const file = await documents.upload(f.doctor, f.row.id, {
    name: 'underlag.txt',
    contentType: 'text/plain',
    base64: content.toString('base64'),
  });
  assert.equal(
    (await documents.download(f.hospital, file.id)).bytes.toString(),
    content.toString(),
  );
  const pdf = await documents.export(f.doctor, f.row.id);
  assert.equal(Buffer.from(pdf.bytes).subarray(0, 5).toString(), '%PDF-');
  assert((await PDFDocument.load(pdf.bytes)).getPageCount() > 0);
  await assert.rejects(
    documents.upload(f.doctor, f.row.id, {
      name: '../evil.pdf',
      contentType: 'application/pdf',
      base64: content.toString('base64'),
    }),
  );
  await assert.rejects(
    documents.upload(f.doctor, f.row.id, {
      name: 'invalid.pdf',
      contentType: 'application/pdf',
      base64: content.toString('base64'),
    }),
  );
  await f.consent(false);
  await assert.rejects(documents.download(f.hospital, file.id));
});
test('message, receipts, notifications and timeline roll back together', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.consent();
  const store = f.runtime.get('store'),
    original = store.insert.bind(store);
  store.insert = async (...args) => {
    const row = await original(...args);
    if (args[1] === 'samNotification') throw new Error('Injected failure');
    return row;
  };
  await assert.rejects(f.send(f.doctor, 'administrative'), /Injected/);
  store.insert = original;
  assert.equal((await f.rows('samMessage')).length, 0);
  assert.equal((await f.rows('samReceipt')).length, 0);
  assert.equal((await f.rows('samNotification')).length, 0);
});
test('payment provider handles noon boundary, DST, prerequisites and unconfigured rates', async (t) => {
  const runtime = await new Runtime().start([
    { plugin: paymentPlugin, config: { version: 'test-contract', dailyRateOre: 500000 } },
  ]);
  t.after(() => runtime.stop());
  const calculate = runtime.get('coordinationPayment').calculate;
  const facts = {
    admissionAt: '2026-10-20T10:00:00Z',
    readyAt: '2026-10-23T10:00:00Z',
    asOf: '2026-10-29T12:00:00Z',
    sipRequired: false,
    outpatientAvailable: true,
    interrupted: false,
  };
  assert.equal(calculate(facts).startOn, '2026-10-26');
  assert.equal(calculate({ ...facts, readyAt: '2026-10-23T10:00:01Z' }).startOn, '2026-10-27');
  assert.equal(calculate(facts).days, 3);
  assert.equal(calculate({ ...facts, outpatientAvailable: false }).status, 'blocked');
  assert.equal(calculate({ ...facts, sipRequired: true }).status, 'blocked');
  const unconfigured = await new Runtime().start([{ plugin: paymentPlugin }]);
  t.after(() => unconfigured.stop());
  assert.equal(unconfigured.get('coordinationPayment').calculate(facts).status, 'blocked');
});
test(
  'PostgreSQL concurrent message send cannot duplicate a case transition and survives restart',
  { skip: !process.env.EIR_TEST_POSTGRES_URL },
  async (t) => {
    const f = await fixture(true);
    t.after(f.cleanup);
    await f.consent();
    const row = (await f.runtime.get('store').get(f.tenant, f.row.id))!;
    const input = {
      version: row.version,
      type: 'admission',
      body: 'Inskriven för fortsatt vård',
      recipients: [f.doctor.unitId, f.municipality.unitId],
      expectedDischargeAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const results = await Promise.allSettled(
      f.runtimes.map((r) => r.get('coordination').send(f.hospital, row.id, input)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await f.rows('samMessage')).length, 1);
    assert.equal((await f.rows('samReceipt')).length, 2);
    await f.restart(0);
    assert.equal(
      (await f.runtimes[0].get('coordination').detail(f.doctor, row.id)).record.data.phase,
      'admitted',
    );
  },
);
