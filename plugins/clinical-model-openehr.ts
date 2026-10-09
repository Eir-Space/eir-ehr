import type { Plugin } from '../packages/contracts.ts';
import { createOpenEhrModelRegistry } from '../packages/clinical-models.ts';

export default {
  id: 'eir.clinical-model.openehr',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['clinicalModels'],
  requires: [],
  async setup(ctx) {
    ctx.provide('clinicalModels', await createOpenEhrModelRegistry());
  },
} satisfies Plugin;
