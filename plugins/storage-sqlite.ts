import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Actor, Entity, Plugin, Store, AuditQuery, AuditRow } from '../packages/contracts.ts';
import { Fault } from '../packages/contracts.ts';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class SqliteStore implements Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    this.db.function('eir_hash', (value) => digest(String(value)));
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 2) {
      this.db.close();
      throw new Error('Database version newer than application');
    }
    if (!version.user_version)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE entities (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, patientId TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX chart ON entities(tenant,patientId,kind);
      CREATE UNIQUE INDEX identifier_unique ON entities(tenant,json_extract(data,'$.identifier.system'),json_extract(data,'$.identifier.value')) WHERE kind='patient';
      CREATE TABLE versions (id TEXT NOT NULL, tenant TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE grants (tenant TEXT NOT NULL, patientId TEXT NOT NULL REFERENCES entities(id), actorId TEXT NOT NULL, role TEXT NOT NULL, expires TEXT NOT NULL, PRIMARY KEY(tenant,patientId,actorId));
      CREATE TABLE restrictions (tenant TEXT NOT NULL, patientId TEXT NOT NULL REFERENCES entities(id), blocked INTEGER NOT NULL, PRIMARY KEY(tenant,patientId));
      CREATE TABLE sessions (hash TEXT PRIMARY KEY, actor TEXT NOT NULL, expires TEXT NOT NULL);
      CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, body TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
      CREATE TRIGGER version_no_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are append-only'); END;
      CREATE TRIGGER version_no_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'versions are append-only'); END;
      CREATE TRIGGER signed_note_no_update BEFORE UPDATE ON entities WHEN OLD.kind='note' AND json_extract(OLD.data,'$.status')='signed' BEGIN SELECT RAISE(ABORT,'signed note is immutable'); END;
      CREATE TRIGGER entity_no_delete BEFORE DELETE ON entities BEGIN SELECT RAISE(ABORT,'record deletion requires governed retention workflow'); END;
      PRAGMA user_version=1;
      COMMIT;
    `);
    if (version.user_version < 2)
      this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE sessions ADD COLUMN lastSeen TEXT NOT NULL DEFAULT '';
      DELETE FROM sessions;
      CREATE TABLE login_transactions (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires TEXT NOT NULL);
      PRAGMA user_version=2;
      COMMIT;
    `);
    if (!this.verifyAudit().ok) {
      this.db.close();
      throw new Error('Audit verification failed');
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(tenant: string, id: string) {
    return decode(
      this.db.prepare('SELECT * FROM entities WHERE tenant=? AND id=?').get(tenant, id),
    );
  }
  list(tenant: string, patientId?: string, kind?: string) {
    return this.db
      .prepare(
        'SELECT * FROM entities WHERE tenant=? AND (? IS NULL OR patientId=?) AND (? IS NULL OR kind=?) ORDER BY createdAt DESC, id',
      )
      .all(tenant, patientId ?? null, patientId ?? null, kind ?? null, kind ?? null)
      .map((row) => decode(row)!);
  }
  insert(actor: Actor, kind: string, patientId: string | null, data: Record<string, any>) {
    const id = randomUUID();
    const at = new Date().toISOString();
    const entity: Entity = {
      id,
      tenant: actor.tenant,
      patientId: patientId ?? id,
      kind,
      version: 1,
      createdAt: at,
      updatedAt: at,
      data: structuredClone(data),
    };
    this.db
      .prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?)')
      .run(id, actor.tenant, entity.patientId, kind, 1, at, at, JSON.stringify(data));
    this.version(entity);
    this.audit(actor, `${kind}.created`, entity.patientId, id);
    return entity;
  }
  revise(actor: Actor, entity: Entity, version: number, data: Record<string, any>, action: string) {
    const next: Entity = {
      ...entity,
      version: version + 1,
      updatedAt: new Date().toISOString(),
      data: structuredClone(data),
    };
    const result = this.db
      .prepare(
        'UPDATE entities SET version=?,updatedAt=?,data=? WHERE tenant=? AND id=? AND version=?',
      )
      .run(next.version, next.updatedAt, JSON.stringify(data), actor.tenant, entity.id, version);
    if (result.changes !== 1) throw new Fault(409, 'Record changed. Reload before saving.');
    this.version(next);
    this.audit(actor, action, entity.patientId, entity.id);
    return next;
  }
  version(entity: Entity) {
    this.db
      .prepare('INSERT INTO versions VALUES(?,?,?,?)')
      .run(entity.id, entity.tenant, entity.version, JSON.stringify(entity));
  }
  history(tenant: string, id: string): Entity[] {
    return this.db
      .prepare('SELECT snapshot FROM versions WHERE tenant=? AND id=? ORDER BY version')
      .all(tenant, id)
      .map((row) => JSON.parse(String(row.snapshot)));
  }
  audit(actor: Actor, action: string, patientId?: string, entityId?: string, outcome = 'success') {
    const body = JSON.stringify({
      at: new Date().toISOString(),
      actor: actor.id,
      tenant: actor.tenant,
      role: actor.role,
      unitId: actor.unitId ?? null,
      assignmentId: actor.assignmentId ?? null,
      authentication: actor.authentication?.method ?? 'local',
      purpose: actor.role === 'clinician' ? 'treatment' : actor.role,
      action,
      patientId: patientId ?? null,
      entityId: entityId ?? null,
      outcome,
    });
    // Previous hash and append occur in one SQLite statement to serialize concurrent writers.
    this.db
      .prepare(
        "INSERT INTO audit(tenant,body,previous,hash) SELECT ?,?,previous,eir_hash(previous || ?) FROM (SELECT COALESCE((SELECT hash FROM audit ORDER BY seq DESC LIMIT 1),'GENESIS') AS previous)",
      )
      .run(actor.tenant, body, body);
  }
  verifyAudit() {
    let previous = 'GENESIS';
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate()) {
      if (row.previous !== previous || row.hash !== digest(previous + row.body))
        return { ok: false, count };
      previous = String(row.hash);
      count++;
    }
    return { ok: true, count };
  }
  grant(tenant: string, patientId: string, actorId: string, role: string, expires: string) {
    this.db
      .prepare(
        'INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(tenant,patientId,actorId) DO UPDATE SET role=excluded.role, expires=excluded.expires',
      )
      .run(tenant, patientId, actorId, role, expires);
  }
  getGrant(tenant: string, patientId: string, actorId: string) {
    return this.db
      .prepare('SELECT role,expires FROM grants WHERE tenant=? AND patientId=? AND actorId=?')
      .get(tenant, patientId, actorId) as { role: string; expires: string } | undefined;
  }
  restrict(tenant: string, patientId: string, blocked: boolean) {
    this.db
      .prepare(
        'INSERT INTO restrictions VALUES(?,?,?) ON CONFLICT(tenant,patientId) DO UPDATE SET blocked=excluded.blocked',
      )
      .run(tenant, patientId, Number(blocked));
  }
  isBlocked(tenant: string, patientId: string) {
    return (
      this.db
        .prepare('SELECT blocked FROM restrictions WHERE tenant=? AND patientId=?')
        .get(tenant, patientId)?.blocked === 1
    );
  }
  saveSession(hash: string, actor: Actor, expires: string) {
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(hash, JSON.stringify(actor), expires, new Date().toISOString());
  }
  session(hash: string) {
    const row = this.db
      .prepare('SELECT actor,expires,lastSeen FROM sessions WHERE hash=?')
      .get(hash);
    return row
      ? {
          actor: JSON.parse(String(row.actor)) as Actor,
          expires: String(row.expires),
          lastSeen: String(row.lastSeen),
        }
      : undefined;
  }
  updateSession(hash: string, actor: Actor) {
    this.db
      .prepare('UPDATE sessions SET actor=?,lastSeen=? WHERE hash=?')
      .run(JSON.stringify(actor), new Date().toISOString(), hash);
  }
  saveLogin(hash: string, data: Record<string, string>, expires: string) {
    this.db
      .prepare('DELETE FROM login_transactions WHERE expires<=?')
      .run(new Date().toISOString());
    this.db
      .prepare('INSERT INTO login_transactions VALUES(?,?,?)')
      .run(hash, JSON.stringify(data), expires);
  }
  consumeLogin(hash: string) {
    const row = this.db
      .prepare('DELETE FROM login_transactions WHERE hash=? RETURNING data,expires')
      .get(hash);
    return row && String(row.expires) > new Date().toISOString()
      ? JSON.parse(String(row.data))
      : undefined;
  }
  revokeSession(hash: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
  }
  auditEntries(tenant: string, patientId?: string) {
    return this.db
      .prepare(
        "SELECT seq,body,hash FROM audit WHERE tenant=? AND (? IS NULL OR json_extract(body,'$.patientId')=?) ORDER BY seq DESC LIMIT 200",
      )
      .all(tenant, patientId ?? null, patientId ?? null)
      .map((row) => ({ seq: row.seq, ...JSON.parse(String(row.body)), hash: row.hash }));
  }
  auditPage(tenant: string, q: AuditQuery): AuditRow[] {
    return this.db
      .prepare(
        `SELECT seq,body,hash FROM audit WHERE tenant=?
      AND json_extract(body,'$.unitId')=? AND seq<?
      AND (? IS NULL OR json_extract(body,'$.actor')=?)
      AND (? IS NULL OR json_extract(body,'$.patientId')=?)
      AND (? IS NULL OR json_extract(body,'$.outcome')=?)
      ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        tenant,
        q.unitId,
        q.before ?? Number.MAX_SAFE_INTEGER,
        q.actorId ?? null,
        q.actorId ?? null,
        q.patientId ?? null,
        q.patientId ?? null,
        q.outcome ?? null,
        q.outcome ?? null,
        q.limit,
      )
      .map((row) => ({
        seq: Number(row.seq),
        ...JSON.parse(String(row.body)),
        hash: String(row.hash),
      }));
  }
  auditEntry(tenant: string, seq: number): AuditRow | undefined {
    const row = this.db
      .prepare('SELECT seq,body,hash FROM audit WHERE tenant=? AND seq=?')
      .get(tenant, seq);
    return row
      ? { seq: Number(row.seq), ...JSON.parse(String(row.body)), hash: String(row.hash) }
      : undefined;
  }
  changes(tenant: string, patientId: string, after: number) {
    return this.db
      .prepare(
        "SELECT rowid AS cursor,snapshot FROM versions WHERE tenant=? AND json_extract(snapshot,'$.patientId')=? AND rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(tenant, patientId, after)
      .map((r) => ({ cursor: Number(r.cursor), record: JSON.parse(String(r.snapshot)) as Entity }));
  }
}
function decode(row: any): Entity | undefined {
  return row ? { ...row, data: JSON.parse(row.data) } : undefined;
}
export default {
  id: 'eir.storage.sqlite',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['store'],
  requires: [],
  setup(ctx, config) {
    const store = new SqliteStore(String(config.path ?? '.data/ehr.sqlite'));
    ctx.onDispose(() => store.db.close());
    ctx.provide('store', store);
  },
} satisfies Plugin;
