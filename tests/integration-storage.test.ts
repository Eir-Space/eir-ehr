import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
import { postgresFixture, postgresTestOptions } from './postgres-helpers.ts';
import type { Actor } from '../packages/contracts.ts';

for (const pg of [false, true]) {
  await test(
    `${pg ? 'PostgreSQL' : 'SQLite'}: bounded queue queries, tenant isolation and immutable unique message identities`,
    pg ? postgresTestOptions : {},
    async (t) => {
      const f = pg ? await postgresFixture() : undefined;
      const store = f ? await f.open() : new SqliteStore(':memory:');
      t.after(async () => {
        await store.close();
        await f?.cleanup();
      });
      const actor: Actor = f?.actorA ?? { id: 'worker', tenant: 'tenant-a', role: 'integration' };
      const data = {
        connectorId: 'test-lab',
        unitId: 'unit-a',
        orderId: randomUUID(),
        payload: { immutable: true },
        payloadHash: 'hash',
        state: 'pending',
        availableAt: '2026-01-01T00:00:00.000Z',
        enabled: true,
      };
      const saved = [];
      for (let i = 0; i < 5; i++)
        saved.push(
          await store.insert(actor, 'integrationOutbox', null, {
            ...data,
            messageId: randomUUID(),
          }),
        );
      const first = await store.searchEntities!(actor.tenant, 'integrationOutbox', {
        equals: { connectorId: 'test-lab', enabled: true },
        dueBefore: '2026-02-01T00:00:00.000Z',
        limit: 2,
      });
      assert.equal(first.length, 2);
      const second = await store.searchEntities!(actor.tenant, 'integrationOutbox', {
        equals: { state: 'pending' },
        after: { id: first[1].id, createdAt: first[1].createdAt },
        limit: 2,
      });
      assert.equal(second.length, 2);
      assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 4);
      assert.deepEqual(
        await store.searchEntities!(actor.tenant, 'integrationOutbox', {
          equals: { connectorId: 'other' },
        }),
        [],
      );
      assert.deepEqual(
        await store.searchEntities!(actor.tenant, 'integrationOutbox', {
          dueBefore: '2020-01-01T00:00:00.000Z',
        }),
        [],
      );
      await assert.rejects(
        store.searchEntities!(actor.tenant, 'integrationOutbox', { limit: 1000 }),
      );
      await assert.rejects(
        store.searchEntities!(actor.tenant, 'integrationOutbox', {
          equals: { "x') OR true --": true },
        }),
      );
      if (f) {
        const other = await f.open(f.configB);
        assert.deepEqual(await other.searchEntities!('tenant-b', 'integrationOutbox', {}), []);
        await assert.rejects(other.searchEntities!('tenant-a', 'integrationOutbox', {}));
      } else assert.deepEqual(await store.searchEntities!('tenant-b', 'integrationOutbox', {}), []);
      const row = saved[0];
      await store.insert(actor, 'task', null, { status: 'requested', title: 'Open' });
      await store.insert(actor, 'task', null, { status: 'completed', title: 'Closed' });
      assert.equal(
        (
          await store.searchEntities!(actor.tenant, 'task', {
            statuses: ['requested', 'in-progress'],
          })
        ).length,
        1,
      );
      assert.equal(
        (await store.searchEntities!(actor.tenant, 'task', { statuses: ['completed'] }))[0].data
          .title,
        'Closed',
      );
      await assert.rejects(store.searchEntities!(actor.tenant, 'task', { statuses: [] }));
      for (const change of [
        { payload: { altered: true } },
        { payloadHash: 'modified' },
        { messageId: randomUUID() },
        { connectorId: 'other' },
        { unitId: 'other' },
        { orderId: randomUUID() },
      ])
        await assert.rejects(
          store.revise(actor, row, row.version, { ...row.data, ...change }, 'test.mutate'),
        );
      assert.equal((await store.history(actor.tenant, row.id)).length, 1);
      await assert.rejects(store.insert(actor, 'integrationOutbox', null, row.data));
      assert.equal((await store.list(actor.tenant, undefined, 'integrationOutbox')).length, 5);
      const updated = await store.revise(
        actor,
        row,
        row.version,
        { ...row.data, state: 'retry' },
        'integration.retry',
      );
      assert.equal(updated.version, 2);
      assert((await store.verifyAudit()).ok);
    },
  );
}
