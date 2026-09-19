import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fromConfig } from '../packages/runtime.ts';

if (!process.env.EIR_CONFIG) throw new Error('Worker requires an explicit EIR_CONFIG');
const { runtime, config } = await fromConfig(resolve(process.env.EIR_CONFIG));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  if (!runtime.has('followUp')) throw new Error('No follow-up runtime configured');
  if (config.plugins.some((p) => p.config?.worker === true))
    throw new Error('Standalone worker requires embedded worker=false');
  do {
    try {
      console.log(
        JSON.stringify({ event: 'follow-up-cycle', ...(await runtime.get('followUp').runOnce()) }),
      );
    } catch {
      console.error('Follow-up cycle failed; clinical work remains open');
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once') || stop.signal.aborted) break;
    await setTimeout(5000, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} finally {
  await runtime.stop();
}
