import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { integrationFixture, sampleReport } from './integration-helpers.ts';
import { Runtime } from '../packages/runtime.ts';
import vitals from '../plugins/risk-vitals.ts';
import type { RiskInput } from '../packages/deterioration.ts';

const fixture = (pg = false) =>
  integrationFixture(pg, {}, 0, () => ({ 'eir.deterioration': { worker: false } }));
async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  const m = f.runtimes[0].get('modules');
  const state = await m.state(f.tenant, f.doctor.unitId!, 'deterioration');
  return m.set(f.doctor, 'deterioration', {
    enabled: true,
    version: state.version,
    reason: 'Synthetic workflow validation',
  });
}
async function enroll(f: Awaited<ReturnType<typeof fixture>>) {
  await enable(f);
  return f.runtimes[0].get('deterioration').enroll(f.doctor, f.patient.id, {
    encounterId: f.encounter.id,
    reason: 'Synthetic monitoring scenario',
  });
}
async function pulse(f: Awaited<ReturnType<typeof fixture>>, value = 140) {
  return f.runtimes[0].get('clinical').create(f.doctor, f.patient.id, 'observation', {
    encounterId: f.encounter.id,
    code: '8867-4',
    value,
    unit: '/min',
    effectiveAt: new Date().toISOString(),
  });
}
test('vital engine: thresholds, trends, missingness, stale values, units, adult scope and evidence', async (t) => {
  const runtime = await new Runtime().start([{ plugin: vitals }]);
  t.after(() => runtime.stop());
  const engine = runtime.get('riskEngine');
  const input: RiskInput = {
    protocol: 'eir.risk.v1',
    ageYears: 46,
    evaluatedAt: '2026-09-19T12:00:00.000Z',
    readings: [],
    labs: [],
  };
  assert.equal((await engine.evaluate(input)).status, 'insufficient-data');
  const reading = (
    code: string,
    value: number,
    unit: string,
    effectiveAt = '2026-09-19T11:00:00.000Z',
  ) => ({
    ref: code + '@1:' + effectiveAt,
    kind: 'vital' as const,
    system: 'http://loinc.org',
    code,
    value,
    unit,
    effectiveAt,
  });
  input.readings = [
    reading('8867-4', 80, '/min'),
    reading('8480-6', 120, 'mm[Hg]'),
    reading('9279-1', 16, '/min'),
    reading('59408-5', 98, '%'),
    reading('8310-5', 37, 'Cel'),
  ];
  assert.equal((await engine.evaluate(input)).status, 'no-trigger');
  input.readings.push(reading('8867-4', 115, '/min', '2026-09-19T11:30:00.000Z'));
  const trend = await engine.evaluate(input);
  assert.equal(trend.status, 'alert');
  assert.equal(trend.findings[0].refs.length, 2);
  assert.equal((await engine.evaluate({ ...input, ageYears: 10 })).status, 'insufficient-data');
  const high = reading('8867-4', 130, '/min');
  assert.equal((await engine.evaluate({ ...input, readings: [high] })).status, 'alert');
  for (const bad of [
    { ...high, unit: 'bpm' },
    { ...high, value: NaN },
    { ...high, effectiveAt: '2026-09-19T08:00:00.000Z' },
    { ...high, effectiveAt: '2026-09-19T13:00:00.000Z' },
  ])
    assert.equal(
      (await engine.evaluate({ ...input, readings: [bad] })).status,
      'insufficient-data',
    );
  assert.equal(
    (await engine.evaluate({ ...input, readings: [high, { ...high, value: 80 }] })).status,
    'insufficient-data',
  );
});

test('module settings are off by default, authorized, versioned, audited and survive restart', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.equal((await f.api(f.doctor, '/modules')).body.items[0].enabled, false);
  assert.equal((await f.api(f.admin, '/modules')).body.canManage, true);
  const workforce = f.runtimes[0].get('workforce');
  const nurse = workforce.actor(
    (await workforce.forIdentity('https://local.eir.invalid', 'david'))[0],
  );
  const body = { enabled: true, version: 0, reason: 'Activation test' };
  assert.equal((await f.api(nurse, '/modules/deterioration', body)).status, 403);
  assert.equal((await f.api(f.admin, '/modules/store', body)).status, 404);
  assert.equal((await f.api(f.admin, '/modules/deterioration', body)).status, 200);
  assert.equal((await f.api(f.admin, '/modules/deterioration', body)).status, 409);
  await f.restart();
  assert.equal((await f.api(f.doctor, '/modules')).body.items[0].enabled, true);
  assert.equal((await f.runtimes[0].get('store').verifyAudit()).ok, true);
});

test('complete alert lifecycle: automatic evaluation, deduplication, acknowledgement is not completion, evidence-bound reassessment', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  await pulse(f);
  const service = f.runtimes[0].get('deterioration');
  await service.runOnce();
  await service.runOnce();
  assert.equal((await f.rows('deteriorationAlert')).length, 1);
  assert.equal((await f.rows('deteriorationAssessment')).length, 1);
  let item = (await service.list(f.doctor)).items[0];
  assert.equal(item.assessment?.data.status, 'alert');
  assert.equal(item.assessment?.data.automatic, true);
  const chart = await f.api(f.doctor, `/patients/${f.patient.id}/chart`);
  assert(!chart.body.some((row: any) => row.kind.startsWith('deterioration')));
  assert.deepEqual((await f.api(f.doctor, `/records/${item.assessment!.id}/history`)).body, []);
  const changes = await f.api(f.doctor, `/patients/${f.patient.id}/changes`);
  assert(!changes.body.entries.some((row: any) => row.record.kind.startsWith('deterioration')));
  const exported = await f.api(f.doctor, `/patients/${f.patient.id}/export/fhir`);
  assert(!JSON.stringify(exported.body).includes(item.assessment!.id));
  let alert = item.alerts[0];
  const respond = (action: string) =>
    service.respond(f.doctor, alert.id, {
      version: alert.version,
      assessmentId: alert.data.assessmentId,
      action,
      note: 'Clinical reassessment documented',
      plan: 'Repeat measurements and review documented',
    });
  await assert.rejects(respond('resolve'), /Reassess/);
  alert = await respond('acknowledge');
  assert.equal((await f.rows('task'))[0].data.status, 'requested');
  const task = item.tasks[0];
  await assert.rejects(
    f.runtimes[0].get('careTeam').task(f.doctor, task.id, 'complete', task.version, {}),
  );
  await assert.rejects(
    f.runtimes[0].get('followUp').action(f.doctor, task.id, task.version, {
      type: 'complete',
      note: 'Cannot bypass clinical review',
    }),
  );
  await pulse(f, 150);
  await assert.rejects(respond('reassess'), /current evaluation/);
  await service.evaluate(f.doctor, monitor.id);
  await assert.rejects(respond('reassess'), /evidence changed/);
  item = (await service.list(f.doctor)).items[0];
  alert = item.alerts[0];
  alert = await respond('reassess');
  alert = await respond('resolve');
  assert.equal(alert.data.open, false);
  assert.equal((await f.rows('task'))[0].data.status, 'completed');
  await service.runOnce();
  assert.equal((await f.rows('deteriorationAlert')).length, 1);
  assert.equal((await service.list(f.doctor)).items[0].events.length, 3);
});

test('switching off stops work without hiding unresolved alerts; stop and corrections preserve history', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  const observation = await pulse(f);
  const service = f.runtimes[0].get('deterioration');
  await service.runOnce();
  await f.runtimes[0]
    .get('clinical')
    .transition(f.doctor, observation.id, 'correct', observation.version, {
      reason: 'Incorrect measurement corrected',
    });
  await service.runOnce();
  let item = (await service.list(f.doctor)).items[0];
  assert.equal(item.assessment?.data.status, 'insufficient-data');
  assert.equal(item.alerts.length, 1);
  const setting = await f.runtimes[0]
    .get('modules')
    .state(f.tenant, f.doctor.unitId!, 'deterioration');
  await f.runtimes[0].get('modules').set(f.doctor, 'deterioration', {
    version: setting.version,
    enabled: false,
    reason: 'Planned change control',
  });
  assert.equal((await service.runOnce()).scanned, 0);
  await assert.rejects(service.evaluate(f.doctor, monitor.id), /switched off/);
  await service.stop(f.doctor, monitor.id, {
    version: item.monitor.version,
    reason: 'Monitoring handover recorded',
  });
  item = (await service.list(f.doctor)).items[0];
  assert.equal(item.alerts.length, 1);
  assert.equal(item.monitor.data.active, false);
  let alert = item.alerts[0];
  for (const action of ['reassess', 'resolve']) {
    alert = await service.respond(f.doctor, alert.id, {
      version: alert.version,
      assessmentId: alert.data.assessmentId,
      action,
      note: 'Outstanding clinical work reviewed while monitoring is off',
      plan: 'Continue documented manual follow-up',
    });
  }
  assert.equal(alert.data.open, false);
  assert.equal((await f.rows('task'))[0].data.status, 'completed');
});

test('data, permission or activation changes during inference discard the result', async (t) => {
  for (const change of ['data', 'activation', 'restriction'] as const) {
    const f = await fixture();
    t.after(f.cleanup);
    const monitor = await enroll(f);
    await pulse(f);
    const engine = f.runtimes[0].get('riskEngine'),
      original = engine.evaluate.bind(engine);
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    engine.evaluate = async (input) => {
      entered();
      await gate;
      return original(input);
    };
    const pending = f.runtimes[0].get('deterioration').evaluate(f.doctor, monitor.id);
    await start;
    if (change === 'data') await pulse(f, 150);
    if (change === 'activation')
      await f.runtimes[0].get('modules').set(f.doctor, 'deterioration', {
        enabled: false,
        version: 1,
        reason: 'Disable during inference',
      });
    if (change === 'restriction')
      await f.runtimes[0].get('store').restrict(f.tenant, f.patient.id, true);
    release();
    await pending.catch((error) => {
      assert.equal(change, 'restriction');
      assert.equal(error.status, 403);
    });
    assert.equal((await f.rows('deteriorationAssessment')).length, 0);
    assert.equal((await f.rows('task')).length, 0);
  }
});

test('model failures and unsupported evidence fail closed, without claiming low risk', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  await pulse(f);
  const engine = f.runtimes[0].get('riskEngine');
  engine.evaluate = async () => ({
    status: 'alert',
    findings: [{ code: 'fake', text: 'Unsupported claim', refs: ['unknown-source'] }],
    missing: [],
  });
  await f.runtimes[0].get('deterioration').evaluate(f.doctor, monitor.id);
  assert.equal((await f.rows('deteriorationAssessment'))[0].data.status, 'unavailable');
  assert.equal((await f.rows('deteriorationAlert')).length, 0);
  engine.evaluate = async () => {
    throw new Error('Private upstream diagnostic');
  };
  await f.runtimes[0].get('deterioration').evaluate(f.doctor, monitor.id);
  assert.equal(
    JSON.stringify(await f.rows('deteriorationAssessment')).includes('Private upstream'),
    false,
  );
});

test('closed encounters, children and foreign tenants cannot be monitored', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  await pulse(f);
  const service = f.runtimes[0].get('deterioration');
  assert.equal((await f.api(f.admin, '/deterioration')).status, 403);
  await assert.rejects(service.evaluate({ ...f.doctor, tenant: 'another-tenant' }, monitor.id));
  await f.runtimes[0]
    .get('clinical')
    .transition(f.doctor, f.encounter.id, 'close', f.encounter.version, {});
  await service.runOnce();
  assert.equal((await f.rows('deteriorationAssessment')).length, 0);
  assert.ok((await service.list(f.doctor)).items[0].monitor.data.failure);
  assert.equal((await service.list(f.doctor)).items[0].monitor.data.active, false);
  const child = await f.runtimes[0].get('clinical').register(f.doctor, {
    name: 'Test Child',
    birthDate: '2020-01-01',
    identifier: { type: 'local', value: 'CHILD-TEST' },
  });
  const encounter = await f.runtimes[0]
    .get('clinical')
    .create(f.doctor, child.id, 'encounter', { reason: 'Test encounter' });
  await assert.rejects(
    service.enroll(f.doctor, child.id, { encounterId: encounter.id, reason: 'Scope validation' }),
    /adults/,
  );
});

test('revoked owners and protected records never reach the risk engine', async (t) => {
  for (const restriction of ['revoked', 'protected'] as const) {
    const f = await fixture();
    t.after(f.cleanup);
    await enroll(f);
    await pulse(f);
    let calls = 0;
    f.runtimes[0].get('riskEngine').evaluate = async () => {
      calls++;
      return { status: 'no-trigger', findings: [], missing: [] };
    };
    if (restriction === 'revoked') {
      const workforce = f.runtimes[0].get('workforce'),
        current = await workforce.current(f.doctor);
      const colleague = (await workforce.forIdentity('https://local.eir.invalid', 'david'))[0];
      const administrator = await workforce.create(f.admin, {
        ...colleague.data,
        role: 'administrator',
        permissions: ['workforce.manage'],
      });
      await workforce.update(workforce.actor(administrator), current.id, current.version, {
        enabled: false,
        permissions: current.data.permissions,
        validUntil: current.data.validUntil,
        reason: 'Assignment revoked for security test',
      });
    } else {
      await f.runtimes[0].get('accessReview').protect(f.doctor, f.patient.id, f.patient.version, {
        protected: true,
        reason: 'Protected identity test',
      });
    }
    await f.runtimes[0].get('deterioration').runOnce();
    assert.equal(calls, 0);
    assert.equal((await f.rows('deteriorationAlert')).length, 0);
    assert.ok((await f.rows('deteriorationMonitor'))[0].data.failure);
  }
});

test('deployment activation gate cannot be overridden by an administrator', async (t) => {
  const f = await integrationFixture(false, {}, 0, () => ({
    'eir.deterioration': { worker: false },
    'eir.modules': {
      definitions: [
        {
          id: 'deterioration',
          name: 'Monitoring',
          moduleVersion: '1.0.0',
          canEnable: false,
          restriction: 'Not approved',
        },
      ],
    },
  }));
  t.after(f.cleanup);
  assert.equal(
    (
      await f.api(f.admin, '/modules/deterioration', {
        enabled: true,
        version: 0,
        reason: 'Attempt to bypass deployment gate',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api(f.doctor, '/patients/' + f.patient.id + '/monitoring', {
        encounterId: f.encounter.id,
        reason: 'Attempt to enroll while disabled',
      })
    ).status,
    409,
  );
});

test('assessment, alert and task changes roll back together on storage failure', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  await pulse(f);
  const store = f.runtimes[0].get('store'),
    insert = store.insert.bind(store);
  store.insert = async (...args) => {
    const result = await insert(...args);
    if (args[1] === 'task') throw new Error('Injected storage failure');
    return result;
  };
  await assert.rejects(
    f.runtimes[0].get('deterioration').evaluate(f.doctor, monitor.id),
    /Injected/,
  );
  store.insert = insert;
  assert.equal((await f.rows('deteriorationAssessment')).length, 0);
  assert.equal((await f.rows('deteriorationAlert')).length, 0);
  assert.equal((await f.rows('task')).length, 0);
  assert.equal((await store.verifyAudit()).ok, true);
});

test('risk input uses age and current encounter data, including only the current corrected laboratory report', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const monitor = await enroll(f);
  const labs = f.runtimes[0].get('laboratories');
  const { connectorId, ...input } = f.orderInput();
  let order = await labs.order(f.doctor, f.patient.id, input);
  await labs.receive(f.doctor, order.id, order.version, {
    ...sampleReport(),
    messageId: randomUUID(),
    source: 'Test source',
  });
  order = (await f.runtimes[0].get('store').get(f.tenant, order.id))!;
  await labs.receive(f.doctor, order.id, order.version, {
    ...sampleReport(),
    messageId: randomUUID(),
    source: 'Test source',
    correctionReason: 'Corrected measurement',
    results: [{ ...sampleReport().results[0], value: '8.2' }],
  });
  let captured: RiskInput | undefined;
  f.runtimes[0].get('riskEngine').evaluate = async (input) => {
    captured = input;
    return { status: 'insufficient-data', findings: [], missing: ['No vital observations'] };
  };
  await f.runtimes[0].get('deterioration').evaluate(f.doctor, monitor.id);
  assert.equal(captured?.labs.length, 1);
  assert.equal(captured?.labs[0].value, '8.2');
  assert.ok(captured!.ageYears >= 18);
  assert.equal(JSON.stringify(captured).includes('Anna'), false);
});

test(
  'PostgreSQL replicas deduplicate alerts and preserve module activation across restart',
  { skip: !process.env.EIR_TEST_POSTGRES_URL },
  async (t) => {
    const f = await fixture(true);
    t.after(f.cleanup);
    const monitor = await enroll(f);
    await pulse(f);
    await Promise.all(f.runtimes.map((r) => r.get('deterioration').evaluate(f.doctor, monitor.id)));
    assert.equal((await f.rows('deteriorationAlert')).length, 1);
    assert.equal((await f.rows('task')).length, 1);
    await f.restart(0);
    assert.equal(
      (await f.runtimes[0].get('modules').state(f.tenant, f.doctor.unitId!, 'deterioration'))
        .enabled,
      true,
    );
    assert.equal(
      (await f.runtimes[0].get('deterioration').list(f.doctor)).items[0].alerts.length,
      1,
    );
  },
);
