import { resolve } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
const { runtime } = await fromConfig(resolve(process.env.EIR_CONFIG ?? 'eir.config.json'), {
  'eir.storage.sqlite': { path: ':memory:' },
});
console.table(
  runtime.active.map((p) => ({
    plugin: p.id,
    version: p.version,
    provides: p.provides.join(', '),
    requires: p.requires.join(', '),
  })),
);
await runtime.stop();
