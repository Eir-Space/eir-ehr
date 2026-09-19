import { fromConfig } from '../packages/runtime.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { root } from './helpers.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
export async function staffFixture(
  path = ':memory:',
  identity?: { module: string; config: Record<string, unknown> },
) {
  const config = demoWorkforce('clinic-a');
  config.units.push({ id: 'other-unit', tenant: 'clinic-a', name: 'Other care unit' });
  config.units.push({ id: 'other-provider', tenant: 'clinic-b', name: 'Other provider' });
  const original = config.bootstrap[0];
  config.bootstrap.push({ ...original, unitId: 'other-unit' });
  config.bootstrap.push({ ...original, unitId: 'other-provider' });
  config.bootstrap.push({
    ...original,
    actorId: 'reviewer',
    subject: 'reviewer',
    role: 'auditor',
    permissions: ['audit.review'],
  });
  const loaded = await fromConfig(root + 'eir.demo.config.json', {
    'eir.storage.sqlite': { path },
    'eir.workforce': config,
  });
  if (identity) throw new Error('Use the OIDC fixture for identity replacement');
  const runtime = loaded.runtime,
    workforce = runtime.get('workforce'),
    store = runtime.get('store') as SqliteStore;
  const find = async (subject: string, role = 'clinician', unit = 'demo-primary-care') =>
    workforce.actor(
      (await workforce.forIdentity('https://local.eir.invalid', subject)).find(
        (r) => r.data.role === role && r.data.unitId === unit,
      )!,
    );
  const doctor = await find('emma'),
    admin = await find('emma', 'administrator'),
    reviewer = await find('reviewer', 'auditor'),
    nurse = await find('david');
  const patient = await runtime.get('clinical').register(doctor, {
    name: 'Anna Lindberg',
    birthDate: '1980-01-01',
    identifier: { type: 'local', value: 'STAFF-TEST-01' },
  });
  const encounter = await runtime
    .get('clinical')
    .create(doctor, patient.id, 'encounter', { reason: 'Uppföljning' });
  return { runtime, workforce, store, doctor, admin, reviewer, nurse, patient, encounter, find };
}
