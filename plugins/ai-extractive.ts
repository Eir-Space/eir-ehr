import type { Plugin } from '../packages/contracts.ts';
import { extractiveModel } from '../packages/ai-models.ts';
export default {
  id: 'eir.ai.extractive',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['aiProvider'],
  requires: [],
  setup(ctx) {
    ctx.provide('aiProvider', extractiveModel());
  },
} satisfies Plugin;
