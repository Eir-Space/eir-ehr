// Projects the record ledger into the configured content store and reports drift.
//   EIR_CONFIG=eir.local.profile.yaml npm run projection:run         one pass
//   EIR_CONFIG=eir.local.profile.yaml npm run projection:reconcile   compare ledger and target
//   EIR_CONFIG=eir.local.profile.yaml npm run projection:loop        repeat until stopped
// Output is counts and record ids only, never clinical content. Run one projector per target.
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fromConfig } from '../packages/runtime.ts';

if (!process.env.EIR_CONFIG) throw new Error('Projection requires an explicit EIR_CONFIG');
const mode = process.argv[2] ?? 'run';
const { runtime } = await fromConfig(resolve(process.env.EIR_CONFIG));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  if (!runtime.has('projection')) throw new Error('No projection configured in this profile');
  const projection = runtime.get('projection');
  if (mode === 'reconcile') {
    const reports = await projection.reconcile();
    console.log(JSON.stringify({ event: 'reconcile', reports }, null, 2));
    if (reports.some((r) => Object.keys(r.counts).some((c) => c !== 'ok'))) process.exitCode = 2;
  } else {
    do {
      try {
        console.log(JSON.stringify({ event: 'projection', reports: await projection.runOnce() }));
      } catch {
        console.error('Projection cycle failed; the ledger is unaffected');
        process.exitCode = 1;
      }
      if (mode !== 'loop' || stop.signal.aborted) break;
      await setTimeout(15000, undefined, { signal: stop.signal }).catch(() => {});
    } while (!stop.signal.aborted);
  }
} finally {
  await runtime.stop();
}
