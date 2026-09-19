import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';
import type { CoordinationUnit } from '../packages/coordination.ts';

export default {
  id: 'eir.coordination.directory',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['coordinationDirectory'],
  requires: ['workforce'],
  setup(ctx, config) {
    const settings = z
      .object({
        units: z
          .array(
            z
              .object({
                unitId: z.string(),
                organisationId: z.string().min(1),
                organisationName: z.string().min(1),
                kind: z.enum(['hospital', 'primary-care', 'municipality']),
                notificationRecipient: z.string().min(1).max(200).optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .parse(config);
    assert(
      new Set(settings.units.map((u) => u.unitId)).size === settings.units.length,
      422,
      'Duplicate coordination unit',
    );
    const units: CoordinationUnit[] = ctx.get('workforce').units.flatMap((u) => {
      const entry = settings.units.find((e) => e.unitId === u.id);
      return entry
        ? [
            {
              ...u,
              organisationId: entry.organisationId,
              organisationName: entry.organisationName,
              kind: entry.kind,
              notificationRecipient: entry.notificationRecipient,
            },
          ]
        : [];
    });
    ctx.provide('coordinationDirectory', {
      units: (tenant) => units.filter((u) => u.tenant === tenant),
      unit: (tenant, id) => units.find((u) => u.tenant === tenant && u.id === id),
    });
  },
} satisfies Plugin;
