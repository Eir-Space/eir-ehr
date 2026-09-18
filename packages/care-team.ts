import { z } from 'zod';

const short = z.string().trim().min(1).max(200);
export const bookingInput = z
  .object({
    practitionerId: short,
    localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    durationMinutes: z.number().int().min(5).max(240),
    reason: short,
    type: z.enum(['visit', 'phone', 'video']).default('visit'),
  })
  .strict();
export const taskInput = z
  .object({
    title: short,
    due: z.iso.date(),
    assigneeId: short.optional(),
    priority: z.enum(['routine', 'urgent']).default('routine'),
  })
  .strict();
