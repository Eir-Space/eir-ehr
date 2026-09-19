import { z } from 'zod';
export const permissions = [
  'chart.read',
  'chart.export',
  'patient.register',
  'record.write',
  'note.sign',
  'medication.write',
  'medication.reconcile',
  'lab.order',
  'lab.receive',
  'lab.review',
  'schedule.write',
  'task.write',
  'ai.use',
  'access.manage',
  'access.emergency',
  'patient.protected',
  'workforce.manage',
  'audit.review',
] as const;
const short = z.string().trim().min(1).max(200);
export const assignmentInput = z
  .object({
    actorId: short,
    name: short,
    unitId: short,
    issuer: z.url(),
    subject: short,
    role: z.enum(['clinician', 'auditor', 'administrator']),
    permissions: z.array(z.enum(permissions)).max(permissions.length),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.validUntil <= data.validFrom)
      ctx.addIssue({ code: 'custom', message: 'Invalid assignment validity' });
    const allowed =
      data.role === 'administrator'
        ? ['workforce.manage']
        : data.role === 'auditor'
          ? ['audit.review']
          : permissions.filter((p) => !['workforce.manage', 'audit.review'].includes(p));
    if (data.permissions.some((p) => !allowed.includes(p)))
      ctx.addIssue({
        code: 'custom',
        message: 'Separate clinical, administrative and audit assignments are required',
      });
    if (new Set(data.permissions).size !== data.permissions.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate permission' });
  });
export const assignmentChange = z
  .object({
    enabled: z.boolean(),
    permissions: z.array(z.enum(permissions)).max(permissions.length),
    validUntil: z.iso.datetime(),
    reason: short,
  })
  .strict();
export const reasonInput = z.object({ reason: short }).strict();
export const auditQuery = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    actorId: z.string().max(200).optional(),
    patientId: z.uuid().optional(),
    outcome: z.enum(['success', 'denied']).optional(),
  })
  .strict();
export const auditReviewInput = z
  .object({
    seq: z.number().int().positive(),
    hash: z.string().length(64),
    decision: z.enum(['justified', 'follow-up']),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const protectionInput = z.object({ protected: z.boolean(), reason: short }).strict();
export const activeAssignment = (row: { data: Record<string, any> }) =>
  row.data.enabled &&
  row.data.validFrom <= new Date().toISOString() &&
  row.data.validUntil > new Date().toISOString();
