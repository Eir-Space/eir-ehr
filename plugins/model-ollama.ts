import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { ollamaModel, ollamaOptions } from '../packages/ai-models.ts';
// Registers a local Ollama model as a named candidate. Several can coexist under different keys.
export default {
  id: 'eir.model.ollama',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['aiModel'],
  setup(ctx, config) {
    const { key, ...options } = z
      .object({ key: z.string().min(1).default('ollama') })
      .extend(ollamaOptions.shape)
      .strict()
      .parse(config);
    ctx.contribute('aiModel', key, ollamaModel(options));
  },
} satisfies Plugin;
