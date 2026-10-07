import { Runtime } from '../packages/runtime.ts';
import storage from '../plugins/storage-sqlite.ts';
import content from '../plugins/content-json.ts';
import { runContentContract } from './content-contract.ts';

runContentContract('json content store', async () => {
  const runtime = await new Runtime().start([
    { plugin: storage, config: { path: ':memory:' } },
    { plugin: content },
  ]);
  return { store: runtime.contributions('contentStore').get('json')!, stop: () => runtime.stop() };
});
