import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Fault, type Plugin } from '../packages/contracts.ts';
import type { ContentStore } from '../packages/content.ts';
import type { ClinicalRepository } from '../packages/clinical-repository.ts';

export default {
  id: 'eir.clinical-repository',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['clinicalRepository'],
  requires: ['clinicalModels'],
  setup(ctx, config) {
    const options = z
      .object({
        source: z.string().min(1),
        kinds: z.array(z.string().min(1)).min(1).default(['observation']),
      })
      .strict()
      .parse(config);
    const models = ctx.get('clinicalModels');
    const source = () => {
      const value = ctx.contributions('contentStore').get(options.source);
      if (!value) throw new Error(`Missing content store: ${options.source}`);
      return value;
    };
    const repository: ClinicalRepository = {
      key: options.source,
      kinds: options.kinds,
      operationLeaseMs() {
        const timeout = Number(
          (source() as ContentStore & { options?: { timeoutMs?: number } }).options?.timeoutMs,
        );
        return Number.isFinite(timeout) ? Math.max(60_000, timeout * 4 + 10_000) : 60_000;
      },
      model: (kind) => models.model(kind),
      async health() {
        const store = source();
        for (const kind of options.kinds) {
          if (!models.model(kind)) throw new Error(`Missing clinical model: ${kind}`);
          if (!store.kinds.includes(kind)) throw new Error(`Content store cannot persist ${kind}`);
        }
        await store.health();
      },
      async create(actor, kind, patientId, data, operationId) {
        if (!options.kinds.includes(kind))
          throw new Fault(422, `Non-canonical record type: ${kind}`);
        const store = source();
        if (!store.findByOrigin) throw new Error('Canonical repository requires idempotent create');
        const existing = await store.findByOrigin(actor.tenant, patientId, operationId);
        if (existing) {
          if (!isDeepStrictEqual(existing.data, data))
            throw new Fault(409, 'Operation id already committed with different clinical content');
          return existing;
        }
        try {
          return await store.insert(actor, kind, patientId, data, operationId);
        } catch (error) {
          const recovered = await store.findByOrigin(actor.tenant, patientId, operationId);
          if (recovered && isDeepStrictEqual(recovered.data, data)) return recovered;
          throw error;
        }
      },
      get: (tenant, id) => source().get(tenant, id),
      list: (tenant, patientId, kind) => source().list(tenant, patientId, kind),
      async revise(actor, entity, data, action) {
        const current = await source().get(actor.tenant, entity.id);
        if (!current) throw new Fault(404, 'Canonical clinical record not found');
        if (isDeepStrictEqual(current.data, data)) return current;
        if (current.version !== entity.version)
          throw new Fault(409, 'Canonical clinical record changed. Reload before saving.');
        return await source().revise(actor, current, current.version, data, action);
      },
      history: (tenant, id) => source().history(tenant, id),
    };
    ctx.provide('clinicalRepository', repository);
  },
} satisfies Plugin;
