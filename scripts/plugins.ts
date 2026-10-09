import { resolve } from 'node:path';
import { fromConfig, loadProfile } from '../packages/runtime.ts';
const path = resolve(process.env.EIR_CONFIG ?? 'eir.config.json');
if (process.argv.includes('--dump')) {
  // Resolve layers, manifests and policy without starting any plugin.
  const { config, loaded } = await loadProfile(path);
  console.log(JSON.stringify({ ...config, rows: undefined, plugins: undefined }, null, 2));
  console.table(
    loaded.map(({ row, plugin, manifest }) => ({
      row: row.id,
      plugin: plugin.id,
      provides: plugin.provides.join(', '),
      contributes: (plugin.contributes ?? []).join(', '),
      network: manifest?.network ?? 'undeclared',
      manifest: manifest ? 'yes' : 'no',
    })),
  );
} else {
  const { runtime } = await fromConfig(path, { 'eir.storage.sqlite': { path: ':memory:' } });
  console.table(
    runtime.active.map((p) => ({
      plugin: p.id,
      version: p.version,
      provides: p.provides.join(', '),
      requires: p.requires.join(', '),
    })),
  );
  await runtime.stop();
}
