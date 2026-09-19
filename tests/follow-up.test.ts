import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { followUpFixture } from './follow-up-helpers.ts';
import { sampleReport } from './integration-helpers.ts';
import { followUpState } from '../packages/follow-up.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';

async function failAudit(f: Awaited<ReturnType<typeof followUpFixture>>, action: string) {
  assert.match(action, /^[a-zA-Z.-]+$/);
  if (f.database) {
    await f.database.admin
      .query(`CREATE FUNCTION eir.fail_follow_up_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.body::jsonb->>'action' = '${action}' THEN RAISE EXCEPTION 'private-failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER zz_follow_up_failure BEFORE INSERT ON eir.audit FOR EACH ROW EXECUTE FUNCTION eir.fail_follow_up_audit();`);
    return () =>
      f.database!.admin.query(
        'DROP TRIGGER zz_follow_up_failure ON eir.audit; DROP FUNCTION eir.fail_follow_up_audit();',
      );
  }
  const db = (f.runtimes[0].get('store') as SqliteStore).db;
  db.exec(
    `CREATE TRIGGER follow_up_failure BEFORE INSERT ON audit WHEN json_extract(NEW.body,'$.action')='${action}' BEGIN SELECT RAISE(ABORT,'private-failure'); END;`,
  );
  return async () => {
    db.exec('DROP TRIGGER follow_up_failure');
  };
}

for (const pg of [false, true]) {
  test(
    `${pg ? 'PostgreSQL' : 'SQLite'}: audit failure rolls back evaluation and completion; remote acceptance survives local commit failure`,
    { skip: pg && !process.env.EIR_TEST_POSTGRES_URL },
    async (t) => {
      const f = await followUpFixture(pg);
      t.after(f.cleanup);
      const runtime = f.runtimes[0],
        service = runtime.get('followUp'),
        store = runtime.get('store');
      const task = await runtime
        .get('careTeam')
        .createTask(f.doctor, f.patient.id, { title: 'Follow-up call', due: '2026-01-01' });
      let repair = await failAudit(f, 'follow-up.evaluate');
      await assert.rejects(service.runOnce());
      assert.equal((await f.rows('task'))[0].version, task.version);
      assert.equal((await f.rows('followUpNotification')).length, 0);
      assert.equal((await f.rows('followUpEvent')).length, 0);
      await repair();
      repair = await failAudit(f, 'follow-up.notification-delivered');
      await assert.rejects(service.runOnce());
      let notification = (await f.rows('followUpNotification'))[0];
      assert.equal(notification.data.state, 'sending');
      assert.equal(f.messages.size, 1);
      await repair();
      // Simulate lease expiry without waiting for wall-clock time in the test.
      await store.revise(
        f.doctor,
        notification,
        notification.version,
        { ...notification.data, availableAt: '2026-01-01T00:00:00Z' },
        'test.expire-lease',
      );
      await f.restart();
      await f.runtimes[0].get('followUp').runOnce();
      notification = (await f.rows('followUpNotification'))[0];
      assert.equal(notification.data.state, 'delivered');
      assert.equal(f.messages.size, 1);
      assert.equal(f.attempts[0].messageId, f.attempts[1].messageId);
      repair = await failAudit(f, 'follow-up.complete');
      const current = (await f.rows('task'))[0],
        events = await f.rows('followUpEvent');
      await assert.rejects(
        f.runtimes[0].get('followUp').action(f.doctor, task.id, current.version, {
          type: 'complete',
          note: 'All actions complete',
        }),
      );
      assert.equal((await f.rows('task'))[0].version, current.version);
      assert.equal((await f.rows('followUpEvent')).length, events.length);
      await repair();
      assert((await f.runtimes[0].get('store').verifyAudit()).ok);
    },
  );

  test(
    `${pg ? 'PostgreSQL replicas' : 'SQLite restart'}: missing result, durable notification retries and one clinical owner`,
    { skip: pg && !process.env.EIR_TEST_POSTGRES_URL },
    async (t) => {
      const f = await followUpFixture(pg);
      t.after(f.cleanup);
      const { task } = await f.create();
      f.behavior.mode = 'lose-ack';
      if (pg) {
        let release!: () => void;
        f.behavior.gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = f.runtimes[0].get('followUp').runOnce();
        for (let i = 0; f.attempts.length === 0 && i < 100; i++) await setTimeout(5);
        assert.equal(f.attempts.length, 1);
        await f.runtimes[1].get('followUp').runOnce();
        release();
        await first;
        f.behavior.gate = undefined;
      } else await f.runtimes[0].get('followUp').runOnce();
      assert.equal((await f.rows('followUpNotification')).length, 1);
      assert.equal((await f.rows('task'))[0].data.status, 'requested');
      assert.equal(f.messages.size, 1);
      await f.restart();
      await setTimeout(30);
      f.behavior.mode = 'accept';
      await f.runtimes[0].get('followUp').runOnce();
      const notifications = await f.rows('followUpNotification');
      assert.equal(notifications[0].data.state, 'delivered');
      assert.equal(f.messages.size, 1);
      assert.equal(f.attempts[0].messageId, f.attempts[1].messageId);
      const outgoing = JSON.stringify(f.attempts);
      for (const secret of [
        task.id,
        f.patient.id,
        f.patient.data.name,
        f.patient.data.identifier.value,
        'Elektrolytstatus',
      ])
        assert(!outgoing.includes(secret));
      const listed = await f.runtimes[0].get('followUp').list(f.doctor, {});
      assert.equal(listed.items[0].state.stage, 'awaiting-result');
      assert(listed.items[0].overdue);
      assert((await f.runtimes[0].get('store').verifyAudit()).ok);
    },
  );
}

test('coverage never grants access; transfers only to an eligible colleague and logs machine ownership', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  const { task } = await f.create();
  const runtime = f.runtimes[0];
  const service = runtime.get('followUp');
  const coverage = {
    coverId: f.colleague.id,
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString(),
    reason: 'Clinician unavailable for this shift',
  };
  await service.coverage(f.doctor, coverage);
  await assert.rejects(service.coverage(f.doctor, coverage), { status: 409 });
  await service.runOnce();
  assert.equal((await f.rows('task'))[0].data.assigneeId, f.doctor.id);
  assert.equal((await f.rows('task'))[0].data.followUp.blocker, 'coverage_ineligible');
  await runtime
    .get('access')
    .grant(
      f.doctor,
      f.patient.id,
      f.colleague.id,
      'clinician',
      new Date(Date.now() + 86400000).toISOString(),
      'Covering care relationship',
    );
  await service.runOnce();
  const updated = (await f.rows('task'))[0];
  assert.equal(updated.data.assigneeId, f.colleague.id);
  await assert.rejects(
    service.action(f.doctor, task.id, updated.version, {
      type: 'complete',
      note: 'This is not my work',
    }),
    { status: 403 },
  );
  const audit = await runtime.get('store').auditEntries(f.tenant);
  assert(
    audit.some(
      (row) => row.action === 'follow-up.evaluate' && row.actor === 'follow-up:demo-primary-care',
    ),
  );
});

test('unavailable escalation recipient remains flagged and is rechecked after access changes', async (t) => {
  const f = await followUpFixture(false, 0, false, (tenant) => ({
    'eir.follow-up.policy': {
      policies: [
        {
          tenant,
          unitId: 'demo-primary-care',
          version: 'test-approved',
          timeZone: 'Europe/Stockholm',
          reviewMinutes: 60,
          criticalReviewMinutes: 10,
          escalationMinutes: 1,
          reminderMinutes: 60,
          fallbackActorId: 'demo-colleague',
        },
      ],
    },
  }));
  t.after(f.cleanup);
  await f.create('2026-01-01T00:00:00Z');
  const runtime = f.runtimes[0],
    service = runtime.get('followUp');
  await service.runOnce();
  await service.runOnce();
  assert.equal((await f.rows('task'))[0].data.followUp.blocker, 'escalation_recipient_missing');
  await runtime
    .get('access')
    .grant(
      f.doctor,
      f.patient.id,
      f.colleague.id,
      'clinician',
      new Date(Date.now() + 3600000).toISOString(),
      'Covering care relationship',
    );
  await service.runOnce();
  assert.equal((await f.rows('task'))[0].data.assigneeId, f.colleague.id);
  assert.equal((await f.rows('task'))[0].data.followUp.blocker, null);
});

test(
  'late notification completion cannot overwrite a newer lease',
  { skip: !process.env.EIR_TEST_POSTGRES_URL },
  async (t) => {
    const f = await followUpFixture(true);
    t.after(f.cleanup);
    await f.create();
    let release!: () => void;
    f.behavior.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.runtimes[0].get('followUp').runOnce();
    for (let i = 0; !f.attempts.length && i < 100; i++) await setTimeout(5);
    assert.equal(f.attempts.length, 1);
    const store = f.runtimes[1].get('store'),
      row = (await f.rows('followUpNotification'))[0];
    await store.revise(
      f.doctor,
      row,
      row.version,
      { ...row.data, availableAt: '2026-01-01T00:00:00Z' },
      'test.expire-lease',
    );
    f.behavior.mode = 'fail';
    await f.runtimes[1].get('followUp').runOnce();
    assert.equal((await f.rows('followUpNotification'))[0].data.state, 'failed');
    f.behavior.mode = 'accept';
    release();
    await first;
    assert.equal((await f.rows('followUpNotification'))[0].data.state, 'failed');
    assert.equal((await f.rows('task'))[0].data.status, 'requested');
  },
);

for (const mode of ['wrong-ack', 'oversized']) {
  test(`notification gateway ${mode} never records confirmed delivery`, async (t) => {
    const f = await followUpFixture();
    t.after(f.cleanup);
    await f.create();
    f.behavior.mode = mode;
    await f.runtimes[0].get('followUp').runOnce();
    assert.equal((await f.rows('followUpNotification'))[0].data.state, 'retry');
    assert.equal((await f.rows('task'))[0].data.status, 'requested');
  });
}

test('oversight rejects malformed cursors and internal delivery records stay out of chart projections', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  await f.create();
  const runtime = f.runtimes[0],
    service = runtime.get('followUp');
  await service.runOnce();
  await assert.rejects(service.list(f.doctor, { after: 'bad-cursor' }), { status: 422 });
  const chart = await f.api(f.doctor, `/patients/${f.patient.id}/chart`);
  assert.equal(chart.status, 200);
  for (const row of await f.rows('followUpNotification'))
    assert(!JSON.stringify(chart.body).includes(row.data.routeRecipient));
});

test('review leaves action open; contact attempts do not close it; correction blocks stale completion', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  const runtime = f.runtimes[0],
    labs = runtime.get('laboratories'),
    service = runtime.get('followUp');
  const { order } = await f.create();
  const report = await labs.receive(f.doctor, order.id, order.version, {
    ...sampleReport(),
    source: 'Test lab',
    messageId: randomUUID(),
  });
  const row = async () => (await f.rows('labOrder'))[0];
  const task = async () => (await f.rows('task'))[0];
  await service.runOnce();
  assert.equal((await service.list(f.doctor, {})).items[0].state.critical, true);
  await labs.review(f.doctor, order.id, (await row()).version, {
    reportId: report.id,
    taskVersion: (await task()).version,
    assessment: 'Reviewed current report',
    action: 'Contact patient',
    communication: 'Call planned',
    criticalAcknowledged: true,
    disposition: 'action-required',
    actionDueAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal((await task()).data.status, 'requested');
  await service.action(f.doctor, (await task()).id, (await task()).version, {
    type: 'contact-attempt',
    note: 'Called patient; no answer',
  });
  assert.equal((await task()).data.status, 'requested');
  const stale = await task();
  await labs.receive(f.doctor, order.id, (await row()).version, {
    ...sampleReport(),
    source: 'Test lab',
    messageId: randomUUID(),
    correctionReason: 'Corrected from original source',
  });
  await assert.rejects(
    service.action(f.doctor, stale.id, stale.version, {
      type: 'complete',
      note: 'Old report action complete',
    }),
    { status: 409 },
  );
  await assert.rejects(
    service.action(f.doctor, stale.id, (await task()).version, {
      type: 'complete',
      note: 'Current report not reviewed',
    }),
    { status: 409 },
  );
  await labs.review(f.doctor, order.id, (await row()).version, {
    reportId: (await row()).data.reportId,
    taskVersion: (await task()).version,
    assessment: 'Correction reviewed',
    action: 'Repeat planned action',
    communication: 'Patient contacted',
    criticalAcknowledged: true,
  });
  assert.equal(
    (await task()).data.status,
    'requested',
    'Legacy review requests fail safe with open action',
  );
  await service.action(f.doctor, stale.id, (await task()).version, {
    type: 'complete',
    note: 'All required actions completed and documented',
  });
  assert.equal((await task()).data.status, 'completed');
  assert.equal((await row()).data.actionRequired, false);
  assert.equal(
    (await service.list(f.doctor, { taskId: stale.id })).items[0].events.filter(
      (r: any) => r.data.type === 'contact-attempt',
    ).length,
    1,
  );
});

test('notification failure remains visible; replay is versioned and stale work is cancelled', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  const runtime = f.runtimes[0],
    service = runtime.get('followUp');
  const task = await runtime.get('careTeam').createTask(f.doctor, f.patient.id, {
    title: 'Follow-up call',
    due: '2026-01-01',
    dueAt: '2026-01-01T09:00:00Z',
  });
  f.behavior.mode = 'fail';
  await service.runOnce();
  await setTimeout(30);
  await service.runOnce();
  const notification = (await f.rows('followUpNotification'))[0];
  assert.equal(notification.data.state, 'failed');
  assert.equal((await service.list(f.doctor, {})).items[0].notification.state, 'failed');
  await assert.rejects(
    service.replay(f.doctor, notification.id, notification.version - 1, 'Gateway recovered'),
    { status: 409 },
  );
  await service.replay(f.doctor, notification.id, notification.version, 'Gateway recovered');
  const current = (await f.rows('task'))[0];
  await service.action(f.doctor, task.id, current.version, {
    type: 'complete',
    note: 'Follow-up call completed',
  });
  f.behavior.mode = 'accept';
  await service.runOnce();
  assert.equal((await f.rows('followUpNotification'))[0].data.state, 'cancelled');
  assert.equal(f.messages.size, 0);
});

test('restriction, role and unit boundaries exclude oversight, events and delivery', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  const runtime = f.runtimes[0],
    service = runtime.get('followUp');
  await f.create();
  await assert.rejects(service.list(f.admin, {}), { status: 403 });
  assert.equal((await service.list(f.colleague, {})).items.length, 0);
  await runtime.get('store').restrict(f.tenant, f.patient.id, true);
  await service.runOnce();
  assert.equal(f.messages.size, 0);
  assert.equal((await service.list(f.doctor, {})).items.length, 0);
  await assert.rejects(
    service.action(f.colleague, (await f.rows('task'))[0].id, 1, {
      type: 'action',
      note: 'Not an authorized chart',
    }),
    { status: 403 },
  );
});

test('policy evaluation keeps a legacy report deadline stable and respects precise UTC deadlines', () => {
  const task: any = {
    id: 'task',
    updatedAt: '2026-09-01T10:00:00Z',
    data: { status: 'requested', due: '2026-09-01' },
  };
  const order: any = {
    updatedAt: '2026-09-01T09:00:00Z',
    data: { status: 'received', reportId: 'r1', critical: true },
  };
  const policy = {
    version: 'test',
    timeZone: 'Europe/Stockholm',
    reviewMinutes: 1440,
    criticalReviewMinutes: 15,
    escalationMinutes: 30,
    reminderMinutes: 60,
  };
  assert.equal(followUpState(task, order, policy).deadlineAt, '2026-09-01T09:15:00.000Z');
  task.updatedAt = '2026-09-02T10:00:00Z';
  assert.equal(followUpState(task, order, policy).deadlineAt, '2026-09-01T09:15:00.000Z');
  order.data.status = 'requested';
  order.data.expectedAt = '2026-09-01T10:30:00Z';
  assert.equal(followUpState(task, order, policy).deadlineAt, order.data.expectedAt);
});

test('a changed notification destination cancels the old envelope and creates a separately addressed message', async (t) => {
  const f = await followUpFixture();
  t.after(f.cleanup);
  await f.create();
  const runtime = f.runtimes[0],
    service = runtime.get('followUp');
  f.behavior.mode = 'fail';
  await service.runOnce();
  await setTimeout(30);
  await service.runOnce();
  const original = (await f.rows('followUpNotification'))[0];
  assert.equal(original.data.state, 'failed');
  runtime.get('notificationTransport').destination = 'replacement-gateway';
  await service.replay(f.doctor, original.id, original.version, 'Approved gateway replacement');
  f.behavior.mode = 'accept';
  await service.runOnce();
  assert.equal((await f.rows('followUpNotification'))[0].data.state, 'cancelled');
  await service.runOnce();
  const replacement = (await f.rows('followUpNotification')).find((row) => row.id !== original.id)!;
  assert.equal(replacement.data.state, 'delivered');
  assert.notEqual(replacement.data.messageId, original.data.messageId);
  assert.equal(replacement.data.destination, 'replacement-gateway');
});
