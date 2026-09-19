import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { Actor, AuditQuery, AuditRow, Entity, Plugin, Store } from '../packages/contracts.ts';
import { Fault } from '../packages/contracts.ts';
import { entityQuery, type EntityQuery } from '../packages/entity-query.ts';
import {
  checkPostgresMigrations,
  checkRuntimeRole,
  postgresDataTables,
  postgresPoolConfig,
  type PostgresConnectionConfig,
} from '../packages/postgres-migrations.ts';

export type PostgresStoreConfig = PostgresConnectionConfig & { tenant: string };
type Transaction = {
  client: PoolClient;
  active: boolean;
  failure?: unknown;
  failed: boolean;
  auditQueue: Promise<void>;
};
const digest = (body: string) => createHash('sha256').update(body).digest('hex');

class RetryableTransactionConflict extends Fault {
  constructor() {
    super(409, 'Concurrent transaction conflict. Reload before saving.');
  }
}

function databaseFault(error: unknown): Fault {
  const code = (error as { code?: string })?.code;
  if (code === '40001' || code === '40P01') return new RetryableTransactionConflict();
  if (['23505', '23514', '23503'].includes(code ?? ''))
    return new Fault(409, 'Record changed or conflicts with stored data. Reload before saving.');
  if (code === '42501') return new Fault(403, 'Database access denied.');
  // Never expose pg.detail, SQL, connection strings, or raw server messages to callers/logs.
  return new Fault(503, 'PostgreSQL storage unavailable.');
}

function entityRow(row: QueryResultRow): Entity {
  return {
    id: row.id,
    tenant: row.tenant,
    patientId: row.patient_id,
    kind: row.kind,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: row.data,
  };
}
function auditRow(row: QueryResultRow): AuditRow {
  return { ...JSON.parse(row.body), seq: Number(row.seq), hash: row.hash };
}

export class PostgresStore implements Store {
  private readonly context = new AsyncLocalStorage<Transaction>();
  private readonly leases = new WeakMap<PoolClient, Transaction>();
  private readonly clientClosures = new Set<Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;

  private constructor(
    private readonly pool: pg.Pool,
    readonly tenant: string,
  ) {
    pool.on('connect', (client) => {
      const closed = new Promise<void>((resolve) => {
        client.once('end', () => {
          this.clientClosures.delete(closed);
          resolve();
        });
      });
      this.clientClosures.add(closed);
      // pg-pool removes its idle error listener while a client is checked out.
      // A disconnect between queries must poison the transaction, not crash Node.
      client.on('error', () => {
        const state = this.leases.get(client);
        if (state) this.fail(state, new Fault(503, 'PostgreSQL storage unavailable.'));
      });
    });
    // Idle socket errors are handled by pg's eviction. Deliberately do not log driver errors.
    pool.on('error', () => undefined);
  }

  static async open(config: PostgresStoreConfig): Promise<PostgresStore> {
    if (typeof config.tenant !== 'string' || !config.tenant.trim())
      throw new Error('PostgreSQL requires one configured tenant per runtime database role');
    const store = new PostgresStore(new pg.Pool(postgresPoolConfig(config)), config.tenant);
    try {
      await store.startup();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private async startup(): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL search_path = pg_catalog');
      await checkPostgresMigrations(client);
      await checkRuntimeRole(client);
      const protectedTables = [...postgresDataTables, 'schema_migrations'];
      const tables = await client.query(
        `
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'eir' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
        [protectedTables],
      );
      if (
        tables.rowCount !== protectedTables.length ||
        tables.rows.some((r) => !r.relrowsecurity || !r.relforcerowsecurity)
      )
        throw new Error('PostgreSQL row-level security is missing or disabled');
      for (const table of protectedTables) {
        const privileges = await client.query(
          `SELECT has_table_privilege(current_user, $1, 'TRUNCATE') OR
            has_table_privilege(current_user, $1, 'TRIGGER') AS unsafe`,
          [`eir.${table}`],
        );
        if (privileges.rows[0].unsafe)
          throw new Error('PostgreSQL runtime role has unsafe mutation privileges');
      }
      for (const table of [
        'schema_migrations',
        'tenant_roles',
        'audit_heads',
        'audit',
        'versions',
      ]) {
        const privileges = await client.query(
          `SELECT
          has_any_column_privilege(current_user, $1, 'UPDATE') OR
          has_table_privilege(current_user, $1, 'DELETE') AS unsafe`,
          [`eir.${table}`],
        );
        if (privileges.rows[0].unsafe)
          throw new Error('PostgreSQL runtime role has unsafe mutation privileges');
        if (['schema_migrations', 'tenant_roles', 'audit_heads'].includes(table)) {
          const insert = await client.query(
            "SELECT has_any_column_privilege(current_user, $1, 'INSERT') AS unsafe",
            [`eir.${table}`],
          );
          if (insert.rows[0].unsafe)
            throw new Error('PostgreSQL runtime role can alter tenant or migration metadata');
        }
      }
      await this.checkPolicies(client, protectedTables);
      const mapping = await client.query(
        'SELECT tenant FROM eir.tenant_roles WHERE runtime_role = current_user',
      );
      if (mapping.rowCount !== 1 || mapping.rows[0].tenant !== this.tenant)
        throw new Error('PostgreSQL configured tenant does not match authenticated runtime role');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string })?.code) throw databaseFault(error);
      throw error;
    } finally {
      client.release();
    }
    if (!(await this.verifyAudit()).ok) throw new Error('PostgreSQL audit verification failed');
  }

  private async checkPolicies(client: PoolClient, tables: string[]): Promise<void> {
    const { rows } = await client.query(
      `
      SELECT c.relname, p.polname, p.polcmd, p.polpermissive,
        p.polroles = ARRAY[c.relowner] AS owner_only,
        p.polroles = ARRAY[0::oid] AS public_only,
        pg_get_expr(p.polqual, p.polrelid, false) AS predicate,
        pg_get_expr(p.polwithcheck, p.polrelid, false) AS check_predicate
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'eir' AND c.relname = ANY($1::text[])`,
      [tables],
    );
    // pg_get_expr uses PostgreSQL's parser/deparser under the fixed pg_catalog search
    // path above. Ignore whitespace only; any policy or semantic change fails closed.
    const canonical = (value: string | null) => value?.replace(/\s+/g, ' ').trim() ?? null;
    const tenantPredicate =
      '(tenant = ( SELECT tenant_roles.tenant FROM eir.tenant_roles WHERE (tenant_roles.runtime_role = CURRENT_USER)))';
    for (const table of tables) {
      const policies = rows.filter((row) => row.relname === table);
      const operator = policies.find((row) => row.polname === 'operator_access');
      const scope = policies.find(
        (row) => row.polname === (table === 'schema_migrations' ? 'runtime_read' : 'tenant_scope'),
      );
      const expected =
        table === 'schema_migrations'
          ? 'true'
          : table === 'tenant_roles'
            ? '(runtime_role = CURRENT_USER)'
            : tenantPredicate;
      if (
        policies.length !== 2 ||
        !operator?.owner_only ||
        !operator.polpermissive ||
        operator.polcmd !== '*' ||
        canonical(operator.predicate) !== 'true' ||
        canonical(operator.check_predicate) !== 'true' ||
        !scope?.public_only ||
        !scope.polpermissive ||
        scope.polcmd !== (table === 'schema_migrations' ? 'r' : '*') ||
        canonical(scope.predicate) !== expected ||
        canonical(scope.check_predicate) !== (table === 'schema_migrations' ? null : expected)
      )
        throw new Error('PostgreSQL row-level security policy definitions do not match migrations');
    }
  }

  private async connect(): Promise<PoolClient> {
    if (this.closed) throw new Fault(503, 'PostgreSQL storage is closed.');
    try {
      return await this.pool.connect();
    } catch (error) {
      throw databaseFault(error);
    }
  }

  private fail(state: Transaction, error: unknown): void {
    if (!state.failed) {
      state.failed = true;
      state.failure = error;
    }
  }

  private assertTenant(tenant: string): void {
    if (tenant !== this.tenant)
      throw new Fault(403, 'Tenant does not match this storage provider.');
  }

  private async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const state = this.context.getStore();
    if (state && (!state.active || state.failed))
      throw state.failure ?? new Fault(409, 'Transaction is no longer active.');
    if (this.closed && !state) throw new Fault(503, 'PostgreSQL storage is closed.');
    try {
      return await (state ? state.client : this.pool).query<R>(sql, values);
    } catch (error) {
      const fault = databaseFault(error);
      if (state) this.fail(state, fault);
      throw fault;
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (parent) {
      if (!parent.active || parent.failed)
        throw parent.failure ?? new Fault(409, 'Transaction is no longer active.');
      try {
        return await fn();
      } catch (error) {
        this.fail(parent, error);
        throw error;
      }
    }
    // Callbacks must be replayable database-only work. Never put inference, network calls,
    // notifications, or other external effects inside a storage transaction callback.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.executeTransaction(fn);
      } catch (error) {
        if (!(error instanceof RetryableTransactionConflict) || attempt >= 3) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, (10 + Math.random() * 30) * 2 ** attempt),
        );
      }
    }
  }

  private async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.connect();
    const state: Transaction = {
      client,
      active: true,
      failed: false,
      auditQueue: Promise.resolve(),
    };
    this.leases.set(client, state);
    let discard = false;
    try {
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      } catch (error) {
        throw databaseFault(error);
      }
      return await this.context.run(state, async () => {
        const result = await fn();
        await state.auditQueue;
        if (state.failed) throw state.failure;
        try {
          await client.query('COMMIT');
        } catch (error) {
          throw databaseFault(error);
        }
        return result;
      });
    } catch (error) {
      state.active = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      state.active = false;
      this.leases.delete(client);
      client.release(discard);
    }
  }

  async health(): Promise<void> {
    await this.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.context.getStore()?.active)
      throw new Error('Close PostgreSQL storage outside its transaction');
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await this.pool.end();
        // Some pg-pool versions resolve end() before idle clients finish closing.
        await Promise.all(this.clientClosures);
      })();
    }
    await this.closing;
  }

  async get(tenant: string, id: string): Promise<Entity | undefined> {
    this.assertTenant(tenant);
    const { rows } = await this.query('SELECT * FROM eir.entities WHERE tenant = $1 AND id = $2', [
      tenant,
      id,
    ]);
    return rows[0] ? entityRow(rows[0]) : undefined;
  }

  async list(tenant: string, patientId?: string, kind?: string): Promise<Entity[]> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      `SELECT * FROM eir.entities WHERE tenant = $1
      AND ($2::text IS NULL OR patient_id = $2) AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at DESC, id`,
      [tenant, patientId ?? null, kind ?? null],
    );
    return rows.map(entityRow);
  }

  async searchEntities(tenant: string, kind: string, input: EntityQuery): Promise<Entity[]> {
    this.assertTenant(tenant);
    const q = entityQuery.parse(input);
    const { rows } = await this.query(
      `SELECT * FROM eir.entities WHERE tenant = $1 AND kind = $2 AND data @> $3::jsonb
      AND ($4::text IS NULL OR data->>'availableAt' <= $4)
      AND ($5::text IS NULL OR (created_at, id) > ($5, $6))
      AND ($8::text[] IS NULL OR data->>'status' = ANY($8::text[]))
      ORDER BY created_at, id LIMIT $7`,
      [
        tenant,
        kind,
        JSON.stringify(q.equals),
        q.dueBefore ?? null,
        q.after?.createdAt ?? null,
        q.after?.id ?? null,
        q.limit,
        q.statuses ?? null,
      ],
    );
    return rows.map(entityRow);
  }

  async insert(
    actor: Actor,
    kind: string,
    patientId: string | null,
    data: Record<string, any>,
  ): Promise<Entity> {
    return this.transaction(async () => {
      this.assertTenant(actor.tenant);
      const id = randomUUID(),
        at = new Date().toISOString();
      const { rows } = await this.query(
        `INSERT INTO eir.entities
        (id, tenant, patient_id, kind, version, created_at, updated_at, data)
        VALUES ($1, $2, $3, $4, 1, $5, $5, $6::jsonb) RETURNING *`,
        [id, this.tenant, patientId ?? id, kind, at, JSON.stringify(data)],
      );
      const entity = entityRow(rows[0]);
      await this.audit(actor, `${kind}.created`, entity.patientId, id);
      // Allocate change cursors only after taking the tenant audit-head write lock, so
      // a later committed cursor cannot overtake an earlier uncommitted version.
      await this.version(entity);
      return entity;
    });
  }

  async revise(
    actor: Actor,
    entity: Entity,
    version: number,
    data: Record<string, any>,
    action: string,
  ): Promise<Entity> {
    return this.transaction(async () => {
      this.assertTenant(actor.tenant);
      this.assertTenant(entity.tenant);
      if (!Number.isSafeInteger(version) || version < 1 || version !== entity.version)
        throw new Fault(409, 'Record changed. Reload before saving.');
      const { rows } = await this.query(
        `UPDATE eir.entities SET version = version + 1, updated_at = $4, data = $5::jsonb
        WHERE tenant = $1 AND id = $2 AND version = $3 RETURNING *`,
        [this.tenant, entity.id, version, new Date().toISOString(), JSON.stringify(data)],
      );
      if (!rows[0]) throw new Fault(409, 'Record changed. Reload before saving.');
      // Use the database row, never caller-supplied immutable fields, for the version and audit.
      const next = entityRow(rows[0]);
      await this.audit(actor, action, next.patientId, next.id);
      await this.version(next);
      return next;
    });
  }

  private async version(entity: Entity): Promise<void> {
    await this.query(
      'INSERT INTO eir.versions (id, tenant, version, snapshot) VALUES ($1, $2, $3, $4::jsonb)',
      [entity.id, this.tenant, entity.version, JSON.stringify(entity)],
    );
  }

  async history(tenant: string, id: string): Promise<Entity[]> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      'SELECT snapshot FROM eir.versions WHERE tenant = $1 AND id = $2 ORDER BY version',
      [tenant, id],
    );
    return rows.map((row) => row.snapshot as Entity);
  }

  async audit(
    actor: Actor,
    action: string,
    patientId?: string,
    entityId?: string,
    outcome = 'success',
  ): Promise<void> {
    await this.transaction(async () => {
      this.assertTenant(actor.tenant);
      const state = this.context.getStore()!;
      const body = JSON.stringify({
        at: new Date().toISOString(),
        actor: actor.id,
        tenant: this.tenant,
        role: actor.role,
        unitId: actor.unitId ?? null,
        assignmentId: actor.assignmentId ?? null,
        authentication:
          actor.role === 'integration' ? 'machine' : (actor.authentication?.method ?? 'local'),
        purpose: actor.role === 'clinician' ? 'treatment' : actor.role,
        action,
        patientId: patientId ?? null,
        entityId: entityId ?? null,
        outcome,
      });
      // Parallel callers within one transaction must append in a single ordered queue.
      // Across clients, the trigger locks and updates the tenant's protected audit head.
      const append = state.auditQueue.then(async () => {
        await this.query('INSERT INTO eir.audit (tenant, body) VALUES ($1, $2)', [
          this.tenant,
          body,
        ]);
      });
      state.auditQueue = append.catch((error) => {
        this.fail(state, error);
      });
      await append;
    });
  }

  async verifyAudit(): Promise<{ ok: boolean; count: number }> {
    return this.transaction(async () => {
      let previous = 'GENESIS',
        after = 0,
        count = 0;
      for (;;) {
        const { rows } = await this.query(
          `SELECT tenant, seq, body, previous, hash FROM eir.audit
          WHERE tenant = $1 AND seq > $2 ORDER BY seq LIMIT 1000`,
          [this.tenant, after],
        );
        if (!rows.length) break;
        for (const row of rows) {
          const seq = Number(row.seq);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(row.body);
          } catch {
            return { ok: false, count };
          }
          if (
            row.tenant !== this.tenant ||
            body.tenant !== this.tenant ||
            !Number.isSafeInteger(seq) ||
            seq <= after ||
            row.previous !== previous ||
            row.hash !== digest(previous + row.body)
          )
            return { ok: false, count };
          previous = row.hash;
          after = seq;
          count++;
        }
      }
      const head = await this.query('SELECT seq, hash FROM eir.audit_heads WHERE tenant = $1', [
        this.tenant,
      ]);
      return {
        ok:
          head.rowCount === 1 &&
          Number(head.rows[0].seq) === after &&
          head.rows[0].hash === previous,
        count,
      };
    });
  }

  async grant(
    tenant: string,
    patientId: string,
    actorId: string,
    role: string,
    expires: string,
  ): Promise<void> {
    await this.transaction(async () => {
      this.assertTenant(tenant);
      await this.query(
        `INSERT INTO eir.grants (tenant, patient_id, actor_id, role, expires) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant, patient_id, actor_id) DO UPDATE SET role = EXCLUDED.role, expires = EXCLUDED.expires`,
        [tenant, patientId, actorId, role, expires],
      );
    });
  }

  async getGrant(
    tenant: string,
    patientId: string,
    actorId: string,
  ): Promise<{ role: string; expires: string } | undefined> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      'SELECT role, expires FROM eir.grants WHERE tenant = $1 AND patient_id = $2 AND actor_id = $3',
      [tenant, patientId, actorId],
    );
    return rows[0] as { role: string; expires: string } | undefined;
  }

  async restrict(tenant: string, patientId: string, blocked: boolean): Promise<void> {
    await this.transaction(async () => {
      this.assertTenant(tenant);
      await this.query(
        `INSERT INTO eir.restrictions (tenant, patient_id, blocked) VALUES ($1, $2, $3)
        ON CONFLICT (tenant, patient_id) DO UPDATE SET blocked = EXCLUDED.blocked`,
        [tenant, patientId, blocked],
      );
    });
  }

  async isBlocked(tenant: string, patientId: string): Promise<boolean> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      'SELECT blocked FROM eir.restrictions WHERE tenant = $1 AND patient_id = $2',
      [tenant, patientId],
    );
    return rows[0]?.blocked === true;
  }

  async saveSession(hash: string, actor: Actor, expires: string): Promise<void> {
    await this.transaction(async () => {
      this.assertTenant(actor.tenant);
      await this.query(
        'INSERT INTO eir.sessions (tenant, hash, actor, expires, last_seen) VALUES ($1, $2, $3::jsonb, $4, $5)',
        [this.tenant, hash, JSON.stringify(actor), expires, new Date().toISOString()],
      );
    });
  }

  async session(
    hash: string,
  ): Promise<{ actor: Actor; expires: string; lastSeen: string } | undefined> {
    const { rows } = await this.query(
      'SELECT actor, expires, last_seen FROM eir.sessions WHERE tenant = $1 AND hash = $2',
      [this.tenant, hash],
    );
    return rows[0]
      ? { actor: rows[0].actor, expires: rows[0].expires, lastSeen: rows[0].last_seen }
      : undefined;
  }

  async updateSession(hash: string, actor: Actor): Promise<void> {
    await this.transaction(async () => {
      this.assertTenant(actor.tenant);
      await this.query(
        'UPDATE eir.sessions SET actor = $3::jsonb, last_seen = $4 WHERE tenant = $1 AND hash = $2',
        [this.tenant, hash, JSON.stringify(actor), new Date().toISOString()],
      );
    });
  }

  async saveLogin(hash: string, data: Record<string, string>, expires: string): Promise<void> {
    await this.transaction(async () => {
      await this.query('DELETE FROM eir.login_transactions WHERE tenant = $1 AND expires <= $2', [
        this.tenant,
        new Date().toISOString(),
      ]);
      await this.query(
        'INSERT INTO eir.login_transactions (tenant, hash, data, expires) VALUES ($1, $2, $3::jsonb, $4)',
        [this.tenant, hash, JSON.stringify(data), expires],
      );
    });
  }

  async consumeLogin(hash: string): Promise<Record<string, string> | undefined> {
    return this.transaction(async () => {
      const { rows } = await this.query(
        'DELETE FROM eir.login_transactions WHERE tenant = $1 AND hash = $2 RETURNING data, expires',
        [this.tenant, hash],
      );
      return rows[0] && rows[0].expires > new Date().toISOString()
        ? (rows[0].data as Record<string, string>)
        : undefined;
    });
  }

  async revokeSession(hash: string): Promise<void> {
    await this.transaction(async () => {
      await this.query('DELETE FROM eir.sessions WHERE tenant = $1 AND hash = $2', [
        this.tenant,
        hash,
      ]);
    });
  }

  async auditEntries(tenant: string, patientId?: string): Promise<Record<string, unknown>[]> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      `SELECT seq, body, hash FROM eir.audit WHERE tenant = $1
      AND ($2::text IS NULL OR body::jsonb->>'patientId' = $2) ORDER BY seq DESC LIMIT 200`,
      [tenant, patientId ?? null],
    );
    return rows.map(auditRow);
  }

  async auditPage(tenant: string, q: AuditQuery): Promise<AuditRow[]> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      `SELECT seq, body, hash FROM eir.audit WHERE tenant = $1
      AND body::jsonb->>'unitId' = $2 AND seq < $3
      AND ($4::text IS NULL OR body::jsonb->>'actor' = $4)
      AND ($5::text IS NULL OR body::jsonb->>'patientId' = $5)
      AND ($6::text IS NULL OR body::jsonb->>'outcome' = $6)
      ORDER BY seq DESC LIMIT $7`,
      [
        tenant,
        q.unitId,
        q.before ?? Number.MAX_SAFE_INTEGER,
        q.actorId ?? null,
        q.patientId ?? null,
        q.outcome ?? null,
        q.limit,
      ],
    );
    return rows.map(auditRow);
  }

  async auditEntry(tenant: string, seq: number): Promise<AuditRow | undefined> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      'SELECT seq, body, hash FROM eir.audit WHERE tenant = $1 AND seq = $2',
      [tenant, seq],
    );
    return rows[0] ? auditRow(rows[0]) : undefined;
  }

  async changes(
    tenant: string,
    patientId: string,
    after: number,
  ): Promise<{ cursor: number; record: Entity }[]> {
    this.assertTenant(tenant);
    const { rows } = await this.query(
      `SELECT cursor, snapshot FROM eir.versions WHERE tenant = $1
      AND snapshot->>'patientId' = $2 AND cursor > $3 ORDER BY cursor LIMIT 100`,
      [tenant, patientId, after],
    );
    return rows.map((row) => ({ cursor: Number(row.cursor), record: row.snapshot as Entity }));
  }
}

export default {
  id: 'eir.storage.postgres',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['store'],
  requires: [],
  async setup(ctx, config) {
    const store = await PostgresStore.open({
      tenant: config.tenant as string,
      connectionStringEnv: config.connectionStringEnv as string,
      localDevelopmentOnly: config.localDevelopmentOnly === true,
    });
    ctx.onDispose(() => store.close());
    ctx.provide('store', store);
  },
} satisfies Plugin;
