import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { MemoryContent } from '../packages/memory-content.ts';

// A non-persistent content store for development and evaluation runs. Each runtime gets its own.
export default {
  id: 'eir.content.memory',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['contentStore'],
  setup(ctx, config) {
    const { key } = z
      .object({ key: z.string().min(1).default('memory') })
      .strict()
      .parse(config);
    ctx.contribute('contentStore', key, new MemoryContent());
  },
} satisfies Plugin;
