import type { Plugin } from '../packages/contracts.ts';
import { createOpenEhrStore, openEhrOptions } from '../packages/openehr.ts';

// Registers an openEHR-backed content store (observations, diagnoses and notes) under a key.
// Nothing here talks to the network until the store is used; call `health()` to verify the
// server and the uploaded templates.
export default {
  id: 'eir.content.openehr',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['contentStore'],
  setup(ctx, config) {
    const store = createOpenEhrStore(config);
    ctx.contribute('contentStore', openEhrOptions.parse(config).key, store);
  },
} satisfies Plugin;
