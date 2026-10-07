import type { Plugin } from '../packages/contracts.ts';
import { ollamaModel } from '../packages/ai-models.ts';
export default {
  id: 'eir.ai.ollama',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['aiProvider'],
  requires: [],
  setup(ctx, config) {
    ctx.provide('aiProvider', ollamaModel(config));
  },
} satisfies Plugin;
