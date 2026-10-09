import type { Plugin } from '../packages/contracts.ts';
import { MemoryContent } from '../packages/memory-content.ts';

export { MemoryContent };
export const memory = new MemoryContent();
export default {
  id: 'test.content.memory',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['contentStore'],
  setup: (ctx) => ctx.contribute('contentStore', 'memory', memory),
} satisfies Plugin;
