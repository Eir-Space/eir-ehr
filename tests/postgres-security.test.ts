import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Fault } from '../packages/contracts.ts';
import {
  migratePostgres,
  postgresDataTables,
  postgresMigrations,
  postgresPoolConfig,
} from '../packages/postgres-migrations.ts';
import { identifier, postgresFixture, postgresTestOptions } from './postgres-helpers.ts';

const denied = (error: any) => error.code === '42501';

test('postgres: TLS is verified by default and plaintext is explicitly loopback-only', () => {
  const key = 'EIR_POSTGRES_SECURITY_CONFIG_TEST';
  try {
    process.env[key] = 'postgresql://runtime:synthetic@db.example.invalid/ehr?sslmode=require';
    const config = postgresPoolConfig({ connectionStringEnv: key });
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.ok(!config.connectionString?.includes('sslmode'));
    assert.throws(
      () => postgresPoolConfig({ connectionStringEnv: key, localDevelopmentOnly: true }),
      /loopback/,
    );
    for (const option of [
      'sslmode=disable',
      'sslmode=no-verify',
      'sslrootcert=x',
      'host=127.0.0.1',
      'options=-c%20role%3Dpostgres',
    ]) {
      process.env[key] = `postgresql://runtime:synthetic@127.0.0.1/ehr?${option}`;
      assert.throws(() => postgresPoolConfig({ connectionStringEnv: key }), /TLS verification/);
    }
    process.env[key] = 'postgresql://runtime:synthetic@127.0.0.1/ehr?sslmode=disable';
    assert.equal(
      postgresPoolConfig({ connectionStringEnv: key, localDevelopmentOnly: true }).ssl,
      false,
    );
    process.env[key] = 'not a url containing synthetic-secret';
    assert.throws(
      () => postgresPoolConfig({ connectionStringEnv: key }),
      (error: any) => !error.message.includes('synthetic-secret'),
    );
  } finally {
    delete process.env[key];
  }
});

test(
  'postgres: raw SQL RLS protects every data table, sessions/login included, despite tenant reset attempts',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open(),
      b = await f.open(f.configB);
    const pa = await a.insert(f.actorA, 'patient', null, { name: 'Synthetic A' });
    const pb = await b.insert(f.actorB, 'patient', null, { name: 'Synthetic B' });
    const expires = '2099-01-01T00:00:00.000Z';
    for (const [store, actor, patient] of [
      [a, f.actorA, pa],
      [b, f.actorB, pb],
    ] as const) {
      await store.grant(actor.tenant, patient.id, 'proxy', 'proxy', expires);
      await store.restrict(actor.tenant, patient.id, true);
      await store.saveSession('same-session', actor, expires);
      await store.saveLogin('same-login', { nonce: actor.tenant }, expires);
    }
    await assert.rejects(
      a.get(f.actorB.tenant, pb.id),
      (e: any) => e instanceof Fault && e.status === 403,
    );
    await assert.rejects(
      a.saveSession('forged', f.actorB, expires),
      (e: any) => e instanceof Fault && e.status === 403,
    );
    const raw = await f.raw();
    const assertScope = async () => {
      for (const table of postgresDataTables) {
        const { rows } = await raw.query(`SELECT * FROM eir.${table}`);
        assert.ok(rows.length > 0, `seeded ${table}`);
        assert.ok(
          rows.every((row) => row.tenant === f.actorA.tenant),
          `RLS on ${table}`,
        );
      }
    };
    await assertScope();
    await raw.query(
      "SET app.tenant = 'tenant-b'; SET app.current_tenant = 'tenant-b'; SET eir.tenant = 'tenant-b'",
    );
    await assertScope();
    await raw.query('RESET ALL; SET ROLE NONE; RESET ROLE');
    await assertScope();
    await assert.rejects(raw.query(`SET ROLE ${identifier(f.roleB)}`), denied);
    await assert.rejects(raw.query(`SET SESSION AUTHORIZATION ${identifier(f.roleB)}`), denied);
    await raw.query('SET row_security = off');
    await assert.rejects(raw.query('SELECT * FROM eir.entities'), denied);
    await raw.query('RESET row_security');
    await assertScope();
    for (const sql of [
      "UPDATE eir.tenant_roles SET tenant = 'tenant-b'",
      "INSERT INTO eir.tenant_roles VALUES (current_user, 'tenant-b')",
      "UPDATE eir.audit_heads SET hash = 'GENESIS'",
      'ALTER TABLE eir.sessions DISABLE ROW LEVEL SECURITY',
      'CREATE TABLE eir.bypass (id text)',
      "UPDATE eir.schema_migrations SET checksum = 'forged'",
    ])
      await assert.rejects(raw.query(sql), denied);
    await assert.rejects(
      raw.query(`INSERT INTO eir.entities
    (tenant, id, patient_id, kind, version, created_at, updated_at, data)
    VALUES ('tenant-b', 'forged', 'forged', 'patient', 1, 'now', 'now', '{}')`),
      denied,
    );
    await assert.rejects(
      raw.query(
        'INSERT INTO eir.sessions (tenant, hash, actor, expires, last_seen) VALUES ($1, $2, $3, $4, $4)',
        ['tenant-b', 'forged', JSON.stringify(f.actorB), expires],
      ),
      denied,
    );
    await assert.rejects(
      raw.query("INSERT INTO eir.login_transactions VALUES ('tenant-b', 'forged', '{}', $1)", [
        expires,
      ]),
      denied,
    );
    await assert.rejects(
      raw.query('INSERT INTO eir.audit (tenant, body) VALUES ($1, $2)', [
        'tenant-b',
        JSON.stringify({ tenant: 'tenant-b' }),
      ]),
      denied,
    );
    await assert.rejects(
      raw.query('INSERT INTO eir.versions (tenant, id, version, snapshot) VALUES ($1, $2, 2, $3)', [
        'tenant-b',
        pb.id,
        JSON.stringify({ ...pb, version: 2 }),
      ]),
      denied,
    );
    await assert.rejects(
      raw.query('INSERT INTO eir.grants VALUES ($1, $2, $3, $4, $5)', [
        'tenant-a',
        pb.id,
        'forged',
        'proxy',
        expires,
      ]),
      (e: any) => e.code === '23503',
    );
    for (const table of ['sessions', 'login_transactions']) {
      assert.equal(
        (await raw.query(`DELETE FROM eir.${table} WHERE tenant = 'tenant-b'`)).rowCount,
        0,
      );
      assert.equal(
        (await raw.query(`UPDATE eir.${table} SET expires = '2000' WHERE tenant = 'tenant-b'`))
          .rowCount,
        0,
      );
    }
    assert.equal((await b.session('same-session'))?.actor.tenant, 'tenant-b');
    assert.deepEqual(await b.consumeLogin('same-login'), { nonce: 'tenant-b' });
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 1 });
    assert.deepEqual(await b.verifyAudit(), { ok: true, count: 1 });
  },
);

test(
  'postgres: startup rejects tenant mismatch, privileged or inherited roles, unsafe grants, and missing RLS',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    await assert.rejects(f.open({ ...f.configA, tenant: 'tenant-b' }), /configured tenant/);
    await assert.rejects(
      f.open({ ...f.configA, connectionStringEnv: f.adminEnv }),
      /restricted nonowner/,
    );
    await f.admin.query(`GRANT ${identifier(f.roleB)} TO ${identifier(f.roleA)}`);
    await assert.rejects(f.open(), /without role memberships/);
    await f.admin.query(`REVOKE ${identifier(f.roleB)} FROM ${identifier(f.roleA)}`);
    await f.admin.query(`ALTER ROLE ${identifier(f.roleA)} BYPASSRLS`);
    await assert.rejects(f.open(), /restricted nonowner/);
    await f.admin.query(`ALTER ROLE ${identifier(f.roleA)} NOBYPASSRLS`);
    await f.admin.query(`GRANT UPDATE ON eir.audit TO ${identifier(f.roleA)}`);
    await assert.rejects(f.open(), /unsafe mutation privileges/);
    await f.admin.query(`REVOKE UPDATE ON eir.audit FROM ${identifier(f.roleA)}`);
    await f.admin.query('ALTER TABLE eir.login_transactions DISABLE ROW LEVEL SECURITY');
    await assert.rejects(f.open(), /row-level security/);
    await f.admin.query('ALTER TABLE eir.login_transactions ENABLE ROW LEVEL SECURITY');
    const store = await f.open();
    await store.health();
  },
);

test(
  'postgres: migration lock is idempotent and failed provisioning rolls DDL and ledger back',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture({ migrate: false });
    t.after(f.cleanup);
    const adminRole = (await f.admin.query('SELECT current_user AS role')).rows[0].role;
    await assert.rejects(
      migratePostgres(f.admin, { tenant: 'tenant-a', runtimeRole: adminRole }),
      /restricted nonowner/,
    );
    assert.equal(
      (await f.admin.query("SELECT to_regnamespace('eir') AS schema")).rows[0].schema,
      null,
    );
    await Promise.all([
      migratePostgres(f.admin, { tenant: 'tenant-a', runtimeRole: f.roleA }),
      migratePostgres(f.admin, { tenant: 'tenant-b', runtimeRole: f.roleB }),
    ]);
    assert.equal(
      (await f.admin.query('SELECT * FROM eir.schema_migrations')).rowCount,
      postgresMigrations.length,
    );
    assert.equal((await f.admin.query('SELECT * FROM eir.tenant_roles')).rowCount, 2);
    await assert.rejects(
      migratePostgres(f.admin, { tenant: 'tenant-b', runtimeRole: f.roleA }),
      /cannot be remapped/,
    );
    const store = await f.open();
    await store.health();
  },
);

test(
  'postgres: future, corrupt, and missing migrations fail closed without runtime migration',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    await f.admin.query(
      "INSERT INTO eir.schema_migrations VALUES (999, 'future', 'unknown', now())",
    );
    await assert.rejects(f.open(), /newer than application/);
    await assert.rejects(migratePostgres(f.admin), /newer than application/);
    await f.admin.query('DELETE FROM eir.schema_migrations WHERE version = 999');
    await f.admin.query("UPDATE eir.schema_migrations SET checksum = 'corrupt' WHERE version = 1");
    await assert.rejects(f.open(), /checksum mismatch/);
    await assert.rejects(migratePostgres(f.admin), /checksum mismatch/);
    await f.admin.query('UPDATE eir.schema_migrations SET checksum = $1 WHERE version = 1', [
      postgresMigrations[0].checksum,
    ]);
    await f.admin.query('DELETE FROM eir.schema_migrations');
    await assert.rejects(f.open(), /migrations are pending/);
    assert.equal((await f.admin.query('SELECT * FROM eir.schema_migrations')).rowCount, 0);
  },
);

test(
  'postgres: audit tampering and tail deletion are detected at restart',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const a = await f.open();
    await a.audit(f.actorA, 'synthetic.test');
    await a.close();
    await assert.rejects(
      f.admin.query('UPDATE eir.audit SET body = body'),
      (e: any) => e.code === '23514',
    );
    await assert.rejects(f.admin.query('TRUNCATE eir.audit'), (e: any) => e.code === '23514');
    const original = (await f.admin.query('SELECT body FROM eir.audit')).rows[0].body;
    await f.admin.query('ALTER TABLE eir.audit DISABLE TRIGGER audit_append_only');
    await f.admin.query(
      "UPDATE eir.audit SET body = jsonb_set(body::jsonb, '{action}', '\"tampered\"')::text",
    );
    await assert.rejects(f.open(), /audit verification failed/);
    await f.admin.query('UPDATE eir.audit SET body = $1', [original]);
    await f.admin.query('DELETE FROM eir.audit');
    await assert.rejects(f.open(), /audit verification failed/);
  },
);

test(
  'postgres: non-superuser operator-owned migrations and audit trigger work with forced RLS',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture({ migrate: false });
    t.after(f.cleanup);
    const db = (await f.admin.query('SELECT current_database() AS name')).rows[0].name;
    await f.admin.query(`GRANT CREATE ON DATABASE ${identifier(db)} TO ${identifier(f.roleB)}`);
    const operator = new pg.Pool(postgresPoolConfig(f.configB));
    try {
      await migratePostgres(operator, { tenant: 'tenant-a', runtimeRole: f.roleA });
    } finally {
      await operator.end();
    }
    const a = await f.open();
    await a.insert(f.actorA, 'patient', null, { name: 'Synthetic operator fixture' });
    assert.deepEqual(await a.verifyAudit(), { ok: true, count: 1 });
  },
);
