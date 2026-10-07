import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { extractiveModel } from '../packages/ai-models.ts';
export default {
  id: 'eir.model.extractive',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['aiModel'],
  setup(ctx, config) {
    const { key } = z
      .object({ key: z.string().min(1).default('extractive') })
      .strict()
      .parse(config);
    ctx.contribute('aiModel', key, extractiveModel());
  },
} satisfies Plugin;
