import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/app.ts';
import { staffFixture } from './workforce-helpers.ts';
import { root } from './helpers.ts';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
import { fromConfig } from '../packages/runtime.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { tokenHash } from '../packages/staff-sessions.ts';

test('strict authorization separates identity, unit, provider, care relationship and action', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const clinical = f.runtime.get('clinical'),
    access = f.runtime.get('access');
  assert.equal((await clinical.chart(f.doctor, f.patient.id)).length, 2);
  for (const actor of [
    f.nurse,
    f.admin,
    f.reviewer,
    await f.find('emma', 'clinician', 'other-unit'),
    await f.find('emma', 'clinician', 'other-provider'),
    { id: f.doctor.id, tenant: f.doctor.tenant, role: 'clinician' as const },
  ])
    await assert.rejects(() => clinical.chart(actor, f.patient.id));
  await access.grant(
    f.doctor,
    f.patient.id,
    f.nurse.id,
    'clinician',
    new Date(Date.now() + 86400000).toISOString(),
    'Assigned care',
  );
  assert.equal((await clinical.chart(f.nurse, f.patient.id)).length, 2);
  const row = await f.workforce.current(f.nurse);
  await f.workforce.update(f.admin, row.id, row.version, {
    permissions: ['chart.read', 'record.write'],
    enabled: true,
    validUntil: row.data.validUntil,
    reason: 'Restricted duties',
  });
  const note = await clinical.create(f.nurse, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Observation',
  });
  await assert.rejects(
    () => clinical.transition(f.nurse, note.id, 'sign', note.version, {}),
    /Permission/,
  );
  await assert.rejects(() => f.runtime.get('fhir').bundle(f.nurse, f.patient.id), /Permission/);
  await assert.rejects(
    () => f.runtime.get('medications').add(f.nurse, f.patient.id, {}),
    /Permission/,
  );
  await assert.rejects(
    () => f.runtime.get('laboratories').order(f.nurse, f.patient.id, {}),
    /Permission/,
  );
  await assert.rejects(
    f.runtime.get('aiReview').propose(f.nurse, f.patient.id, f.encounter.id),
    /Permission/,
  );
  await assert.rejects(
    () =>
      access.grant(
        f.doctor,
        f.patient.id,
        f.doctor.id,
        'clinician',
        new Date(Date.now() + 86400000).toISOString(),
      ),
    /self-grants/,
  );
  await assert.rejects(
    () => f.workforce.update(f.admin, f.doctor.assignmentId!, 1, {}),
    /yourself/,
  );
  await assert.rejects(() =>
    f.workforce.create(f.admin, {
      ...row.data,
      actorId: 'new',
      subject: 'new',
      permissions: ['workforce.manage'],
      role: 'clinician',
    }),
  );
  assert(
    (await f.store.auditEntries(f.doctor.tenant)).some(
      (r) =>
        r.action === 'permission.note.sign' &&
        r.outcome === 'denied' &&
        r.assignmentId === f.nurse.assignmentId,
    ),
  );
});

test('session assignment switching, idle expiry, revocation and permission edits apply immediately', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const identity = f.runtime.get('identity');
  const token = await identity.issue!(f.doctor);
  const a = await identity.select!(token, f.admin.assignmentId!);
  assert.equal(a.role, 'administrator');
  await assert.rejects(identity.select!(token, f.nurse.assignmentId!), /unavailable/);
  const session = await identity.authenticate(token);
  assert.equal(session.assignmentId, f.admin.assignmentId);
  await assert.rejects(() => f.runtime.get('clinical').chart(session, f.patient.id));
  await identity.select!(token, f.doctor.assignmentId!);
  const nurseToken = await identity.issue!(f.nurse),
    row = await f.workforce.current(f.nurse);
  await f.workforce.update(f.admin, row.id, row.version, {
    permissions: row.data.permissions,
    enabled: false,
    validUntil: row.data.validUntil,
    reason: 'Employment ended',
  });
  await assert.rejects(identity.authenticate(nurseToken), /revoked/);
  assert.equal(await f.store.session(tokenHash(nurseToken)), undefined);
  assert(
    (await f.store.auditEntries(f.doctor.tenant)).some(
      (entry) =>
        entry.action === 'session.assignment-revoked' &&
        entry.actor === f.nurse.id &&
        entry.outcome === 'denied',
    ),
  );
  await assert.rejects(() => f.runtime.get('access').check(f.nurse, f.patient.id));
  f.store.db.exec("UPDATE sessions SET lastSeen='2000-01-01T00:00:00.000Z'");
  await assert.rejects(identity.authenticate(token), /expired/);
  assert.equal(await f.store.session(tokenHash(token)), undefined);
});

test('async permission context, team members and eligibility exclude unavailable staff and actions', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const access = f.runtime.get('access');
  assert.deepEqual((await access.context!(f.nurse, f.patient.id)).permissions, []);
  assert.equal(await access.eligible!(f.doctor, f.nurse.id, f.patient.id, 'chart.read'), false);
  assert((await access.members!(f.doctor)).some((member) => member.id === f.nurse.id));
  await access.grant(
    f.doctor,
    f.patient.id,
    f.nurse.id,
    'clinician',
    new Date(Date.now() + 86400000).toISOString(),
    'Assigned care',
  );
  const row = await f.workforce.current(f.nurse);
  const restricted = await f.workforce.update(f.admin, row.id, row.version, {
    enabled: true,
    permissions: ['chart.read'],
    validUntil: row.data.validUntil,
    reason: 'Read-only duties',
  });
  assert.deepEqual((await access.context!(f.nurse, f.patient.id)).permissions, ['chart.read']);
  assert.equal(await access.eligible!(f.doctor, f.nurse.id, f.patient.id, 'chart.read'), true);
  assert.equal(await access.eligible!(f.doctor, f.nurse.id, f.patient.id, 'record.write'), false);
  assert.equal(await access.allowed(f.nurse, f.patient.id, true), false);
  await f.workforce.update(f.admin, row.id, restricted.version, {
    enabled: false,
    permissions: ['chart.read'],
    validUntil: row.data.validUntil,
    reason: 'Assignment revoked',
  });
  assert.equal(await access.eligible!(f.doctor, f.nurse.id, f.patient.id, 'chart.read'), false);
  assert(!(await access.members!(f.doctor)).some((member) => member.id === f.nurse.id));
  await assert.rejects(access.context!(f.nurse, f.patient.id), /No active/);
  t.mock.method(f.store, 'get', async () => {
    throw new Error('Storage unavailable');
  });
  assert.equal(await access.allowed(f.doctor, f.patient.id), false);
  await assert.rejects(access.permit(f.doctor, 'chart.read', f.patient.id), /Permission/);
});

test('concurrent staff creation preserves unique assignments and identity mapping', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const row = await f.workforce.current(f.nurse);
  const input = { ...row.data, actorId: 'new-staff', subject: 'new-staff' };
  const results = await Promise.allSettled([
    f.workforce.create(f.admin, input),
    f.workforce.create(f.admin, input),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert.match(rejected.reason.message, /Assignment already exists/);
  assert.equal((await f.workforce.forIdentity(row.data.issuer, 'new-staff')).length, 1);
  await assert.rejects(
    f.workforce.create(f.admin, { ...input, actorId: 'another-staff' }),
    /different staff/,
  );
});

test('failed async access and workforce writes roll back their paired mutations', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const access = f.runtime.get('access');
  const insert = f.store.insert.bind(f.store);
  t.mock.method(f.store, 'insert', async (...args: Parameters<typeof insert>) => {
    if (['careRelationship', 'assignmentChange'].includes(args[1]))
      throw new Error('Follow-up write failed');
    return insert(...args);
  });
  await assert.rejects(
    access.grant(
      f.doctor,
      f.patient.id,
      f.nurse.id,
      'clinician',
      new Date(Date.now() + 86400000).toISOString(),
      'Assigned care',
    ),
    /Follow-up write failed/,
  );
  assert.equal(await f.store.getGrant(f.doctor.tenant, f.patient.id, f.nurse.id), undefined);
  assert(
    !(await f.store.auditEntries(f.doctor.tenant)).some((entry) => entry.action === 'access.grant'),
  );
  const row = await f.workforce.current(f.nurse);
  await assert.rejects(
    f.workforce.update(f.admin, row.id, row.version, {
      enabled: false,
      permissions: row.data.permissions,
      validUntil: row.data.validUntil,
      reason: 'Assignment revoked',
    }),
    /Follow-up write failed/,
  );
  assert.deepEqual(await f.store.get(row.tenant, row.id), row);
  assert.equal((await f.store.history(row.tenant, row.id)).length, 1);
  assert((await f.store.verifyAudit()).ok);
});

test('failed assignment selection still persists expiry and revocation', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const identity = f.runtime.get('identity');
  const token = await identity.issue!(f.nurse);
  const row = await f.workforce.current(f.nurse);
  await f.workforce.update(f.admin, row.id, row.version, {
    enabled: false,
    permissions: row.data.permissions,
    validUntil: row.data.validUntil,
    reason: 'Assignment revoked',
  });
  await assert.rejects(identity.select!(token, f.doctor.assignmentId!), /revoked/);
  assert.equal(await f.store.session(tokenHash(token)), undefined);
  const expired = await identity.issue!(f.doctor);
  f.store.db.exec("UPDATE sessions SET lastSeen='2000-01-01T00:00:00.000Z'");
  await assert.rejects(identity.select!(expired, f.admin.assignmentId!), /expired/);
  assert.equal(await f.store.session(tokenHash(expired)), undefined);
});

test('protected identity is excluded from every chart surface and emergency access is constrained and reviewed', async (t) => {
  const f = await staffFixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  const access = f.runtime.get('access'),
    review = f.runtime.get('accessReview');
  await access.grant(
    f.doctor,
    f.patient.id,
    f.nurse.id,
    'clinician',
    new Date(Date.now() + 86400000).toISOString(),
    'Assigned care',
  );
  await review.protect(f.doctor, f.patient.id, f.patient.version, {
    protected: true,
    reason: 'Protected identity verified',
  });
  assert.deepEqual(await f.runtime.get('clinical').patients(f.nurse), []);
  const headers = { authorization: `Bearer ${await f.runtime.get('identity').issue!(f.nurse)}` };
  for (const url of [
    `/api/patients/${f.patient.id}/chart`,
    `/api/patients/${f.patient.id}/changes`,
    `/api/patients/${f.patient.id}/export/fhir`,
    `/api/records/${f.encounter.id}/history`,
  ])
    assert.equal((await app.inject({ url, headers })).statusCode, 403);
  await assert.rejects(() => review.emergency(f.nurse, f.patient.id, { reason: 'Urgent' }));
  await f.store.grant(
    f.doctor.tenant,
    f.patient.id,
    f.doctor.id,
    'clinician',
    '2000-01-01T00:00:00.000Z',
  );
  const grant = await review.emergency(f.doctor, f.patient.id, {
    reason: 'Immediate assessment requested',
  });
  assert(await access.allowed(f.doctor, f.patient.id));
  await assert.rejects(() => access.permit(f.doctor, 'record.write', f.patient.id));
  await assert.rejects(() => access.permit(f.doctor, 'chart.export', f.patient.id));
  assert(
    !(await f.runtime.get('clinical').chart(f.doctor, f.patient.id)).some(
      (r) => r.kind === 'emergencyAccess',
    ),
  );
  const page = await review.list(f.reviewer, { limit: 100 });
  const event = page.entries.find((r) => r.action === 'access.emergency-opened')!;
  assert(event);
  assert.equal(event.entityId, grant.id);
  await review.review(f.reviewer, {
    seq: event.seq,
    hash: event.hash,
    decision: 'follow-up',
    note: 'Verify the clinical reason with the unit manager',
  });
  assert.equal(
    (await review.list(f.reviewer, { limit: 100 })).entries.find((r) => r.seq === event.seq)
      ?.reviews.length,
    1,
  );
  const own = (await review.list(f.reviewer, {})).entries.find((r) => r.actor === f.reviewer.id)!;
  await assert.rejects(() =>
    review.review(f.reviewer, { seq: own.seq, hash: own.hash, decision: 'justified', note: 'Own' }),
  );
  await assert.rejects(() => review.list(f.doctor, {}));
  await f.store.restrict(f.doctor.tenant, f.patient.id, true);
  assert(!(await access.allowed(f.doctor, f.patient.id)));
  await assert.rejects(() =>
    review.emergency(f.doctor, f.patient.id, { reason: 'Cannot bypass restriction' }),
  );
});

test('audit pagination remains unit-scoped and cannot use the legacy audit bypass', async (t) => {
  const f = await staffFixture(),
    app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  const other = await f.find('emma', 'clinician', 'other-unit');
  await f.store.audit(other, 'outside-unit');
  for (let i = 0; i < 110; i++) await f.store.audit(f.doctor, 'chart.test', f.patient.id);
  const review = f.runtime.get('accessReview');
  const first = await review.list(f.reviewer, { limit: 40 }),
    second = await review.list(f.reviewer, { limit: 40, before: first.nextBefore });
  assert(first.nextBefore);
  assert(second.nextBefore);
  assert(!second.entries.some((e) => first.entries.some((p) => p.seq === e.seq)));
  assert(![...first.entries, ...second.entries].some((e) => e.action === 'outside-unit'));
  const token = await f.runtime.get('identity').issue!(f.reviewer);
  assert.equal(
    (await app.inject({ url: '/api/audit', headers: { authorization: `Bearer ${token}` } }))
      .statusCode,
    403,
  );
});

test('AI rechecks current assignment after inference and revoked work is not stored', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const row = await f.workforce.current(f.nurse);
  await f.runtime
    .get('access')
    .grant(
      f.doctor,
      f.patient.id,
      f.nurse.id,
      'clinician',
      new Date(Date.now() + 86400000).toISOString(),
      'Assigned care',
    );
  f.runtime.get('aiProvider').generate = async (evidence) => {
    await f.workforce.update(f.admin, row.id, row.version, {
      permissions: row.data.permissions,
      enabled: false,
      validUntil: row.data.validUntil,
      reason: 'Assignment revoked during inference',
    });
    return { text: evidence[0].text, citations: [evidence[0]], mode: 'extractive', model: 'test' };
  };
  await assert.rejects(
    f.runtime.get('aiReview').propose(f.nurse, f.patient.id, f.encounter.id),
    /Permission/,
  );
  assert.equal((await f.store.list(f.doctor.tenant, f.patient.id, 'proposal')).length, 0);
});

test('revoked assignments survive restart; v2 sessions and single-use login storage persist safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eir-workforce-'));
  try {
    const path = join(dir, 'clinic.sqlite');
    const f = await staffFixture(path);
    const row = await f.workforce.current(f.nurse);
    await f.workforce.update(f.admin, row.id, row.version, {
      permissions: row.data.permissions,
      enabled: false,
      validUntil: row.data.validUntil,
      reason: 'Revoked',
    });
    await f.store.saveLogin('flow', { state: 'test' }, new Date(Date.now() + 60000).toISOString());
    await f.runtime.stop();
    const reopened = new SqliteStore(path);
    assert.equal((await reopened.get(row.tenant, row.id))?.data.enabled, false);
    assert.deepEqual(await reopened.consumeLogin('flow'), { state: 'test' });
    assert.equal(await reopened.consumeLogin('flow'), undefined);
    assert((await reopened.verifyAudit()).ok);
    await reopened.close();
    const restarted = await fromConfig(root + 'eir.demo.config.json', {
      'eir.storage.sqlite': { path },
      'eir.workforce': demoWorkforce('clinic-a'),
    });
    assert.equal(
      (await restarted.runtime.get('store').get(row.tenant, row.id))?.data.enabled,
      false,
    );
    await restarted.runtime.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 migration invalidates old sessions, preserves records and audit, and rejects future schema versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eir-migration-'));
  try {
    const path = join(dir, 'old.sqlite');
    const old = new SqliteStore(path);
    const actor = { id: 'legacy', tenant: 'clinic-a', role: 'clinician' as const };
    await old.insert(actor, 'patient', null, { name: 'Synthetic legacy record' });
    await old.saveSession('old-session', actor, '2099-01-01T00:00:00.000Z');
    old.db.exec(
      'ALTER TABLE sessions DROP COLUMN lastSeen; DROP TABLE login_transactions; PRAGMA user_version=1;',
    );
    await old.close();
    const migrated = new SqliteStore(path);
    assert.equal(await migrated.session('old-session'), undefined);
    assert.equal((await migrated.list(actor.tenant)).length, 1);
    assert((await migrated.verifyAudit()).ok);
    migrated.db.exec('PRAGMA user_version=4;');
    await migrated.close();
    assert.throws(() => new SqliteStore(path), /newer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
