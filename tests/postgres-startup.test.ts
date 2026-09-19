import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresDataTables } from '../packages/postgres-migrations.ts';
import { identifier, postgresFixture, postgresTestOptions } from './postgres-helpers.ts';

test(
  'postgres: startup rejects effective column-only mutation privileges on protected metadata and evidence',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    const cases = [
      { table: 'tenant_roles', columns: 'tenant', privilege: 'UPDATE', grantee: role },
      {
        table: 'tenant_roles',
        columns: 'runtime_role, tenant',
        privilege: 'INSERT',
        grantee: role,
      },
      { table: 'tenant_roles', columns: 'tenant', privilege: 'UPDATE', grantee: 'PUBLIC' },
      { table: 'schema_migrations', columns: 'checksum', privilege: 'UPDATE', grantee: role },
      {
        table: 'schema_migrations',
        columns: 'version, name, checksum',
        privilege: 'INSERT',
        grantee: role,
      },
      { table: 'audit_heads', columns: 'hash', privilege: 'UPDATE', grantee: role },
      { table: 'audit_heads', columns: 'tenant', privilege: 'INSERT', grantee: role },
      { table: 'audit', columns: 'body', privilege: 'UPDATE', grantee: role },
      { table: 'versions', columns: 'snapshot', privilege: 'UPDATE', grantee: role },
    ];
    for (const { table, columns, privilege, grantee } of cases) {
      await f.admin.query(`GRANT ${privilege} (${columns}) ON eir.${table} TO ${grantee}`);
      try {
        const { rows } = await f.admin.query(
          `SELECT
        has_table_privilege($1::name, $2, $3) AS table_grant,
        has_any_column_privilege($1::name, $2, $3) AS column_grant`,
          [f.roleA, `eir.${table}`, privilege],
        );
        assert.equal(
          rows[0].table_grant,
          false,
          'table-level checks alone cannot detect this grant',
        );
        assert.equal(rows[0].column_grant, true);
        await assert.rejects(
          f.open(),
          /unsafe mutation privileges|alter tenant or migration metadata/,
        );
      } finally {
        await f.admin.query(`REVOKE ${privilege} (${columns}) ON eir.${table} FROM ${grantee}`);
      }
    }
    await (await f.open()).health();
  },
);

test(
  'postgres: startup rejects TRUNCATE privileges on every data table including access and login state',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    for (const table of [...postgresDataTables, 'schema_migrations']) {
      await f.admin.query(`GRANT TRUNCATE ON eir.${table} TO ${role}`);
      try {
        await assert.rejects(f.open(), /unsafe mutation privileges/);
      } finally {
        await f.admin.query(`REVOKE TRUNCATE ON eir.${table} FROM ${role}`);
      }
    }
    await f.admin.query('GRANT TRUNCATE ON eir.sessions TO PUBLIC');
    try {
      await assert.rejects(f.open(), /unsafe mutation privileges/);
    } finally {
      await f.admin.query('REVOKE TRUNCATE ON eir.sessions FROM PUBLIC');
    }
    await (await f.open()).health();
  },
);

test(
  'postgres: startup rejects permission to disable integrity triggers through session_replication_role',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    for (const privilege of ['SET', 'ALTER SYSTEM']) {
      await f.admin.query(`GRANT ${privilege} ON PARAMETER session_replication_role TO ${role}`);
      try {
        await assert.rejects(f.open(), /can disable integrity triggers/);
        if (privilege === 'SET') {
          const client = await f.raw();
          await client.query("SET session_replication_role = 'replica'");
          assert.equal(
            (await client.query('SHOW session_replication_role')).rows[0].session_replication_role,
            'replica',
          );
          await client.query('RESET session_replication_role');
        }
      } finally {
        await f.admin.query(
          `REVOKE ${privilege} ON PARAMETER session_replication_role FROM ${role}`,
        );
      }
    }
    await (await f.open()).health();
  },
);

test(
  'postgres: startup rejects unsafe effective, role, and database replication-role defaults',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    const db = identifier((await f.admin.query('SELECT current_database() AS name')).rows[0].name);
    await f.admin.query(`ALTER ROLE ${role} SET session_replication_role = 'replica'`);
    try {
      await assert.rejects(f.open(), /integrity triggers must remain enabled/);
    } finally {
      await f.admin.query(`ALTER ROLE ${role} RESET session_replication_role`);
    }
    await f.admin.query(`ALTER DATABASE ${db} SET session_replication_role = 'replica'`);
    try {
      await assert.rejects(f.open(), /integrity triggers must remain enabled/);
      await f.admin.query(`ALTER ROLE ${role} SET session_replication_role = 'origin'`);
      try {
        const client = await f.raw();
        assert.equal(
          (await client.query('SHOW session_replication_role')).rows[0].session_replication_role,
          'origin',
        );
        await assert.rejects(f.open(), /integrity triggers must remain enabled/);
      } finally {
        await f.admin.query(`ALTER ROLE ${role} RESET session_replication_role`);
      }
    } finally {
      await f.admin.query(`ALTER DATABASE ${db} RESET session_replication_role`);
    }
    await f.admin.query(
      `ALTER ROLE ${role} IN DATABASE ${db} SET session_replication_role = 'replica'`,
    );
    try {
      await assert.rejects(f.open(), /integrity triggers must remain enabled/);
    } finally {
      await f.admin.query(`ALTER ROLE ${role} IN DATABASE ${db} RESET session_replication_role`);
    }
    await (await f.open()).health();
  },
);

test(
  'postgres: startup rejects extra permissive policies despite valid migration checksums and RLS flags',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    for (const table of postgresDataTables) {
      await f.admin.query(
        `CREATE POLICY review_bypass ON eir.${table} FOR SELECT TO ${role} USING (true)`,
      );
      try {
        await assert.rejects(f.open(), /policy definitions do not match migrations/);
      } finally {
        await f.admin.query(`DROP POLICY review_bypass ON eir.${table}`);
      }
    }
    await (await f.open()).health();
  },
);

test(
  'postgres: startup validates policy predicates, roles, command scopes, and permissiveness',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const role = identifier(f.roleA);
    const owner = identifier((await f.admin.query('SELECT current_user AS role')).rows[0].role);
    const predicate =
      'tenant = (SELECT tenant FROM eir.tenant_roles WHERE runtime_role = current_user)';
    const cases = [
      {
        alter: 'ALTER POLICY tenant_scope ON eir.entities USING (true)',
        restore: `ALTER POLICY tenant_scope ON eir.entities USING (${predicate})`,
      },
      {
        alter: 'ALTER POLICY tenant_scope ON eir.entities WITH CHECK (true)',
        restore: `ALTER POLICY tenant_scope ON eir.entities WITH CHECK (${predicate})`,
      },
      {
        alter: 'ALTER POLICY tenant_scope ON eir.tenant_roles USING (true)',
        restore:
          'ALTER POLICY tenant_scope ON eir.tenant_roles USING (runtime_role = current_user)',
      },
      {
        alter: `ALTER POLICY tenant_scope ON eir.entities TO ${role}`,
        restore: 'ALTER POLICY tenant_scope ON eir.entities TO PUBLIC',
      },
      {
        alter: 'ALTER POLICY operator_access ON eir.entities TO PUBLIC',
        restore: `ALTER POLICY operator_access ON eir.entities TO ${owner}`,
      },
      {
        alter: `ALTER POLICY operator_access ON eir.entities TO ${owner}, ${role}`,
        restore: `ALTER POLICY operator_access ON eir.entities TO ${owner}`,
      },
    ];
    for (const { alter, restore } of cases) {
      await f.admin.query(alter);
      try {
        await assert.rejects(f.open(), /policy definitions do not match migrations/);
      } finally {
        await f.admin.query(restore);
      }
    }
    for (const scope of ['AS RESTRICTIVE', 'FOR SELECT']) {
      await f.admin.query('DROP POLICY tenant_scope ON eir.entities');
      await f.admin.query(
        `CREATE POLICY tenant_scope ON eir.entities ${scope} USING (${predicate})`,
      );
      try {
        await assert.rejects(f.open(), /policy definitions do not match migrations/);
      } finally {
        await f.admin.query('DROP POLICY tenant_scope ON eir.entities');
        await f.admin.query(
          `CREATE POLICY tenant_scope ON eir.entities USING (${predicate}) WITH CHECK (${predicate})`,
        );
      }
    }
    // A caller-controlled search path must not change canonical policy verification.
    await f.admin.query(`ALTER ROLE ${role} SET search_path = eir, public`);
    try {
      await (await f.open()).health();
    } finally {
      await f.admin.query(`ALTER ROLE ${role} RESET search_path`);
    }
  },
);
