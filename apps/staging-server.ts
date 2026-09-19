import { fileURLToPath } from 'node:url';
import { createStaging } from './staging.ts';

if (process.env.EIR_SYNTHETIC_STAGING !== '1')
  throw new Error('Set EIR_SYNTHETIC_STAGING=1 for this persistent synthetic-only environment');
const root = fileURLToPath(new URL('../', import.meta.url));
const { runtime, app, actor } = await createStaging(root);
try {
  const address = await app.listen({ port: Number(process.env.PORT ?? 4194), host: '127.0.0.1' });
  console.log(`Persistent synthetic staging: ${address}`);
  const token = await runtime.get('identity').issue!(actor);
  console.log(`Local synthetic clinician session: ${token}`);
} catch (error) {
  await app.close();
  await runtime.stop();
  throw error;
}
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await runtime.stop();
};
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
