import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fromConfig } from '../packages/runtime.ts';

if (!process.env.EIR_CONFIG) throw new Error('Worker requires an explicit EIR_CONFIG');
const { runtime, config } = await fromConfig(resolve(process.env.EIR_CONFIG));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  if (!runtime.has('coordinationNotifications'))
    throw new Error('No coordination notifier configured');
  if (config.plugins.some((p) => p.config?.worker === true))
    throw new Error('Standalone worker requires embedded worker=false');
  do {
    try {
      console.log(
        JSON.stringify({
          event: 'coordination-notification-cycle',
          ...(await runtime.get('coordinationNotifications').runOnce()),
        }),
      );
    } catch {
      console.error('Coordination notification cycle failed; inspect delivery state');
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once') || stop.signal.aborted) break;
    await setTimeout(10000, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} finally {
  await runtime.stop();
}
