import { MemoryContent } from './memory-content.ts';
import { runContentContract } from './content-contract.ts';

runContentContract('memory content store', async () => ({
  store: new MemoryContent(),
  stop: async () => {},
}));
