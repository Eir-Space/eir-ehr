import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fromConfig } from '../packages/runtime.ts';

if (!process.env.EIR_CONFIG) throw new Error('Worker requires an explicit EIR_CONFIG');
const { runtime, config } = await fromConfig(resolve(process.env.EIR_CONFIG));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  if (!runtime.has('integrations')) throw new Error('No integration runtime configured');
  if (config.plugins.some((p) => p.config?.worker === true))
    throw new Error('Standalone worker requires embedded worker=false');
  const once = process.argv.includes('--once');
  do {
    try {
      const counts = await runtime.get('integrations').runOnce(stop.signal);
      console.log(JSON.stringify({ event: 'integration-cycle', ...counts }));
    } catch {
      console.error('Integration cycle failed; pending work remains durable');
      if (once) process.exitCode = 1;
    }
    if (once || stop.signal.aborted) break;
    await setTimeout(1000, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} finally {
  await runtime.stop();
}
