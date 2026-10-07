import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  Fault,
  type Actor,
  type Entity,
  type Projection,
  type ProjectionReport,
  type ReconcileReport,
  type Store,
} from './contracts.ts';
import type { ContentStore } from './content.ts';

// Projects the SQL record ledger into a content store (for example openEHR).
//
// Authority: the SQL store is the legal ledger. Every clinical write, its version snapshot and its
// hash-chained audit row commit there in one transaction, exactly as before. The content store is a
// derived, queryable representation fed afterwards, so no clinical transaction ever waits on, or is
// rolled back by, an external system. There is no dual write: one writer path, then replication.
//
// Crash safety: each record has a `contentLink` row in the ledger. The link is written before the
// content store is touched (intent), carries an idempotency token, and is updated afterwards. A
// crash at any point leaves a state the next run resolves: the token finds a half-written record, and
// the content store's own version tells how much of the history is already replayed.
//
// Every link change is itself a hash-chained audit row, so every disclosure of clinical content to
// the content store is on the audit trail.
export const projectionOptions = z
  .object({
    target: z.string().min(1),
    tenants: z.array(z.string().min(1)).min(1),
    kinds: z.array(z.string().min(1)).min(1).default(['observation', 'condition', 'note']),
    batch: z.number().int().min(1).max(2000).default(200),
    // After a failure a record is retried after min(2^attempts * base, 5 minutes).
    backoffBaseMs: z.number().int().min(0).max(60000).default(1000),
  })
  .strict();
export type ProjectionOptions = z.infer<typeof projectionOptions>;

type Status = 'pending' | 'synced' | 'unmapped' | 'error';
type Link = {
  entityId: string;
  kind: string;
  target: string;
  token: string;
  contentId?: string;
  status: Status;
  syncedVersion: number;
  attempts: number;
  reason?: string;
  unmappedAt?: number;
  lastAttemptAt?: string;
  syncedAt?: string;
};
const LINK = 'contentLink';
const SAMPLE_LIMIT = 20;
// Only our own fault messages are recorded: other errors can echo clinical text.
const safeReason = (error: unknown) =>
  error instanceof Fault ? error.message : 'target unavailable';

export function createProjection(deps: {
  store: Store;
  content: () => ContentStore;
  options: unknown;
  now?: () => number;
}): Projection {
  const options = projectionOptions.parse(deps.options);
  const now = deps.now ?? Date.now;
  const machine = (tenant: string): Actor => ({ id: 'projection', tenant, role: 'integration' });

  async function linksFor(tenant: string) {
    const all = (await deps.store.list(tenant, undefined, LINK)).filter(
      (l) => l.data.target === options.target,
    );
    const byEntity = new Map<string, Entity[]>();
    for (const l of all)
      byEntity.set(l.data.entityId, [...(byEntity.get(l.data.entityId) ?? []), l]);
    return byEntity;
  }

  async function sync(
    actor: Actor,
    content: ContentStore,
    entity: Entity,
    existing: Entity | undefined,
    report: ProjectionReport,
  ) {
    let link = existing;
    const data = () => link!.data as Link;
    if (link && data().status === 'unmapped' && data().unmappedAt === entity.version)
      return void report.unmapped++;
    if (link && data().status === 'synced' && data().syncedVersion === entity.version)
      return void report.upToDate++;
    if (link && data().status === 'error' && data().lastAttemptAt) {
      const wait = Math.min(2 ** data().attempts * options.backoffBaseMs, 300000);
      if (now() - Date.parse(data().lastAttemptAt!) < wait) return void report.deferred++;
    }
    if (!link)
      link = await deps.store.insert(actor, LINK, entity.patientId, {
        entityId: entity.id,
        kind: entity.kind,
        target: options.target,
        token: randomUUID(),
        status: 'pending',
        syncedVersion: 0,
        attempts: 0,
      } satisfies Link);
    const save = async (patch: Partial<Link>, action: string) => {
      link = await deps.store.revise(
        actor,
        link!,
        link!.version,
        { ...link!.data, ...patch },
        action,
      );
    };
    try {
      const history = await deps.store.history(entity.tenant, entity.id);
      if (history.at(-1)?.version !== entity.version || history.length !== entity.version)
        throw new Fault(409, 'Record changed during projection');
      let remote: Entity | undefined;
      if (data().contentId) {
        remote = await content.get(entity.tenant, data().contentId!);
        if (!remote) throw new Fault(404, 'Content record is missing in the target');
      } else {
        remote =
          (await content.findByOrigin?.(entity.tenant, entity.patientId, data().token)) ??
          (await content.insert(
            actor,
            entity.kind,
            entity.patientId,
            history[0].data,
            data().token,
          ));
        await save({ contentId: remote.id }, 'contentLink.linked');
      }
      if (remote.version > entity.version) throw new Fault(409, 'Content is ahead of the ledger');
      for (let v = remote.version + 1; v <= entity.version; v++)
        remote = await content.revise(
          actor,
          remote,
          remote.version,
          history[v - 1].data,
          'projection.revise',
        );
      if (!isDeepStrictEqual(remote.data, entity.data))
        throw new Fault(409, 'Content differs from the ledger');
      await save(
        {
          status: 'synced',
          syncedVersion: entity.version,
          attempts: 0,
          reason: undefined,
          syncedAt: new Date(now()).toISOString(),
        },
        'contentLink.synced',
      );
      report.projected++;
    } catch (error) {
      if (error instanceof Fault && error.status === 422) {
        await save(
          { status: 'unmapped', reason: error.message, unmappedAt: entity.version },
          'contentLink.unmapped',
        );
        report.unmapped++;
      } else {
        await save(
          {
            status: 'error',
            attempts: data().attempts + 1,
            reason: safeReason(error),
            lastAttemptAt: new Date(now()).toISOString(),
          },
          'contentLink.failed',
        );
        report.failed++;
      }
    }
  }

  // Without idempotent inserts, a crash between writing content and recording its id would
  // duplicate a clinical record on retry, so such a target is refused outright.
  const ready = () => {
    const content = deps.content();
    if (!content.findByOrigin)
      throw new Error(`Content store ${options.target} does not support idempotent inserts`);
    return content;
  };

  return {
    async runOnce() {
      const content = ready();
      const reports: ProjectionReport[] = [];
      for (const tenant of options.tenants) {
        const report: ProjectionReport = {
          tenant,
          scanned: 0,
          projected: 0,
          upToDate: 0,
          unmapped: 0,
          failed: 0,
          deferred: 0,
        };
        const links = await linksFor(tenant);
        const actor = machine(tenant);
        let work = 0;
        for (const kind of options.kinds) {
          const entities = (await deps.store.list(tenant, undefined, kind)).sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          );
          for (const entity of entities) {
            report.scanned++;
            if (work >= options.batch) {
              report.deferred++;
              continue;
            }
            const before = report.projected + report.unmapped + report.failed;
            try {
              await sync(actor, content, entity, links.get(entity.id)?.[0], report);
            } catch {
              // The ledger itself could not be updated (for example a concurrent projector).
              report.failed++;
            }
            work += report.projected + report.unmapped + report.failed - before;
          }
        }
        reports.push(report);
      }
      return reports;
    },

    async reconcile() {
      const content = ready();
      const reports: ReconcileReport[] = [];
      for (const tenant of options.tenants) {
        const counts: Record<string, number> = {};
        const samples: Record<string, string[]> = {};
        const note = (category: string, id: string) => {
          counts[category] = (counts[category] ?? 0) + 1;
          const list = (samples[category] ??= []);
          if (list.length < SAMPLE_LIMIT) list.push(id);
        };
        const links = await linksFor(tenant);
        let entities = 0;
        for (const kind of options.kinds)
          for (const entity of await deps.store.list(tenant, undefined, kind)) {
            entities++;
            const found = links.get(entity.id) ?? [];
            if (found.length > 1) note('duplicate-link', entity.id);
            const link = found[0]?.data as Link | undefined;
            if (!link) note('unlinked', entity.id);
            else if (link.status !== 'synced') note(link.status, entity.id);
            else if (link.syncedVersion < entity.version) note('behind', entity.id);
            else {
              const remote = link.contentId ? await content.get(tenant, link.contentId) : undefined;
              if (!remote) note('missing', entity.id);
              else if (remote.version < entity.version) note('behind', entity.id);
              else if (remote.version > entity.version) note('ahead', entity.id);
              else if (!isDeepStrictEqual(remote.data, entity.data)) note('diverged', entity.id);
              else note('ok', entity.id);
            }
          }
        reports.push({ tenant, entities, counts, samples });
      }
      return reports;
    },
  };
}
