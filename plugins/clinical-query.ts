import type { Plugin } from '../packages/contracts.ts';
import { clinicalQueryOptions, createClinicalQuery } from '../packages/clinical-query.ts';

// Typed clinical reads served from the content store registered under `source`, verified against
// the ledger. Requires the projection to have replicated records into that store.
export default {
  id: 'eir.clinical-query',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['clinicalQuery'],
  requires: ['store', 'access'],
  setup(ctx, config) {
    const options = clinicalQueryOptions.parse(config);
    ctx.provide(
      'clinicalQuery',
      createClinicalQuery({
        store: ctx.get('store'),
        access: ctx.get('access'),
        options,
        source: () => {
          const found = ctx.contributions('contentStore').get(options.source);
          if (!found) throw new Error(`Content store ${options.source} is not registered`);
          return found;
        },
      }),
    );
  },
} satisfies Plugin;
