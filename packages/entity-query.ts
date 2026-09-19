import { z } from 'zod';

export const entityQuery = z
  .object({
    equals: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
        z.union([z.string().max(500), z.number().finite(), z.boolean()]),
      )
      .default({}),
    dueBefore: z.iso.datetime().optional(),
    statuses: z.array(z.string().min(1).max(80)).min(1).max(10).optional(),
    after: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type EntityQuery = z.input<typeof entityQuery>;
