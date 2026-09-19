import { fileURLToPath } from 'node:url';
import { fromConfig } from '../packages/runtime.ts';
import type { Actor } from '../packages/contracts.ts';
import type { SqliteStore } from '../plugins/storage-sqlite.ts';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const doctor: Actor = { id: 'doctor-a', tenant: 'clinic-a', role: 'clinician' };
export async function fixture(path = ':memory:') {
  const { runtime } = await fromConfig(root + 'eir.config.json', {
    'eir.storage.sqlite': { path },
    'eir.care-team': {
      members: [
        { id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' },
        { id: 'nurse-a', tenant: 'clinic-a', name: 'David Ek', profession: 'Sjuksköterska' },
        { id: 'doctor-b', tenant: 'clinic-b', name: 'Other clinician', profession: 'Läkare' },
      ],
    },
  });
  const clinical = runtime.get('clinical'),
    store = runtime.get('store') as SqliteStore;
  const patient = await clinical.register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: 'TEST-001' },
  });
  const encounter = await clinical.create(doctor, patient.id, 'encounter', {
    reason: 'Testkontakt',
  });
  return { runtime, clinical, store, patient, encounter };
}
