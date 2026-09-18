import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromConfig } from '../packages/runtime.ts';
import { createApp } from './app.ts';
import type { Actor } from '../packages/contracts.ts';
import { seedDemo } from './seed.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { runtime, config } = await fromConfig(resolve(process.env.EIR_CONFIG ?? 'eir.config.json'));
const actor: Actor = { id: 'demo-clinician', tenant: 'demo-vardcentral', role: 'clinician' };
if (
  process.env.EIR_DEMO === '1' &&
  !runtime.get('store').list(actor.tenant, undefined, 'patient').length
) {
  seedDemo(runtime, actor);
}
const app = await createApp(runtime, root, config.chartRenderers, config.defaultRenderer);
const address = await app.listen({ port: Number(process.env.PORT ?? 4180), host: '127.0.0.1' });
console.log(`Eir EHR: ${address}`);
const token = runtime.get('identity').issue?.(actor);
if (token) console.log(`Local clinician session (8 hours): ${token}`);
const shutdown = async () => {
  await app.close();
  runtime.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
