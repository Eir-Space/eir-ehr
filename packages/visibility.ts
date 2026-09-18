import type { Actor, Entity } from './contracts.ts';

// New workflow records are clinician-only until a patient-release policy is implemented.
export function visibleRecord(actor: Actor, record: Entity) {
  return (
    actor.role === 'clinician' ||
    (![
      'proposal',
      'task',
      'appointment',
      'medication',
      'medicationReview',
      'labOrder',
      'labReport',
      'labReview',
    ].includes(record.kind) &&
      (record.kind !== 'note' || record.data.status === 'signed'))
  );
}
