import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Actor } from '../packages/contracts.ts';
import { migratePostgres, postgresPoolConfig } from '../packages/postgres-migrations.ts';
import { PostgresStore, type PostgresStoreConfig } from '../plugins/storage-postgres.ts';

export const postgresEnabled = !!process.env.EIR_TEST_POSTGRES_URL;
export const postgresTestOptions = { skip: !postgresEnabled, timeout: 60_000 };
export const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export async function dropTestDatabase(
  pool: pg.Pool,
  name: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (!/^eir_(?:test|recovery)_[a-f0-9]+$/.test(name))
    throw new Error('Only uniquely named EIR fixture databases may be dropped');
  const deadline = Date.now() + timeoutMs;
  // pg-pool can resolve end() before its client.end callbacks run. A forced DROP
  // races those socket closes and delivers an asynchronous 57P01 to closing clients.
  for (;;) {
    const { rows } = await pool.query(
      'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    if (rows[0].connections === 0) break;
    if (Date.now() >= deadline)
      throw new Error(
        `PostgreSQL fixture connection leak: ${name} still has ${rows[0].connections} connection(s)`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // A new connection after the drain is a test failure, never something to kill silently.
  await pool.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
}

// The supplied URL must be an isolated administrative test database. Each fixture creates
// and drops its own database and two login roles; no existing application's schema is used.
export async function postgresFixture(options: { migrate?: boolean } = {}) {
  const source = process.env.EIR_TEST_POSTGRES_URL;
  if (!source) throw new Error('EIR_TEST_POSTGRES_URL is required for real PostgreSQL tests');
  const url = new URL(source);
  const localDevelopmentOnly = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const suffix = randomBytes(8).toString('hex');
  const database = `eir_test_${suffix}`;
  const roleA = `eir_a_${suffix}`,
    roleB = `eir_b_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const envs: string[] = [];
  const setUrl = (key: string, value: URL) => {
    envs.push(key);
    process.env[key] = value.toString();
    return key;
  };
  const root = new pg.Pool(
    postgresPoolConfig({ connectionStringEnv: 'EIR_TEST_POSTGRES_URL', localDevelopmentOnly }),
  );
  const stores: PostgresStore[] = [],
    clients: pg.Client[] = [];
  let admin: pg.Pool | undefined;
  const cleanup = async () => {
    for (const store of stores) await store.close();
    for (const client of clients) await client.end();
    await admin?.end();
    try {
      await dropTestDatabase(root, database);
      await root.query(`DROP ROLE IF EXISTS ${identifier(roleA)}`);
      await root.query(`DROP ROLE IF EXISTS ${identifier(roleB)}`);
    } finally {
      await root.end();
      for (const key of envs) delete process.env[key];
    }
  };
  try {
    await root.query(`CREATE DATABASE ${identifier(database)}`);
    for (const role of [roleA, roleB])
      await root.query(`CREATE ROLE ${identifier(role)}
      LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    const adminUrl = new URL(url);
    adminUrl.pathname = '/' + database;
    const adminEnv = setUrl(`EIR_PG_ADMIN_${suffix}`, adminUrl);
    admin = new pg.Pool(
      postgresPoolConfig({ connectionStringEnv: adminEnv, localDevelopmentOnly }),
    );
    const makeConfig = (role: string, tenant: string): PostgresStoreConfig => {
      const runtimeUrl = new URL(adminUrl);
      runtimeUrl.username = role;
      runtimeUrl.password = password;
      return {
        tenant,
        localDevelopmentOnly,
        connectionStringEnv: setUrl(`EIR_PG_${role}`, runtimeUrl),
      };
    };
    const configA = makeConfig(roleA, 'tenant-a'),
      configB = makeConfig(roleB, 'tenant-b');
    if (options.migrate !== false) {
      await migratePostgres(admin, { tenant: configA.tenant, runtimeRole: roleA });
      await migratePostgres(admin, { tenant: configB.tenant, runtimeRole: roleB });
    }
    const open = async (config = configA) => {
      const store = await PostgresStore.open(config);
      stores.push(store);
      return store;
    };
    const raw = async (config = configA) => {
      const client = new pg.Client(postgresPoolConfig(config));
      await client.connect();
      clients.push(client);
      return client;
    };
    const actorA: Actor = {
      id: 'synthetic-doctor-a',
      tenant: 'tenant-a',
      role: 'clinician',
      unitId: 'unit-a',
      assignmentId: 'assignment-a',
    };
    const actorB: Actor = {
      id: 'synthetic-doctor-b',
      tenant: 'tenant-b',
      role: 'clinician',
      unitId: 'unit-b',
    };
    return {
      admin,
      root,
      adminEnv,
      roleA,
      roleB,
      configA,
      configB,
      actorA,
      actorB,
      open,
      raw,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function barrier(parties = 2): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrived === parties) release();
    await ready;
  };
}
