import { resolve } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
import { demoWorkforce } from './demo-workforce.ts';
import { seedDemo } from './seed.ts';
import { createApp } from './app.ts';

export const stagingTenant = 'eir-synthetic-staging';

// This profile is deliberately separate from both public visitor workspaces and clinic OIDC.
export async function createStaging(root: string) {
  const { runtime, config } = await fromConfig(resolve(root, 'eir.staging.config.json'), {
    'eir.workforce': demoWorkforce(stagingTenant, true),
  });
  try {
    const workforce = runtime.get('workforce');
    const assignments = await workforce.forIdentity('https://local.eir.invalid', 'emma');
    const assignment = assignments.find(
      (row) => row.data.role === 'clinician' && row.data.unitId === 'demo-primary-care',
    );
    if (!assignment) throw new Error('Synthetic staging clinician assignment is unavailable');
    const actor = workforce.actor(assignment);
    const store = runtime.get('store');
    await store.transaction(async () => {
      if (!(await store.list(stagingTenant, undefined, 'patient')).length)
        await seedDemo(runtime, actor);
    });
    const app = await createApp(runtime, root, config.chartRenderers, config.defaultRenderer);
    return { app, runtime, actor };
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}
