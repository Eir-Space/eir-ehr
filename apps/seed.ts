import type { Actor } from '../packages/contracts.ts';
import type { Runtime } from '../packages/runtime.ts';

export function seedDemo(runtime: Runtime, actor: Actor) {
  const clinical = runtime.get('clinical');
  const patient = clinical.register(actor, {
    name: 'Alex Exempel',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: 'DEMO-001' },
  });
  const encounter = clinical.create(actor, patient.id, 'encounter', {
    reason: 'Uppföljning på vårdcentralen',
  });
  clinical.create(actor, patient.id, 'observation', {
    encounterId: encounter.id,
    code: '8867-4',
    value: 72,
    unit: '/min',
    effectiveAt: new Date().toISOString(),
  });
  clinical.create(actor, patient.id, 'note', {
    encounterId: encounter.id,
    text: 'Syntetiskt utbildningsexempel. Patienten kommer för uppföljning. Inga behandlingsbeslut dokumenterade.',
  });
  clinical.create(actor, patient.id, 'task', {
    title: 'Boka uppföljningskontakt',
    due: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  });
}
