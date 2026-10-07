// In-memory ContentStore for development, evaluation and tests, with failure injection. Nothing is
// persisted. It passes the content conformance suite (tests/content-memory.test.ts).
import { randomUUID } from 'node:crypto';
import { Fault, type Actor, type Entity } from './contracts.ts';
import type { ContentStore } from './content.ts';
import { listQueries } from './content-query.ts';

type Rec = { versions: Entity[]; origin?: string };
export class MemoryContent implements ContentStore {
  kinds = ['observation', 'condition', 'note'];
  records = new Map<string, Rec>();
  // Failure injection.
  failNext: Partial<Record<'insert' | 'revise' | 'get' | 'list', number>> = {};
  crashAfterInsert = 0;
  unsupportedCodes = new Set<string>();
  calls = { insert: 0, revise: 0, get: 0 };
  reset() {
    this.records.clear();
    this.failNext = {};
    this.crashAfterInsert = 0;
    this.unsupportedCodes.clear();
    this.calls = { insert: 0, revise: 0, get: 0 };
  }
  private trip(op: 'insert' | 'revise' | 'get' | 'list') {
    if ((this.failNext[op] ?? 0) > 0) {
      this.failNext[op]!--;
      throw new Error(`injected ${op} failure with clinical text Syntetisk`);
    }
  }
  async health() {}
  private queries = listQueries((tenant, patientId, kind) => this.list(tenant, patientId, kind));
  vitalSeries = this.queries.vitalSeries;
  problems = this.queries.problems;
  async insert(
    actor: Actor,
    kind: string,
    patientId: string,
    data: Record<string, any>,
    origin?: string,
  ) {
    this.calls.insert++;
    this.trip('insert');
    if (!this.kinds.includes(kind)) throw new Fault(422, `Unsupported record type: ${kind}`);
    if (this.unsupportedCodes.has(String(data.code)))
      throw new Fault(422, `Observation ${data.code} has no mapping`);
    const at = new Date().toISOString();
    const e: Entity = {
      id: randomUUID(),
      tenant: actor.tenant,
      patientId,
      kind,
      version: 1,
      createdAt: at,
      updatedAt: at,
      data: structuredClone(data),
    };
    this.records.set(e.id, { versions: [e], origin });
    if (this.crashAfterInsert > 0) {
      this.crashAfterInsert--;
      throw new Error('connection lost after the record was written');
    }
    return structuredClone(e);
  }
  async findByOrigin(tenant: string, patientId: string, origin: string) {
    for (const r of this.records.values()) {
      const e = r.versions.at(-1)!;
      if (r.origin === origin && e.tenant === tenant && e.patientId === patientId)
        return structuredClone(e);
    }
    return undefined;
  }
  async get(tenant: string, id: string) {
    this.calls.get++;
    this.trip('get');
    const e = this.records.get(id)?.versions.at(-1);
    return e && e.tenant === tenant ? structuredClone(e) : undefined;
  }
  async list(tenant: string, patientId: string, kind?: string) {
    this.trip('list');
    return [...this.records.values()]
      .map((r) => r.versions.at(-1)!)
      .filter((e) => e.tenant === tenant && e.patientId === patientId && (!kind || e.kind === kind))
      .map((e) => structuredClone(e));
  }
  async revise(actor: Actor, entity: Entity, version: number, data: Record<string, any>) {
    this.calls.revise++;
    this.trip('revise');
    if (actor.tenant !== entity.tenant) throw new Fault(403, 'Tenant does not match the record.');
    const rec = this.records.get(entity.id);
    const current = rec?.versions.at(-1);
    if (!rec || !current || current.version !== version || entity.version !== version)
      throw new Fault(409, 'Record changed. Reload before saving.');
    if (current.kind === 'note' && current.data.status === 'signed')
      throw new Fault(409, 'Signed note is immutable');
    if (this.unsupportedCodes.has(String(data.code)))
      throw new Fault(422, `Observation ${data.code} has no mapping`);
    const next: Entity = {
      ...current,
      version: version + 1,
      updatedAt: new Date().toISOString(),
      data: structuredClone(data),
    };
    rec.versions.push(next);
    return structuredClone(next);
  }
  async history(tenant: string, id: string) {
    const rec = this.records.get(id);
    return rec && rec.versions[0].tenant === tenant ? structuredClone(rec.versions) : [];
  }
}
