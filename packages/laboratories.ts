import { z } from 'zod';
const short = z.string().trim().min(1).max(200);
export const labOrderInput = z
  .object({
    clientId: z.uuid(),
    encounterId: z.uuid(),
    test: short,
    question: z.string().trim().min(1).max(2000),
    specimen: short,
    assigneeId: short,
    due: z.iso.date(),
    expectedAt: z.iso.datetime({ offset: true }).optional(),
    priority: z.enum(['routine', 'urgent']),
  })
  .strict();
export const labResultItem = z
  .object({
    name: short,
    value: z.string().trim().min(1).max(500),
    unit: z.string().trim().max(80),
    reference: z.string().trim().max(200),
    flag: z.enum(['unknown', 'normal', 'high', 'low', 'critical']),
  })
  .strict();
export const labReportInput = z
  .object({
    messageId: short,
    source: short,
    collectedAt: z.iso.datetime({ offset: true }),
    reportedAt: z.iso.datetime({ offset: true }),
    results: z.array(labResultItem).min(1).max(30),
    correctionReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export const labReviewInput = z
  .object({
    reportId: z.uuid(),
    taskVersion: z.number().int().positive(),
    assessment: z.string().trim().min(1).max(2000),
    action: z.string().trim().min(1).max(2000),
    communication: z.string().trim().min(1).max(1000),
    criticalAcknowledged: z.boolean(),
    disposition: z.enum(['completed', 'action-required']).optional(),
    actionDueAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (v) => v.disposition !== 'action-required' || !!v.actionDueAt,
    'An action deadline is required',
  );
export const labCancelInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
