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

test('strict authorization separates identity, unit, provider, care relationship and action', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const clinical = f.runtime.get('clinical'),
    access = f.runtime.get('access');
  assert.equal(clinical.chart(f.doctor, f.patient.id).length, 2);
  for (const actor of [
    f.nurse,
    f.admin,
    f.reviewer,
    f.find('emma', 'clinician', 'other-unit'),
    f.find('emma', 'clinician', 'other-provider'),
    { id: f.doctor.id, tenant: f.doctor.tenant, role: 'clinician' as const },
  ])
    assert.throws(() => clinical.chart(actor, f.patient.id));
  access.grant(
    f.doctor,
    f.patient.id,
    f.nurse.id,
    'clinician',
    new Date(Date.now() + 86400000).toISOString(),
    'Assigned care',
  );
  assert.equal(clinical.chart(f.nurse, f.patient.id).length, 2);
  const row = f.workforce.current(f.nurse);
  f.workforce.update(f.admin, row.id, row.version, {
    permissions: ['chart.read', 'record.write'],
    enabled: true,
    validUntil: row.data.validUntil,
    reason: 'Restricted duties',
  });
  const note = clinical.create(f.nurse, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Observation',
  });
  assert.throws(
    () => clinical.transition(f.nurse, note.id, 'sign', note.version, {}),
    /Permission/,
  );
  assert.throws(() => f.runtime.get('fhir').bundle(f.nurse, f.patient.id), /Permission/);
  assert.throws(() => f.runtime.get('medications').add(f.nurse, f.patient.id, {}), /Permission/);
  assert.throws(() => f.runtime.get('laboratories').order(f.nurse, f.patient.id, {}), /Permission/);
  await assert.rejects(
    f.runtime.get('aiReview').propose(f.nurse, f.patient.id, f.encounter.id),
    /Permission/,
  );
  assert.throws(
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
  assert.throws(() => f.workforce.update(f.admin, f.doctor.assignmentId!, 1, {}), /yourself/);
  assert.throws(() =>
    f.workforce.create(f.admin, {
      ...row.data,
      actorId: 'new',
      subject: 'new',
      permissions: ['workforce.manage'],
      role: 'clinician',
    }),
  );
  assert(
    f.store
      .auditEntries(f.doctor.tenant)
      .some(
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
  const token = identity.issue!(f.doctor);
  const a = await identity.select!(token, f.admin.assignmentId!);
  assert.equal(a.role, 'administrator');
  await assert.rejects(identity.select!(token, f.nurse.assignmentId!), /unavailable/);
  const session = await identity.authenticate(token);
  assert.throws(() => f.runtime.get('clinical').chart(session, f.patient.id));
  await identity.select!(token, f.doctor.assignmentId!);
  const nurseToken = identity.issue!(f.nurse),
    row = f.workforce.current(f.nurse);
  f.workforce.update(f.admin, row.id, row.version, {
    permissions: row.data.permissions,
    enabled: false,
    validUntil: row.data.validUntil,
    reason: 'Employment ended',
  });
  await assert.rejects(identity.authenticate(nurseToken), /revoked/);
  assert.throws(() => f.runtime.get('access').check(f.nurse, f.patient.id));
  f.store.db.exec("UPDATE sessions SET lastSeen='2000-01-01T00:00:00.000Z'");
  await assert.rejects(identity.authenticate(token), /expired/);
});

test('protected identity is excluded from every chart surface and emergency access is constrained and reviewed', async (t) => {
  const f = await staffFixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  const access = f.runtime.get('access'),
    review = f.runtime.get('accessReview');
  access.grant(
    f.doctor,
    f.patient.id,
    f.nurse.id,
    'clinician',
    new Date(Date.now() + 86400000).toISOString(),
    'Assigned care',
  );
  review.protect(f.doctor, f.patient.id, f.patient.version, {
    protected: true,
    reason: 'Protected identity verified',
  });
  assert.deepEqual(f.runtime.get('clinical').patients(f.nurse), []);
  const headers = { authorization: `Bearer ${f.runtime.get('identity').issue!(f.nurse)}` };
  for (const url of [
    `/api/patients/${f.patient.id}/chart`,
    `/api/patients/${f.patient.id}/changes`,
    `/api/patients/${f.patient.id}/export/fhir`,
    `/api/records/${f.encounter.id}/history`,
  ])
    assert.equal((await app.inject({ url, headers })).statusCode, 403);
  assert.throws(() => review.emergency(f.nurse, f.patient.id, { reason: 'Urgent' }));
  f.store.grant(
    f.doctor.tenant,
    f.patient.id,
    f.doctor.id,
    'clinician',
    '2000-01-01T00:00:00.000Z',
  );
  const grant = review.emergency(f.doctor, f.patient.id, {
    reason: 'Immediate assessment requested',
  });
  assert(access.allowed(f.doctor, f.patient.id));
  assert.throws(() => access.permit(f.doctor, 'record.write', f.patient.id));
  assert.throws(() => access.permit(f.doctor, 'chart.export', f.patient.id));
  assert(
    !f.runtime
      .get('clinical')
      .chart(f.doctor, f.patient.id)
      .some((r) => r.kind === 'emergencyAccess'),
  );
  const page = review.list(f.reviewer, { limit: 100 });
  const event = page.entries.find((r) => r.action === 'access.emergency-opened')!;
  assert(event);
  assert.equal(event.entityId, grant.id);
  review.review(f.reviewer, {
    seq: event.seq,
    hash: event.hash,
    decision: 'follow-up',
    note: 'Verify the clinical reason with the unit manager',
  });
  assert.equal(
    review.list(f.reviewer, { limit: 100 }).entries.find((r) => r.seq === event.seq)?.reviews
      .length,
    1,
  );
  const own = review.list(f.reviewer, {}).entries.find((r) => r.actor === f.reviewer.id)!;
  assert.throws(() =>
    review.review(f.reviewer, { seq: own.seq, hash: own.hash, decision: 'justified', note: 'Own' }),
  );
  assert.throws(() => review.list(f.doctor, {}));
  f.store.restrict(f.doctor.tenant, f.patient.id, true);
  assert(!access.allowed(f.doctor, f.patient.id));
  assert.throws(() =>
    review.emergency(f.doctor, f.patient.id, { reason: 'Cannot bypass restriction' }),
  );
});

test('audit pagination remains unit-scoped and cannot use the legacy audit bypass', async (t) => {
  const f = await staffFixture(),
    app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    f.runtime.stop();
  });
  const other = f.find('emma', 'clinician', 'other-unit');
  f.store.audit(other, 'outside-unit');
  for (let i = 0; i < 110; i++) f.store.audit(f.doctor, 'chart.test', f.patient.id);
  const review = f.runtime.get('accessReview');
  const first = review.list(f.reviewer, { limit: 40 }),
    second = review.list(f.reviewer, { limit: 40, before: first.nextBefore });
  assert(first.nextBefore);
  assert(second.nextBefore);
  assert(!second.entries.some((e) => first.entries.some((p) => p.seq === e.seq)));
  assert(![...first.entries, ...second.entries].some((e) => e.action === 'outside-unit'));
  const token = f.runtime.get('identity').issue!(f.reviewer);
  assert.equal(
    (await app.inject({ url: '/api/audit', headers: { authorization: `Bearer ${token}` } }))
      .statusCode,
    403,
  );
});

test('AI rechecks current assignment after inference and revoked work is not stored', async (t) => {
  const f = await staffFixture();
  t.after(() => f.runtime.stop());
  const row = f.workforce.current(f.nurse);
  f.runtime
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
    f.workforce.update(f.admin, row.id, row.version, {
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
  assert.equal(f.store.list(f.doctor.tenant, f.patient.id, 'proposal').length, 0);
});

test('revoked assignments survive restart; v2 sessions and single-use login storage persist safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eir-workforce-'));
  try {
    const path = join(dir, 'clinic.sqlite');
    const f = await staffFixture(path);
    const row = f.workforce.current(f.nurse);
    f.workforce.update(f.admin, row.id, row.version, {
      permissions: row.data.permissions,
      enabled: false,
      validUntil: row.data.validUntil,
      reason: 'Revoked',
    });
    f.store.saveLogin('flow', { state: 'test' }, new Date(Date.now() + 60000).toISOString());
    f.runtime.stop();
    const reopened = new SqliteStore(path);
    assert.equal(reopened.get(row.tenant, row.id)?.data.enabled, false);
    assert.deepEqual(reopened.consumeLogin('flow'), { state: 'test' });
    assert.equal(reopened.consumeLogin('flow'), undefined);
    assert(reopened.verifyAudit().ok);
    reopened.db.close();
    const restarted = await fromConfig(root + 'eir.demo.config.json', {
      'eir.storage.sqlite': { path },
      'eir.workforce': demoWorkforce('clinic-a'),
    });
    assert.equal(restarted.runtime.get('store').get(row.tenant, row.id)?.data.enabled, false);
    restarted.runtime.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 migration invalidates old sessions, preserves records and audit, and rejects future schema versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eir-migration-'));
  try {
    const path = join(dir, 'old.sqlite');
    const old = new SqliteStore(path);
    const actor = { id: 'legacy', tenant: 'clinic-a', role: 'clinician' as const };
    old.insert(actor, 'patient', null, { name: 'Synthetic legacy record' });
    old.saveSession('old-session', actor, '2099-01-01T00:00:00.000Z');
    old.db.exec(
      'ALTER TABLE sessions DROP COLUMN lastSeen; DROP TABLE login_transactions; PRAGMA user_version=1;',
    );
    old.db.close();
    const migrated = new SqliteStore(path);
    assert.equal(migrated.session('old-session'), undefined);
    assert.equal(migrated.list(actor.tenant).length, 1);
    assert(migrated.verifyAudit().ok);
    migrated.db.exec('PRAGMA user_version=3;');
    migrated.db.close();
    assert.throws(() => new SqliteStore(path), /newer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
