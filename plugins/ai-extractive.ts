import type { Plugin } from '../packages/contracts.ts';
export default {
  id: 'eir.ai.extractive',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['aiProvider'],
  requires: [],
  setup(ctx) {
    ctx.provide('aiProvider', {
      id: 'extractive-v1',
      async generate(evidence) {
        const selected = evidence.slice(0, 30);
        return {
          mode: 'extractive',
          model: 'extractive-v1 (no language model)',
          text: selected.map((source) => source.text).join('\n\n'),
          citations: selected,
        };
      },
    });
  },
} satisfies Plugin;
