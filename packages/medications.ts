import { z } from 'zod';
export const medicationFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    dosageText: z.string().trim().min(1).max(500).nullable(),
    indication: z.string().trim().max(500),
    source: z.enum(['patient', 'record', 'caregiver']),
    sourceDetail: z.string().trim().min(1).max(500),
    status: z.enum(['active', 'on-hold', 'stopped', 'entered-in-error']),
  })
  .strict();
export const medicationInput = medicationFields.extend({ clientId: z.uuid() });
export const medicationUpdate = medicationFields.extend({
  reason: z.string().trim().min(1).max(500),
});
export const reconciliationInput = z
  .object({
    clientId: z.uuid(),
    snapshot: z.array(z.string().regex(/^[0-9a-f-]{36}@[1-9][0-9]*$/)).max(1000),
    source: z.string().trim().min(1).max(500),
    note: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
    noCurrentMedicines: z.boolean(),
  })
  .strict();
