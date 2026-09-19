import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Plugin } from '../packages/contracts.ts';

export default {
  id: 'eir.coordination.payment',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['coordinationPayment'],
  requires: [],
  setup(ctx, config) {
    const policy = z
      .object({
        version: z.string().min(1).default('unconfigured'),
        dailyRateOre: z.number().int().nonnegative().max(10000000).optional(),
        graceDays: z.number().int().min(0).max(30).default(3),
        cutoffHour: z.number().int().min(0).max(23).default(12),
        timeZone: z.string().default('Europe/Stockholm'),
        includeDischargeDay: z.boolean().default(false),
        developmentOnly: z.boolean().default(true),
      })
      .strict()
      .parse(config);
    Temporal.Now.zonedDateTimeISO(policy.timeZone);
    ctx.provide('coordinationPayment', {
      calculate(facts) {
        const result = {
          policyVersion: policy.version,
          status: 'blocked' as 'blocked' | 'estimate',
          reasons: [] as string[],
          startOn: null as string | null,
          endOn: null as string | null,
          days: 0,
          amountOre: 0,
          currency: 'SEK' as const,
          developmentOnly: policy.developmentOnly,
        };
        if (policy.dailyRateOre === undefined)
          result.reasons.push('Ingen beslutad dygnsersättning har konfigurerats');
        if (!facts.admissionAt || !facts.readyAt)
          result.reasons.push('Inskrivning och meddelande om utskrivningsklar krävs');
        if (!facts.outpatientAvailable)
          result.reasons.push('Öppenvårdens insatser är inte bekräftat tillgängliga');
        if (facts.interrupted) result.reasons.push('Processen är avbruten');
        if (facts.sipRequired && !facts.invitedAt) result.reasons.push('Kallelse till SIP saknas');
        if (!facts.readyAt || result.reasons.length) return result;
        const ready = Temporal.Instant.from(facts.readyAt).toZonedDateTimeISO(policy.timeZone);
        if (
          facts.sipRequired &&
          facts.invitedAt &&
          Temporal.PlainDate.compare(
            Temporal.Instant.from(facts.invitedAt)
              .toZonedDateTimeISO(policy.timeZone)
              .toPlainDate(),
            ready.toPlainDate().add({ days: 3 }),
          ) > 0
        ) {
          result.reasons.push('SIP-kallelsen kräver manuell prövning av tidsgränsen');
          return result;
        }
        const late =
          Temporal.PlainTime.compare(
            ready.toPlainTime(),
            Temporal.PlainTime.from({ hour: policy.cutoffHour }),
          ) > 0;
        const start = ready.toPlainDate().add({ days: policy.graceDays + (late ? 1 : 0) });
        const end = Temporal.Instant.from(facts.dischargedAt ?? facts.asOf)
          .toZonedDateTimeISO(policy.timeZone)
          .toPlainDate();
        const days = Math.max(
          0,
          start.until(end).days + (facts.dischargedAt && policy.includeDischargeDay ? 1 : 0),
        );
        if (days > 730) {
          result.reasons.push('Perioden överstiger gränsen för automatisk beräkning');
          return result;
        }
        return {
          ...result,
          status: 'estimate',
          startOn: start.toString(),
          endOn: end.toString(),
          days,
          amountOre: days * policy.dailyRateOre!,
        };
      },
    });
  },
} satisfies Plugin;
