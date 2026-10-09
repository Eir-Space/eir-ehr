import type { Plugin } from '../packages/contracts.ts';
import { createProjection, projectionOptions } from '../packages/projection.ts';

// Replicates ledger records into the content store registered under `target`. It does nothing
// until `runOnce()` is called (see scripts/projection.ts); it never runs inside a clinical request.
export default {
  id: 'eir.projection',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['projection'],
  requires: ['store'],
  setup(ctx, config) {
    const options = projectionOptions.parse(config);
    ctx.provide(
      'projection',
      createProjection({
        store: ctx.get('store'),
        options,
        content: () => {
          const target = ctx.contributions('contentStore').get(options.target);
          if (!target) throw new Error(`Content store ${options.target} is not registered`);
          return target;
        },
      }),
    );
  },
} satisfies Plugin;
