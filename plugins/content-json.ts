import { z } from 'zod';
import { Fault, type Plugin } from '../packages/contracts.ts';
import type { ContentStore } from '../packages/content.ts';
import { listQueries } from '../packages/content-query.ts';

// The reference content provider: clinical kinds stored as validated JSON entities in the
// configured `store`. Behavior is exactly the existing store's, exposed through the seam.
const defaultKinds = ['observation', 'condition', 'note'];
export default {
  id: 'eir.content.json',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: ['store'],
  contributes: ['contentStore'],
  setup(ctx, config) {
    const options = z
      .object({
        key: z.string().min(1).default('json'),
        kinds: z.array(z.string().min(1)).min(1).default(defaultKinds),
      })
      .strict()
      .parse(config);
    const store = () => ctx.get('store');
    const supports = (kind: string) =>
      options.kinds.includes(kind) ||
      (() => {
        throw new Fault(422, `Unsupported record type: ${kind}`);
      })();
    const provider: ContentStore = {
      kinds: options.kinds,
      health: () => store().health(),
      async insert(actor, kind, patientId, data) {
        supports(kind);
        return await store().insert(actor, kind, patientId, data);
      },
      async get(tenant, id) {
        const entity = await store().get(tenant, id);
        return entity && options.kinds.includes(entity.kind) ? entity : undefined;
      },
      async list(tenant, patientId, kind) {
        if (kind !== undefined) supports(kind);
        const all = await store().list(tenant, patientId, kind);
        return all.filter((e) => options.kinds.includes(e.kind));
      },
      ...listQueries((tenant, patientId, kind) => provider.list(tenant, patientId, kind)),
      revise: (actor, entity, version, data, action) =>
        store().revise(actor, entity, version, data, action),
      history: (tenant, id) => store().history(tenant, id),
    };
    ctx.contribute('contentStore', options.key, provider);
  },
} satisfies Plugin;
