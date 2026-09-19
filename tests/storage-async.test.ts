import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
import { doctor, fixture, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { Runtime } from '../packages/runtime.ts';
import country from '../plugins/country-se.ts';
import type { Plugin } from '../packages/contracts.ts';

test('runtime rejects synchronous v1 plugins and awaits asynchronous teardown', async () => {
  await assert.rejects(
    new Runtime().start([{ plugin: { ...country, apiVersion: 1 } as unknown as Plugin }]),
  );
  let disposed = false;
  const runtime = await new Runtime().start([
    {
      plugin: {
        ...country,
        setup(ctx) {
          country.setup(ctx);
          ctx.onDispose(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            disposed = true;
          });
        },
      },
    },
  ]);
  await runtime.stop();
  assert.equal(disposed, true);
});

test('SQLite awaited transactions isolate independent callers and roll back nested failures', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = store.transaction(async () => {
    await store.insert(doctor, 'patient', null, { name: 'Uncommitted' });
    enter();
    await gate;
    throw new Error('forced rollback');
  });
  const failed = assert.rejects(writing, /forced rollback/);
  await entered;
  let disclosed = false;
  const reading = store.list(doctor.tenant).then((rows) => {
    disclosed = true;
    return rows;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disclosed, false);
  release();
  await failed;
  assert.deepEqual(await reading, []);
  assert.deepEqual(await store.verifyAudit(), { ok: true, count: 0 });
  await assert.rejects(
    store.transaction(async () => {
      await store.insert(doctor, 'patient', null, { name: 'Must not commit' });
      try {
        await store.transaction(async () => {
          throw new Error('nested');
        });
      } catch {
        /* The transaction remains rollback-only. */
      }
    }),
    /Transaction failed/,
  );
  assert.deepEqual(await store.list(doctor.tenant), []);
});

test('standalone inserts atomically roll back when audit append fails', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.db.exec(
    "CREATE TRIGGER test_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit failure'); END",
  );
  await assert.rejects(
    store.insert(doctor, 'patient', null, { name: 'Rollback' }),
    /audit failure/,
  );
  assert.deepEqual(await store.list(doctor.tenant), []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM versions').get()!.n, 0);
});

test('SQLite revisions use stored immutable fields and closing inside a transaction is rejected', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const patient = await store.insert(doctor, 'patient', null, { name: 'Synthetic' });
  const revised = await store.revise(
    doctor,
    { ...patient, patientId: 'forged', kind: 'note' },
    1,
    { name: 'Revised' },
    'patient.updated',
  );
  assert.equal(revised.patientId, patient.id);
  assert.equal(revised.kind, 'patient');
  await assert.rejects(
    store.transaction(async () => {
      await store.close();
    }),
    /outside its transaction/,
  );
  await store.health();
});

test('storage shutdown drains writes and readiness fails without disclosing database details', async (t) => {
  const f = await fixture();
  const app = await createApp(f.runtime, root);
  t.after(async () => {
    await app.close();
    await f.runtime.stop();
  });
  assert.equal((await app.inject('/ready')).statusCode, 200);
  const record = f.store.insert(doctor, 'task', f.patient.id, {
    title: 'Committed before shutdown',
  });
  const closing = f.store.close();
  await record;
  await closing;
  const response = await app.inject('/ready');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable' });
  assert.equal((await app.inject('/health')).statusCode, 200);
});
