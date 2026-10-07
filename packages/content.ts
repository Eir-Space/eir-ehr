import type { Actor, Entity } from './contracts.ts';

// The clinical-content seam: versioned clinical facts with identity, time and optimistic
// concurrency. It is the part of `Store` that any content backend can honour (JSON rows,
// openEHR compositions, a FHIR server). Authorization, audit and workflow stay in the core.
// Every provider must pass the conformance suite in tests/content-contract.ts.
//
// Semantics a provider must keep:
// - `insert` returns version 1; `revise` returns version + 1 and never rewrites history.
// - `revise` with a stale version, or an entity from another tenant, fails (409 / 403 Fault).
// - A signed note (`data.status === 'signed'`) can never be revised.
// - `get`, `list` and `history` are tenant-scoped; another tenant sees nothing.
// - A provider rejects kinds it cannot represent with a 422 Fault rather than storing a lossy copy.
// - `data` round-trips: what `get` returns equals what `insert` or `revise` was given.
// - Optional idempotent insert: a provider that implements `findByOrigin` stores the `origin`
//   key given to `insert` and returns that record for the same (tenant, patient, origin). A
//   writer that may crash between writing and recording the id uses it to avoid duplicates.
// Typed read queries. A provider that can answer them natively (for example openEHR AQL) does;
// others derive them from `list`. Agents and analytics never send query text: they choose one of
// these queries, so a provider is never handed an arbitrary expression.
export type VitalPoint = {
  id: string; // the record's id in this store
  version: number;
  code: string;
  value: number;
  unit: string;
  effectiveAt: string;
};
export type ProblemRow = {
  id: string;
  version: number;
  system?: string;
  code?: string;
  display: string;
  onset?: string;
};
export const QUERY_CAP = 500;

export interface ContentStore {
  readonly kinds: readonly string[];
  health(): Promise<void>;
  insert(
    actor: Actor,
    kind: string,
    patientId: string,
    data: Record<string, any>,
    origin?: string,
  ): Promise<Entity>;
  // Newest first, at most `cap` rows. Rows are current versions only.
  vitalSeries?(tenant: string, patientId: string, code: string, cap: number): Promise<VitalPoint[]>;
  problems?(tenant: string, patientId: string, cap: number): Promise<ProblemRow[]>;
  findByOrigin?(tenant: string, patientId: string, origin: string): Promise<Entity | undefined>;
  get(tenant: string, id: string): Promise<Entity | undefined>;
  list(tenant: string, patientId: string, kind?: string): Promise<Entity[]>;
  revise(
    actor: Actor,
    entity: Entity,
    version: number,
    data: Record<string, any>,
    action: string,
  ): Promise<Entity>;
  history(tenant: string, id: string): Promise<Entity[]>;
}
