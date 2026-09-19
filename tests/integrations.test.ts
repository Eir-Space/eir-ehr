import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { integrationFixture, sampleReport } from './integration-helpers.ts';
import { postgresTestOptions } from './postgres-helpers.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
import type { Actor } from '../packages/contracts.ts';
import { httpLabTransport } from '../plugins/lab-transport-http.ts';
import { canonical, payloadHash } from '../packages/integrations.ts';

const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const setup = async (
  t: { after: (fn: () => Promise<void>) => void },
  pg = false,
  settings = {},
) => {
  const f = await integrationFixture(pg, settings);
  t.after(f.cleanup);
  return f;
};
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
async function failAudit(f: Fixture, action: string) {
  assert.match(action, /^[a-zA-Z.-]+$/);
  if (f.database) {
    await f.database.admin
      .query(`CREATE FUNCTION eir.fail_integration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.body::jsonb->>'action' = '${action}' THEN RAISE EXCEPTION 'private-failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER zz_integration_failure BEFORE INSERT ON eir.audit FOR EACH ROW EXECUTE FUNCTION eir.fail_integration_audit();`);
    return async () => {
      await f.database!.admin.query(
        'DROP TRIGGER zz_integration_failure ON eir.audit; DROP FUNCTION eir.fail_integration_audit();',
      );
    };
  }
  const db = (f.runtimes[0].get('store') as SqliteStore).db;
  db.exec(
    `CREATE TRIGGER integration_failure BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='${action}' BEGIN SELECT RAISE(ABORT,'private-failure'); END;`,
  );
  return async () => {
    db.exec('DROP TRIGGER integration_failure');
  };
}

for (const pg of [false, true]) {
  const options = pg ? postgresTestOptions : {};
  const name = pg ? 'PostgreSQL replicas' : 'SQLite restart';
  await test(
    `${name}: real HTTP order, durable receipt, exactly-once clinical effect and owned critical review`,
    options,
    async (t) => {
      const f = await setup(t, pg);
      const api = await f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, f.orderInput());
      assert.equal(api.status, 201, JSON.stringify(api.body));
      const order = api.body;
      assert.equal((await f.rows('task')).length, 1);
      const outgoing = (await f.rows('integrationOutbox'))[0];
      assert.equal(outgoing.data.state, 'pending');
      assert.equal((await f.orders()).length, 0);
      if (pg) await Promise.all(f.runtimes.map((r) => r.get('integrations').runOnce()));
      else await f.runtimes[0].get('integrations').runOnce();
      assert.equal(f.requests(), 1);
      assert.equal((await f.rows('integrationOutbox'))[0].data.state, 'acknowledged');
      const message = f.result(order);
      const first = await f.receive(message);
      assert.equal(first.status, 202);
      assert.equal(first.body.status, 'received');
      assert.equal((await f.rows('labReport')).length, 0);
      await f.restart(0);
      assert.deepEqual((await f.receive(message, pg ? 1 : 0)).body, first.body);
      if (pg) await Promise.all(f.runtimes.map((r) => r.get('integrations').runOnce()));
      else await f.runtimes[0].get('integrations').runOnce();
      const reports = await f.rows('labReport');
      assert.equal(reports.length, 1);
      assert.equal(reports[0].data.author, 'connector:test-lab');
      assert.equal(reports[0].data.inboxId, first.body.receiptId);
      const task = (await f.rows('task'))[0];
      assert.equal(task.data.assigneeId, f.doctor.id);
      assert.equal(task.data.priority, 'urgent');
      const latest = await f.runtimes[0].get('store').get(f.tenant, order.id);
      assert.equal(latest?.data.status, 'received');
      const review = {
        reportId: reports[0].id,
        taskVersion: task.version,
        assessment: 'Source reviewed',
        action: 'Responsible team contacted',
        communication: 'Contact recorded',
        criticalAcknowledged: false,
        disposition: 'completed',
      };
      assert.equal(
        (
          await f.api(f.doctor, `/lab-orders/${order.id}/review`, {
            version: latest!.version,
            data: review,
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await f.api(f.doctor, `/lab-orders/${order.id}/review`, {
            version: latest!.version,
            data: { ...review, criticalAcknowledged: true },
          })
        ).status,
        200,
      );
      assert.equal((await f.rows('task'))[0].data.status, 'completed');
      await f.receive(message);
      await f.runtimes[0].get('integrations').runOnce();
      assert.equal((await f.rows('labReport')).length, 1);
      assert.equal((await f.rows('task'))[0].data.status, 'completed');
      assert((await f.runtimes[0].get('store').verifyAudit()).ok);
      const machineAudit = (await f.runtimes[0].get('store').auditEntries(f.tenant)).find(
        (r) => r.action === 'labReport.created',
      );
      assert.equal(machineAudit?.role, 'integration');
      assert.equal(machineAudit?.authentication, 'machine');
    },
  );

  await test(
    `${name}: order/outbox/task and report/inbox/task roll back with failed audit writes`,
    options,
    async (t) => {
      const f = await setup(t, pg);
      const repairOrder = await failAudit(f, 'integrationOutbox.created');
      const input = f.orderInput();
      assert.equal(
        (await f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, input)).status,
        pg ? 503 : 500,
      );
      for (const kind of ['labOrder', 'integrationOutbox', 'task'])
        assert.equal((await f.rows(kind)).length, 0);
      await repairOrder();
      const saved = await f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, input);
      assert.equal(saved.status, 201);
      assert.equal(
        (await f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, input, pg ? 1 : 0)).body.id,
        saved.body.id,
      );
      await f.runtimes[0].get('integrations').runOnce();
      const message = f.result(saved.body);
      await f.receive(message);
      const repairResult = await failAudit(f, 'task.lab-result');
      await f.runtimes[0].get('integrations').runOnce();
      assert.equal((await f.rows('labReport')).length, 0);
      assert.equal((await f.rows('labOrder'))[0].data.status, 'requested');
      assert.equal((await f.rows('task'))[0].version, 1);
      assert.equal((await f.rows('integrationInbox'))[0].data.state, 'retry');
      await repairResult();
      await f.restart(0);
      await pause();
      await f.runtimes[0].get('integrations').runOnce();
      assert.equal((await f.rows('labReport')).length, 1);
      assert.equal((await f.rows('integrationInbox'))[0].data.state, 'applied');
    },
  );

  await test(
    `${name}: crash after remote acceptance leaves a recoverable lease and stable idempotency key`,
    options,
    async (t) => {
      const f = await setup(t, pg);
      const order = await f.runtimes[0]
        .get('integrations')
        .order(f.doctor, f.patient.id, f.orderInput());
      const repair = await failAudit(f, 'integration.delivery-acknowledged');
      await assert.rejects(f.runtimes[0].get('integrations').runOnce());
      assert.equal((await f.orders()).length, 1);
      const leased = (await f.rows('integrationOutbox'))[0];
      assert.equal(leased.data.state, 'sending');
      await repair();
      await f.restart(0);
      await f.runtimes[0].get('integrations').runOnce();
      assert.equal(f.requests(), 1);
      await pause(Math.max(0, Date.parse(leased.data.availableAt) - Date.now()) + 25);
      await f.runtimes[pg ? 1 : 0].get('integrations').runOnce();
      assert.equal(f.requests(), 2);
      assert.equal((await f.orders()).length, 1);
      assert.equal((await f.orders())[0].orderId, order.id);
      assert.equal((await f.rows('integrationOutbox'))[0].data.state, 'acknowledged');
      assert.equal((await f.rows('integrationOutbox'))[0].data.attempts, 2);
    },
  );
}

await test('corrections arriving before their predecessor defer, preserve history and reopen the same review owner', async (t) => {
  const f = await setup(t);
  const service = f.runtimes[0].get('integrations');
  const order = await service.order(f.doctor, f.patient.id, f.orderInput());
  await service.runOnce();
  const first = f.result(order),
    corrected = f.result(order, {
      supersedesMessageId: first.messageId,
      report: {
        ...sampleReport(),
        correctionReason: 'Corrected by laboratory',
        results: [{ ...sampleReport().results[0], value: '7.2' }],
      },
    });
  await f.receive(corrected);
  await service.runOnce();
  assert.equal((await f.rows('integrationInbox'))[0].data.code, 'predecessor_pending');
  assert.equal((await f.rows('labReport')).length, 0);
  await f.receive(first);
  // Retry scheduling can select the deferred correction once before the first report.
  for (let i = 0; i < 3 && !(await f.rows('labReport')).length; i++) await service.runOnce();
  const initial = (await f.rows('labReport'))[0];
  assert(initial);
  const task = (await f.rows('task'))[0],
    latest = (await f.rows('labOrder'))[0];
  await f.runtimes[0].get('laboratories').review(f.doctor, order.id, latest.version, {
    reportId: initial.id,
    taskVersion: task.version,
    assessment: 'Reviewed',
    action: 'Follow-up arranged',
    communication: 'Patient contacted',
    criticalAcknowledged: true,
  });
  const queued = (await f.rows('integrationInbox')).find(
    (r) => r.data.messageId === corrected.messageId,
  )!;
  await service.replay(f.admin, queued.id, {
    version: queued.version,
    reason: 'Previous report is now applied',
  });
  await service.runOnce();
  const finalOrder = (await f.rows('labOrder'))[0];
  const finalReport = (await f.rows('labReport')).find((r) => r.id === finalOrder.data.reportId)!;
  assert.equal(finalReport.data.supersedes, initial.id);
  assert.equal(finalReport.data.correctionReason, corrected.report.correctionReason);
  assert.equal((await f.rows('task'))[0].data.status, 'requested');
  assert.equal((await f.rows('task'))[0].data.assigneeId, task.data.assigneeId);
  assert.equal((await f.rows('labReview')).length, 1);
  const fork = f.result(order, {
    supersedesMessageId: first.messageId,
    report: { ...sampleReport(), correctionReason: 'Stale correction' },
  });
  await f.receive(fork);
  await service.runOnce();
  assert.equal(
    (await f.rows('integrationInbox')).find((r) => r.data.messageId === fork.messageId)!.data.code,
    'correction_conflict',
  );
  assert.equal((await f.rows('labReport')).length, 2);
});

await test('wrong-patient results, reused message IDs, malformed receipts and machine tokens never gain chart access', async (t) => {
  const f = await setup(t),
    service = f.runtimes[0].get('integrations');
  const order = await service.order(f.doctor, f.patient.id, f.orderInput());
  await service.runOnce();
  const message = f.result(order, { patientId: randomUUID() });
  assert.equal((await f.receive(message, 0, f.outbound)).status, 401);
  assert.equal((await f.receive(message)).status, 202);
  await service.runOnce();
  const quarantined = (await f.rows('integrationInbox'))[0];
  assert.equal(quarantined.data.state, 'quarantined');
  assert.equal((await f.rows('labReport')).length, 0);
  assert.equal((await f.receive({ ...message, patientId: f.patient.id })).status, 409);
  assert.equal((await f.rows('integrationInbox')).length, 1);
  assert.equal(
    (await f.runtimes[0].get('store').auditEntries(f.tenant)).filter(
      (r) => r.action === 'integration.message-id-collision',
    ).length,
    1,
  );
  const badIdentifier = f.result(order, {
    patientIdentifier: { system: f.patient.data.identifier.system, value: 'WRONG' },
  });
  await f.receive(badIdentifier);
  await service.runOnce();
  assert.equal(
    (await f.rows('integrationInbox')).find((r) => r.data.messageId === badIdentifier.messageId)!
      .data.code,
    'identifier_mismatch',
  );
  assert.equal((await f.rows('labReport')).length, 0);
  const clinicianToken = await f.runtimes[0].get('identity').issue!(f.doctor);
  assert.equal((await f.receive(f.result(order), 0, clinicianToken)).status, 401);
  assert.equal(
    (await fetch(f.urls[0] + '/api/session', { headers: { authorization: `Bearer ${f.inbound}` } }))
      .status,
    401,
  );
  assert.equal((await f.api(f.doctor, '/integrations')).status, 403);
  assert.equal((await f.api(f.admin, `/patients/${f.patient.id}/chart`)).status, 403);
  const chart = await f.api(f.doctor, `/patients/${f.patient.id}/chart`);
  assert(!chart.body.some((r: any) => r.kind.startsWith('integration')));
  const internal = (await f.rows('integrationOutbox'))[0];
  assert.deepEqual((await f.api(f.doctor, `/records/${internal.id}/history`)).body, []);
  const changes = await f.api(f.doctor, `/patients/${f.patient.id}/changes`);
  assert(!changes.body.entries.some((r: any) => r.record.kind.startsWith('integration')));
  const operations = await f.api(f.admin, '/integrations?direction=inbox');
  assert.equal(operations.status, 200);
  const json = JSON.stringify(operations.body);
  for (const privateValue of [f.inbound, f.outbound, 'Anna Lindberg', 'INTEGRATION-001', '7.1'])
    assert(!json.includes(privateValue));
  const identity = {
    id: 'connector:test-lab',
    tenant: f.tenant,
    unitId: f.doctor.unitId,
    role: 'integration',
  } as Actor;
  await assert.rejects(f.runtimes[0].get('access').permit(identity, 'chart.read', f.patient.id));
  await assert.rejects(
    service.replay(f.admin, quarantined.id, { version: quarantined.version, reason: 'x' }),
  );
});

await test('lost acknowledgements retry; malformed acknowledgements quarantine; operator replay is audited and versioned', async (t) => {
  const f = await setup(t),
    service = f.runtimes[0].get('integrations');
  await service.order(f.doctor, f.patient.id, f.orderInput());
  f.behavior.mode = 'lose-ack';
  await service.runOnce();
  assert.equal((await f.rows('integrationOutbox'))[0].data.state, 'retry');
  assert.equal((await f.orders()).length, 1);
  await pause();
  f.behavior.mode = 'wrong-ack';
  await service.runOnce();
  const failed = (await f.rows('integrationOutbox'))[0];
  assert.equal(failed.data.state, 'quarantined');
  assert.equal(failed.data.code, 'invalid_acknowledgement');
  assert.equal(
    (
      await f.api(f.doctor, `/integrations/${failed.id}/replay`, {
        version: failed.version,
        reason: 'Partner fixed acknowledgement',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(f.admin, `/integrations/${failed.id}/replay`, {
        version: 1,
        reason: 'Partner fixed acknowledgement',
      })
    ).status,
    409,
  );
  await service.replay(f.admin, failed.id, {
    version: failed.version,
    reason: 'Partner fixed acknowledgement',
  });
  f.behavior.mode = 'accept';
  await service.runOnce();
  const accepted = (await f.rows('integrationOutbox'))[0];
  assert.equal(accepted.data.state, 'acknowledged');
  assert.equal(accepted.data.attempts, 3);
  await assert.rejects(
    service.replay(f.admin, failed.id, {
      version: accepted.version,
      reason: 'Must not resend accepted message',
    }),
  );
  assert.equal((await f.orders()).length, 1);
  const history = await f.runtimes[0].get('store').history(f.tenant, failed.id);
  assert(history.some((r) => r.data.replayReason === 'Partner fixed acknowledgement'));
  assert.equal(new Set(history.map((r) => r.data.payloadHash)).size, 1);
});

await test('pause, restrictions and owner revocation fail closed without discarding durable work', async (t) => {
  const f = await setup(t),
    service = f.runtimes[0].get('integrations');
  const order = await service.order(f.doctor, f.patient.id, f.orderInput());
  let c = (await service.operations(f.admin, {})).connectors[0];
  await service.connection(f.admin, c.recordId, {
    version: c.version,
    enabled: false,
    reason: 'Investigating connection issues',
  });
  await service.runOnce();
  assert.equal(f.requests(), 0);
  assert.equal((await f.receive(f.result(order))).status, 403);
  await assert.rejects(service.order(f.doctor, f.patient.id, f.orderInput()));
  c = (await service.operations(f.admin, {})).connectors[0];
  await service.connection(f.admin, c.recordId, {
    version: c.version,
    enabled: true,
    reason: 'Connection verified by operator',
  });
  await service.runOnce();
  assert.equal(f.requests(), 1);
  const first = f.result(order);
  await f.receive(first);
  await f.runtimes[0].get('store').restrict(f.tenant, f.patient.id, true);
  await service.runOnce();
  assert.equal((await f.rows('labReport')).length, 0);
  assert.equal((await f.rows('integrationInbox'))[0].data.code, 'patient_restricted');
  await f.runtimes[0].get('store').restrict(f.tenant, f.patient.id, false);
  const assignment = await f.runtimes[0].get('workforce').current(f.doctor);
  const operatorAssignment = await f.runtimes[0].get('workforce').create(f.admin, {
    actorId: 'operator',
    name: 'Test Operator',
    subject: 'operator',
    issuer: 'https://local.eir.invalid',
    unitId: f.admin.unitId,
    role: 'administrator',
    permissions: ['workforce.manage'],
    enabled: true,
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
  });
  const operator = f.runtimes[0].get('workforce').actor(operatorAssignment);
  await f.runtimes[0].get('workforce').update(operator, assignment.id, assignment.version, {
    enabled: false,
    permissions: assignment.data.permissions,
    validUntil: assignment.data.validUntil,
    reason: 'End of clinical assignment',
  });
  const row = (await f.rows('integrationInbox'))[0];
  await service.replay(f.admin, row.id, {
    version: row.version,
    reason: 'Patient access restriction resolved',
  });
  await service.runOnce();
  assert.equal((await f.rows('integrationInbox'))[0].data.code, 'review_owner_inactive');
  assert.equal((await f.rows('labReport')).length, 0);
});

await test('delivery retry exhaustion, rejected orders and bounded acknowledgements never report success', async (t) => {
  const f = await setup(t, false, { maxAttempts: 2 }),
    service = f.runtimes[0].get('integrations');
  await service.order(f.doctor, f.patient.id, f.orderInput());
  f.behavior.mode = 'unavailable';
  await service.runOnce();
  await pause();
  await service.runOnce();
  const failed = (await f.rows('integrationOutbox'))[0];
  assert.equal(failed.data.state, 'quarantined');
  assert.equal(failed.data.code, 'http_503');
  await pause();
  await service.runOnce();
  assert.equal(f.requests(), 2);
  assert(!JSON.stringify(failed).includes('private-partner-details'));
  f.behavior.mode = 'reject';
  const rejected = await service.order(f.doctor, f.patient.id, f.orderInput());
  await service.runOnce();
  const rejection = (await f.rows('integrationOutbox')).find(
    (r) => r.data.orderId === rejected.id,
  )!;
  assert.equal(rejection.data.state, 'rejected');
  await f.receive(f.result(rejected));
  await service.runOnce();
  assert.equal((await f.rows('integrationInbox'))[0].data.state, 'quarantined');
  assert.equal((await f.rows('labReport')).length, 0);
  f.behavior.mode = 'oversized';
  const oversize = await service.order(f.doctor, f.patient.id, f.orderInput());
  await service.runOnce();
  assert.equal(
    (await f.rows('integrationOutbox')).find((r) => r.data.orderId === oversize.id)!.data.code,
    'invalid_acknowledgement',
  );
});

await test('transport rejects insecure destinations, credentials in URLs and content-key instability', async (t) => {
  const f = await setup(t);
  for (const endpoint of [
    'http://partner.example/orders',
    'https://user:secret@partner.example/orders',
    'https://partner.example/orders?token=secret',
  ])
    assert.throws(() =>
      httpLabTransport.validate({ ...f.connector, localDevelopmentOnly: false, endpoint }),
    );
  assert.throws(() =>
    httpLabTransport.validate({ ...f.connector, endpoint: 'http://localhost/orders' }),
  );
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(payloadHash({ b: 1, a: 2 }), payloadHash({ a: 2, b: 1 }));
});

await test(
  'PostgreSQL: concurrent duplicate orders/results and forked corrections preserve one clinical effect',
  postgresTestOptions,
  async (t) => {
    const f = await setup(t, true),
      input = f.orderInput();
    const [a, b] = await Promise.all([
      f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, input, 0),
      f.api(f.doctor, `/patients/${f.patient.id}/lab-orders`, input, 1),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.body.id, b.body.id);
    assert.equal((await f.rows('integrationOutbox')).length, 1);
    assert.equal((await f.rows('task')).length, 1);
    await Promise.all(f.runtimes.map((r) => r.get('integrations').runOnce()));
    const first = f.result(a.body);
    const received = await Promise.all([f.receive(first, 0), f.receive(first, 1)]);
    assert(received.every((r) => r.status === 202));
    assert.deepEqual(received[0].body, received[1].body);
    await Promise.all(f.runtimes.map((r) => r.get('integrations').runOnce()));
    const corrections = [1, 2].map((number) =>
      f.result(a.body, {
        supersedesMessageId: first.messageId,
        report: { ...sampleReport(), correctionReason: `Correction ${number}` },
      }),
    );
    await Promise.all(corrections.map((m, i) => f.receive(m, i)));
    await Promise.all(f.runtimes.map((r) => r.get('integrations').runOnce()));
    assert.equal((await f.rows('labReport')).length, 2);
    const rows = await f.rows('integrationInbox');
    assert.equal(rows.filter((r) => r.data.state === 'applied').length, 2);
    assert.equal(rows.filter((r) => r.data.code === 'correction_conflict').length, 1);
    assert.equal((await f.rows('task')).length, 1);
  },
);

await test(
  'PostgreSQL: late worker cannot overwrite a newer lease',
  postgresTestOptions,
  async (t) => {
    const f = await setup(t, true, { timeoutMs: 3000, leaseMs: 4000 });
    await f.runtimes[0].get('integrations').order(f.doctor, f.patient.id, f.orderInput());
    let release!: () => void;
    f.behavior.acknowledgementGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = f.runtimes[0].get('integrations').runOnce();
    try {
      for (let i = 0; i < 100 && !(await f.orders()).length; i++) await pause(10);
      assert.equal((await f.orders()).length, 1);
      const store = f.runtimes[1].get('store');
      const claimed = (await f.rows('integrationOutbox', 1))[0];
      const newer = await store.revise(
        {
          id: 'connector:test-lab',
          tenant: f.tenant,
          unitId: f.doctor.unitId,
          role: 'integration',
        },
        claimed,
        claimed.version,
        { ...claimed.data, lease: randomUUID(), attempts: 2 },
        'integration.claimed',
      );
      release();
      await running;
      const final = await store.get(f.tenant, claimed.id);
      assert.equal(final!.version, newer.version);
      assert.equal(final!.data.state, 'sending');
      assert.equal(final!.data.lease, newer.data.lease);
    } finally {
      release();
      await running;
    }
  },
);
