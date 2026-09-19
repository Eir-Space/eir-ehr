import test from 'node:test';
import assert from 'node:assert/strict';
import { Fault } from '../packages/contracts.ts';
import { barrier, postgresFixture, postgresTestOptions } from './postgres-helpers.ts';

const conflict = (error: unknown) => error instanceof Fault && error.status === 409;

test(
  'postgres: Store contract survives restart, with scoped sessions and one-use login state',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      b = await f.open(f.configB);
    const patient = await a.insert(f.actorA, 'patient', null, {
      name: 'Synthetic',
      identifier: { system: 'test', value: '001' },
    });
    assert.deepEqual(await a.get(f.actorA.tenant, patient.id), patient);
    assert.equal((await a.list(f.actorA.tenant, undefined, 'patient')).length, 1);
    const revised = await a.revise(
      f.actorA,
      { ...patient, patientId: 'untrusted' },
      1,
      { name: 'Synthetic revised' },
      'patient.updated',
    );
    assert.equal(revised.patientId, patient.id);
    assert.deepEqual(await a.history(f.actorA.tenant, patient.id), [patient, revised]);
    const changes = await a.changes(f.actorA.tenant, patient.id, 0);
    assert.deepEqual(
      changes.map((row) => row.record),
      [patient, revised],
    );
    assert.equal((await a.changes(f.actorA.tenant, patient.id, changes[0].cursor)).length, 1);
    const expires = new Date(Date.now() + 60_000).toISOString();
    await a.grant(f.actorA.tenant, patient.id, 'synthetic-proxy', 'proxy', expires);
    assert.deepEqual(await a.getGrant(f.actorA.tenant, patient.id, 'synthetic-proxy'), {
      role: 'proxy',
      expires,
    });
    await a.restrict(f.actorA.tenant, patient.id, true);
    assert.equal(await a.isBlocked(f.actorA.tenant, patient.id), true);
    await a.saveSession('same-hash', f.actorA, expires);
    await b.saveSession('same-hash', f.actorB, expires);
    await a.updateSession('same-hash', { ...f.actorA, assignmentId: 'new-assignment' });
    assert.equal((await a.session('same-hash'))?.actor.assignmentId, 'new-assignment');
    assert.deepEqual((await b.session('same-hash'))?.actor, f.actorB);
    await a.saveLogin('same-login', { nonce: 'nonce-a' }, expires);
    await b.saveLogin('same-login', { nonce: 'nonce-b' }, expires);
    assert.deepEqual(await a.consumeLogin('same-login'), { nonce: 'nonce-a' });
    assert.equal(await a.consumeLogin('same-login'), undefined);
    assert.deepEqual(await b.consumeLogin('same-login'), { nonce: 'nonce-b' });
    await a.saveLogin('expired', { nonce: 'expired' }, '2000-01-01T00:00:00.000Z');
    assert.equal(await a.consumeLogin('expired'), undefined);
    await a.audit(f.actorA, 'chart.read', patient.id, undefined, 'denied');
    const page = await a.auditPage(f.actorA.tenant, {
      unitId: 'unit-a',
      limit: 1,
      outcome: 'denied',
      actorId: f.actorA.id,
      patientId: patient.id,
    });
    assert.equal(page.length, 1);
    assert.equal(page[0].tenant, f.actorA.tenant);
    assert.deepEqual(await a.auditEntry(f.actorA.tenant, page[0].seq), page[0]);
    assert.equal(
      (await a.auditPage(f.actorA.tenant, { unitId: 'unit-a', limit: 10, before: page[0].seq }))
        .length,
      2,
    );
    assert.equal((await a.auditEntries(f.actorA.tenant, patient.id)).length, 3);
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 3 });
    await a.health();
    await a.close();
    await a.close();
    await assert.rejects(a.health(), (error: any) => error.status === 503);
    const restarted = await f.open();
    assert.deepEqual(await restarted.get(f.actorA.tenant, patient.id), revised);
    assert.equal((await restarted.session('same-hash'))?.actor.assignmentId, 'new-assignment');
    await restarted.revokeSession('same-hash');
    assert.equal(await restarted.session('same-hash'), undefined);
    assert.deepEqual((await b.session('same-hash'))?.actor, f.actorB);
    assert.deepEqual(await restarted.verifyAudit(), { ok: true, count: 3 });
  },
);

test(
  'postgres: independent clients reject stale CAS and preserve signed notes',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      other = await f.open();
    const note = await a.insert(f.actorA, 'note', null, {
      status: 'draft',
      text: 'Synthetic note',
    });
    const stale = (await other.get(f.actorA.tenant, note.id))!;
    const signed = await a.revise(
      f.actorA,
      note,
      note.version,
      { status: 'signed', text: 'Synthetic note' },
      'note.signed',
    );
    let casCalls = 0;
    await assert.rejects(
      other.transaction(async () => {
        casCalls++;
        return other.revise(
          f.actorA,
          stale,
          stale.version,
          { status: 'draft', text: 'Stale' },
          'note.updated',
        );
      }),
      conflict,
    );
    assert.equal(casCalls, 1, 'stale CAS must not replay the callback');
    await assert.rejects(
      other.revise(f.actorA, signed, signed.version, { status: 'draft' }, 'note.updated'),
      conflict,
    );
    const raw = await f.raw();
    await assert.rejects(
      raw.query(
        'UPDATE eir.entities SET data = \'{"status":"draft"}\', version = version + 1 WHERE id = $1',
        [note.id],
      ),
      (e: any) => e.code === '23514',
    );
    for (const sql of [
      'UPDATE eir.versions SET snapshot = snapshot',
      'DELETE FROM eir.versions',
      'TRUNCATE eir.versions',
      'UPDATE eir.audit SET body = body',
      'DELETE FROM eir.audit',
      'TRUNCATE eir.audit',
      'DELETE FROM eir.entities',
    ])
      await assert.rejects(raw.query(sql), (e: any) => e.code === '42501');
    assert.deepEqual(await other.get(f.actorA.tenant, note.id), signed);
    assert.equal((await other.history(f.actorA.tenant, note.id)).length, 2);
    assert.deepEqual(await other.verifyAudit(), { ok: true, count: 2 });
  },
);

test(
  'postgres: nested transactions join and caught failures leave the entire transaction rollback-only',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open();
    await assert.rejects(
      a.transaction(async () => {
        await a.insert(f.actorA, 'patient', null, { name: 'Rolled back' });
        try {
          await a.transaction(async () => {
            await a.saveSession('rolled-back', f.actorA, '2099-01-01T00:00:00.000Z');
            throw new Error('nested failure');
          });
        } catch {
          /* Caller cannot rescue a failed nested transaction. */
        }
      }),
      /nested failure/,
    );
    assert.deepEqual(await a.list(f.actorA.tenant), []);
    assert.equal(await a.session('rolled-back'), undefined);
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 0 });
    await a.transaction(async () => {
      await a.transaction(async () => {
        await a.insert(f.actorA, 'patient', null, { name: 'Committed' });
      });
      await Promise.all(Array.from({ length: 8 }, (_, i) => a.audit(f.actorA, `test.${i}`)));
    });
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 9 });
  },
);

test(
  'postgres: audit failure rolls back standalone insert and revision including version and head',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open();
    const entity = await a.insert(f.actorA, 'patient', null, { name: 'Before failure' });
    await f.admin
      .query(`CREATE FUNCTION eir.inject_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic-secret-must-not-leak' USING DETAIL = 'synthetic-sensitive-value'; END; $$;
    CREATE TRIGGER zz_audit_failure BEFORE INSERT ON eir.audit FOR EACH ROW EXECUTE FUNCTION eir.inject_audit_failure();`);
    const safeError = (error: any) =>
      error instanceof Fault &&
      error.status === 503 &&
      !JSON.stringify(error).includes('synthetic');
    await assert.rejects(
      a.insert(f.actorA, 'patient', null, { name: 'Should not exist' }),
      safeError,
    );
    await assert.rejects(
      a.revise(f.actorA, entity, 1, { name: 'Should not change' }, 'patient.updated'),
      safeError,
    );
    assert.deepEqual(await a.list(f.actorA.tenant), [entity]);
    assert.deepEqual(await a.history(f.actorA.tenant, entity.id), [entity]);
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 1 });
    await f.admin.query('DROP TRIGGER zz_audit_failure ON eir.audit');
    await a.audit(f.actorA, 'recovered');
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 2 });
  },
);

test(
  'postgres: serializable clinical predicate race admits only one writer across independent pools',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      b = await f.open();
    const ready = barrier();
    const book = (store: typeof a) =>
      store.transaction(async () => {
        const appointments = await store.list(f.actorA.tenant, undefined, 'appointment');
        if (appointments.length) throw new Fault(409, 'Appointment slot no longer available');
        await ready();
        return store.insert(f.actorA, 'appointment', null, { slot: 'synthetic-exclusive-slot' });
      });
    const results = await Promise.allSettled([book(a), book(b)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && conflict(r.reason)).length, 1);
    assert.equal((await a.list(f.actorA.tenant, undefined, 'appointment')).length, 1);
    assert.deepEqual(await b.verifyAudit(), { ok: true, count: 1 });
  },
);

test(
  'postgres: database deadlocks replay whole transactions and concurrent audit writers keep one chain',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      b = await f.open();
    const patient1 = await a.insert(f.actorA, 'patient', null, {});
    const patient2 = await a.insert(f.actorA, 'patient', null, {});
    const expires = '2099-01-01T00:00:00.000Z';
    for (const patient of [patient1, patient2])
      await a.grant(f.actorA.tenant, patient.id, 'proxy', 'proxy', expires);
    const ready = barrier();
    let attempts = 0;
    const write = (store: typeof a, first: string, second: string) =>
      store.transaction(async () => {
        attempts++;
        await store.grant(f.actorA.tenant, first, 'proxy', 'clinician', expires);
        await ready();
        await store.grant(f.actorA.tenant, second, 'proxy', 'clinician', expires);
      });
    const results = await Promise.allSettled([
      write(a, patient1.id, patient2.id),
      write(b, patient2.id, patient1.id),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.ok(attempts >= 3, 'the deadlocked callback must replay');
    await Promise.all([a.audit(f.actorA, 'client.a'), b.audit(f.actorA, 'client.b')]);
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 4 });
  },
);

test(
  'postgres: parallel independent inserts and audited chart reads succeed without caller retries',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      b = await f.open();
    const patients = await Promise.all([
      a.insert(f.actorA, 'patient', null, { name: 'One' }),
      b.insert(f.actorA, 'patient', null, { name: 'Two' }),
    ]);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const store = i % 2 ? a : b;
        return store.transaction(async () => {
          assert.equal((await store.list(f.actorA.tenant, patients[i % 2].id)).length, 1);
          await store.audit(f.actorA, 'chart.read', patients[i % 2].id);
        });
      }),
    );
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 10 });
  },
);

test(
  'postgres: persistent serialization failure is bounded and surfaces Fault409 without partial writes',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open();
    await f.admin
      .query(`CREATE FUNCTION eir.inject_serialization_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced serialization failure' USING ERRCODE = '40001'; END; $$;
    CREATE TRIGGER zz_serialization_failure BEFORE INSERT ON eir.audit FOR EACH ROW EXECUTE FUNCTION eir.inject_serialization_failure();`);
    let attempts = 0;
    await assert.rejects(
      a.transaction(async () => {
        attempts++;
        await a.insert(f.actorA, 'patient', null, { name: 'Must roll back every attempt' });
      }),
      conflict,
    );
    assert.equal(attempts, 4, 'one initial attempt plus at most three retries');
    assert.deepEqual(await a.list(f.actorA.tenant), []);
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 0 });
  },
);
