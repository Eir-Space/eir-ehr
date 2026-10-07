import { z } from 'zod';
import {
  Fault,
  assert,
  type Access,
  type ClinicalQuery,
  type Entity,
  type QueryCoverage,
  type Store,
} from './contracts.ts';
import { QUERY_CAP, type ContentStore, type ProblemRow, type VitalPoint } from './content.ts';

// A typed, authorized, bounded read surface over the content store, built for agents and
// analytics. What makes it safe to hand to an AI:
// - Callers choose a query; they never send query text to the content store.
// - Access is checked and audited on the ledger before anything is read.
// - Every served row is joined to its ledger record and served only if the link is current and the
//   values agree with the legal record. Anything else is counted, never silently dropped.
// - Each answer reports its own coverage, so a consumer can tell a complete answer from a partial one.
// - Each row carries a `ref` (`entityId@version`) that points at the ledger version it came from.
export const clinicalQueryOptions = z
  .object({ source: z.string().min(1), target: z.string().min(1).optional() })
  .strict();

const code = z.string().regex(/^\d{1,7}-\d$/);
const when = z.iso.datetime({ offset: true });
const vitalsInput = z
  .object({
    code,
    from: when.optional(),
    to: when.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
const sameInstant = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);
const sameDay = (a: unknown, b: unknown) =>
  a === b ||
  (typeof a === 'string' && typeof b === 'string' && (a.startsWith(b) || b.startsWith(a)));

export function createClinicalQuery(deps: {
  store: Store;
  access: Access;
  source: () => ContentStore;
  options: unknown;
  now?: () => number;
}): ClinicalQuery {
  const options = clinicalQueryOptions.parse(deps.options);
  const target = options.target ?? options.source;
  const now = deps.now ?? Date.now;
  const empty = (): QueryCoverage => ({
    ledger: 0,
    served: 0,
    notProjected: 0,
    unmapped: 0,
    stale: 0,
    diverged: 0,
    missing: 0,
  });

  async function authorize(actor: Parameters<ClinicalQuery['vitals']>[0], patientId: string) {
    assert(actor.role === 'clinician', 403, 'Clinical queries are limited to clinicians');
    await deps.store.transaction(async () => {
      await deps.access.check(actor, patientId);
    });
  }

  // Links for this patient, by ledger record and by content id.
  async function links(tenant: string, patientId: string) {
    const all = (await deps.store.list(tenant, patientId, 'contentLink')).filter(
      (l) => l.data.target === target,
    );
    return {
      byEntity: new Map(all.map((l) => [String(l.data.entityId), l.data])),
      contentIds: new Set(all.map((l) => String(l.data.contentId)).filter(Boolean)),
    };
  }

  // Shared join: classify each ledger record against the rows the content store returned.
  function join<R extends { id: string; version: number }>(
    ledger: Entity[],
    rows: R[],
    link: Awaited<ReturnType<typeof links>>,
    agrees: (entity: Entity, row: R) => boolean,
  ) {
    const rowByContent = new Map(rows.map((r) => [r.id, r]));
    const coverage = empty();
    const served: { entity: Entity; row: R }[] = [];
    for (const entity of ledger) {
      coverage.ledger++;
      const l = link.byEntity.get(entity.id);
      if (!l || l.status === 'pending' || l.status === 'error') coverage.notProjected++;
      else if (l.status === 'unmapped') coverage.unmapped++;
      else {
        const row = rowByContent.get(String(l.contentId));
        if (!row) coverage.missing++;
        // Behind the ledger: not yet caught up. Ahead of it: changed outside Eir.
        else if (row.version > entity.version) coverage.diverged++;
        else if (l.syncedVersion !== entity.version || row.version !== entity.version)
          coverage.stale++;
        else if (!agrees(entity, row)) coverage.diverged++;
        else {
          coverage.served++;
          served.push({ entity, row });
        }
      }
    }
    const foreign = rows.filter((r) => !link.contentIds.has(r.id)).length;
    return { coverage, served, foreign, truncated: rows.length >= QUERY_CAP };
  }
  const finish = (coverage: QueryCoverage, foreign: number, truncated: boolean) => ({
    source: options.source,
    asOf: new Date(now()).toISOString(),
    coverage,
    complete: coverage.served === coverage.ledger && !truncated,
    foreign,
    truncated,
  });

  return {
    async vitals(actor, patientId, query) {
      const q = vitalsInput.parse(query);
      await authorize(actor, patientId);
      const source = deps.source();
      if (!source.vitalSeries) throw new Fault(501, 'The content store has no vital sign query');
      const from = q.from ? Date.parse(q.from) : -Infinity;
      const to = q.to ? Date.parse(q.to) : Infinity;
      const inWindow = (at: unknown) => {
        const t = Date.parse(String(at));
        return t >= from && t <= to;
      };
      // A vital the content model cannot hold is a coverage fact (unmapped), not an error.
      const rows: VitalPoint[] = await source
        .vitalSeries(actor.tenant, patientId, q.code, QUERY_CAP)
        .catch((e) => (e instanceof Fault && e.status === 422 ? [] : Promise.reject(e)));
      const link = await links(actor.tenant, patientId);
      const ledger = (await deps.store.list(actor.tenant, patientId, 'observation')).filter(
        (e) =>
          e.data.code === q.code &&
          e.data.status !== 'entered-in-error' &&
          inWindow(e.data.effectiveAt),
      );
      const joined = join(
        ledger,
        rows,
        link,
        (e, r) =>
          Math.abs(e.data.value - r.value) < 1e-9 &&
          e.data.unit === r.unit &&
          sameInstant(e.data.effectiveAt, r.effectiveAt),
      );
      const points = joined.served
        .map(({ entity, row }) => ({
          ref: `${entity.id}@${entity.version}`,
          entityId: entity.id,
          version: entity.version,
          value: row.value,
          unit: row.unit,
          effectiveAt: String(entity.data.effectiveAt),
        }))
        .sort(
          (a, b) =>
            Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) ||
            a.entityId.localeCompare(b.entityId),
        )
        .slice(0, q.limit);
      await deps.store.audit(actor, 'query.vitals', patientId);
      return { code: q.code, points, ...finish(joined.coverage, joined.foreign, joined.truncated) };
    },

    async problems(actor, patientId, query = {}) {
      const status = z.string().min(1).max(40).optional().parse(query.status);
      await authorize(actor, patientId);
      const source = deps.source();
      if (!source.problems) throw new Fault(501, 'The content store has no problem query');
      const rows: ProblemRow[] = await source.problems(actor.tenant, patientId, QUERY_CAP);
      const link = await links(actor.tenant, patientId);
      const ledger = (await deps.store.list(actor.tenant, patientId, 'condition')).filter(
        (e) => e.data.status !== 'entered-in-error' && (!status || e.data.status === status),
      );
      const joined = join(
        ledger,
        rows,
        link,
        (e, r) =>
          e.data.code?.code === r.code &&
          e.data.code?.display === r.display &&
          (e.data.onset === undefined ? r.onset === undefined : sameDay(e.data.onset, r.onset)),
      );
      const problems = joined.served
        .map(({ entity, row }) => ({
          ref: `${entity.id}@${entity.version}`,
          entityId: entity.id,
          version: entity.version,
          ...(row.system ? { system: row.system } : {}),
          ...(row.code ? { code: row.code } : {}),
          display: row.display,
          ...(row.onset ? { onset: row.onset } : {}),
          status: String(entity.data.status),
        }))
        .sort((a, b) => a.entityId.localeCompare(b.entityId));
      await deps.store.audit(actor, 'query.problems', patientId);
      return { problems, ...finish(joined.coverage, joined.foreign, joined.truncated) };
    },
  };
}
