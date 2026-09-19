import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Plugin } from '../packages/contracts.ts';
import { assert } from '../packages/contracts.ts';
import { policyInput } from '../packages/follow-up.ts';

export default {
  id: 'eir.follow-up.policy',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['followUpPolicy'],
  requires: [],
  setup(ctx, config) {
    const settings = z
      .object({
        developmentDefaults: z.boolean().default(false),
        policies: z
          .array(policyInput.extend({ tenant: z.string(), unitId: z.string() }))
          .default([]),
      })
      .strict()
      .parse(config);
    assert(
      new Set(settings.policies.map((p) => `${p.tenant}/${p.unitId}`)).size ===
        settings.policies.length,
      422,
      'Duplicate follow-up policy',
    );
    for (const p of settings.policies) Temporal.Now.zonedDateTimeISO(p.timeZone);
    ctx.provide('followUpPolicy', {
      resolve(tenant, unitId) {
        const found = settings.policies.find((p) => p.tenant === tenant && p.unitId === unitId);
        if (found) {
          const { tenant: _tenant, unitId: _unitId, ...value } = found;
          return value;
        }
        return settings.developmentDefaults
          ? {
              version: 'synthetic-development-only',
              timeZone: 'Europe/Stockholm',
              reviewMinutes: 1440,
              criticalReviewMinutes: 15,
              escalationMinutes: 30,
              reminderMinutes: 60,
            }
          : undefined;
      },
    });
  },
} satisfies Plugin;
