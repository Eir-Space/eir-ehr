import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Fault } from '../packages/contracts.ts';
import { postgresPoolConfig } from '../packages/postgres-migrations.ts';
import {
  dropTestDatabase,
  identifier,
  postgresFixture,
  postgresTestOptions,
} from './postgres-helpers.ts';

test(
  'postgres: fixture drop reports live connections and never terminates them',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    const name = `eir_recovery_${randomBytes(8).toString('hex')}`;
    const config = postgresPoolConfig({
      connectionStringEnv: f.adminEnv,
      localDevelopmentOnly: f.configA.localDevelopmentOnly,
    });
    const url = new URL(config.connectionString!);
    url.pathname = '/' + name;
    const client = new pg.Client({ ...config, connectionString: url.toString() });
    const errors: Error[] = [];
    client.on('error', (error) => {
      errors.push(error);
    });
    t.after(async () => {
      await client.end();
      await dropTestDatabase(f.root, name);
      await f.cleanup();
      assert.deepEqual(errors, [], 'no asynchronous disconnect errors may be discarded');
    });
    await f.root.query(`CREATE DATABASE ${identifier(name)}`);
    await client.connect();
    await assert.rejects(dropTestDatabase(f.root, name, 50), /connection leak/);
    assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
  },
);

test(
  'postgres: pool shutdown followed by fixture drop drains sockets without forced disconnections',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    const name = `eir_recovery_${randomBytes(8).toString('hex')}`;
    const config = postgresPoolConfig({
      connectionStringEnv: f.adminEnv,
      localDevelopmentOnly: f.configA.localDevelopmentOnly,
    });
    const url = new URL(config.connectionString!);
    url.pathname = '/' + name;
    const pool = new pg.Pool({ ...config, connectionString: url.toString() });
    const errors: Error[] = [];
    pool.on('error', (error) => {
      errors.push(error);
    });
    let end: Promise<void> | undefined;
    t.after(async () => {
      await (end ??= pool.end());
      await dropTestDatabase(f.root, name);
      await f.cleanup();
      assert.deepEqual(errors, [], 'closing sockets must not receive administrative termination');
    });
    await f.root.query(`CREATE DATABASE ${identifier(name)}`);
    await pool.query('SELECT 1');
    await (end = pool.end());
    await dropTestDatabase(f.root, name);
    assert.equal(
      (
        await f.root.query(
          'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = $1',
          [name],
        )
      ).rows[0].count,
      0,
    );
  },
);

test(
  'postgres: checked-out client disconnect rejects its transaction, rolls back, and permits recovery',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    t.after(f.cleanup);
    const store = await f.open();
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const outcome = assert.rejects(
      store.transaction(async () => {
        await store.insert(f.actorA, 'patient', null, { name: 'Uncommitted synthetic record' });
        entered();
        await pause;
      }),
      (error: unknown) => error instanceof Fault && error.status === 503,
    );
    try {
      await ready;
      const killed = await f.admin.query(
        `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
      WHERE usename = $1 AND state = 'idle in transaction'`,
        [f.roleA],
      );
      assert.equal(killed.rowCount, 1);
      assert.equal(killed.rows[0].terminated, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      resume();
    }
    await outcome;
    assert.deepEqual(await store.list(f.actorA.tenant), []);
    assert.deepEqual(await store.verifyAudit(), { ok: true, count: 0 });
    await store.health();
    await store.close();
    assert.equal(
      (
        await f.admin.query(
          'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename = $1',
          [f.roleA],
        )
      ).rows[0].count,
      0,
    );
  },
);
