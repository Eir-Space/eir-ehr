import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { digest, type RiskEngine, type RiskOutput } from '../packages/deterioration.ts';

const rule = z
  .object({
    code: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().min(1),
    minValid: z.number().finite(),
    maxValid: z.number().finite(),
    low: z.number().finite().optional(),
    high: z.number().finite().optional(),
    rise: z.number().positive().optional(),
    fall: z.number().positive().optional(),
  })
  .strict();
// Demonstration thresholds, not a NEWS2 score, a CHARTwatch replica, or a mortality model.
const defaults = [
  {
    code: '8867-4',
    label: 'Puls',
    unit: '/min',
    minValid: 1,
    maxValid: 350,
    low: 40,
    high: 130,
    rise: 30,
  },
  {
    code: '8480-6',
    label: 'Systoliskt blodtryck',
    unit: 'mm[Hg]',
    minValid: 20,
    maxValid: 350,
    low: 90,
    fall: 30,
  },
  {
    code: '9279-1',
    label: 'Andningsfrekvens',
    unit: '/min',
    minValid: 1,
    maxValid: 100,
    low: 8,
    high: 25,
    rise: 8,
  },
  {
    code: '59408-5',
    label: 'Syremättnad',
    unit: '%',
    minValid: 1,
    maxValid: 100,
    low: 91,
    fall: 4,
  },
  {
    code: '8310-5',
    label: 'Temperatur',
    unit: 'Cel',
    minValid: 20,
    maxValid: 50,
    low: 35,
    high: 39.1,
    rise: 2,
  },
];
export default {
  id: 'eir.risk.vitals',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['riskEngine'],
  requires: [],
  setup(ctx, config) {
    const settings = z
      .object({
        version: z.string().min(1).default('demo-v1'),
        maxAgeMinutes: z.number().int().min(1).max(1440).default(240),
        trendMinutes: z.number().int().min(1).max(1440).default(360),
        rules: z.array(rule).min(1).max(30).default(defaults),
      })
      .strict()
      .parse(config);
    if (
      new Set(settings.rules.map((r) => r.code)).size !== settings.rules.length ||
      settings.rules.some(
        (r) =>
          r.minValid >= r.maxValid ||
          (r.low !== undefined && r.high !== undefined && r.low >= r.high),
      )
    )
      throw new Error('Invalid vital rule definition');
    const engine: RiskEngine = {
      id: 'eir.risk.vitals',
      version: `${settings.version}+${digest(settings).slice(0, 12)}`,
      label: 'Vitalparametrar och trender',
      intendedUse: 'Utvecklingsregler. Inte CHARTwatch, NEWS2 eller en validerad riskmodell.',
      async evaluate(input) {
        const result: RiskOutput = { status: 'no-trigger', findings: [], missing: [] };
        if (input.ageYears < 18 || !Number.isFinite(input.ageYears))
          return { ...result, status: 'insufficient-data', missing: ['Vuxenpopulation krävs'] };
        for (const r of settings.rules) {
          const values = input.readings
            .filter(
              (v) => v.kind === 'vital' && v.system === 'http://loinc.org' && v.code === r.code,
            )
            .sort(
              (a, b) =>
                Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || a.ref.localeCompare(b.ref),
            );
          const latest = values[0];
          const valid = (v: typeof latest) =>
            v &&
            v.unit === r.unit &&
            Number.isFinite(v.value) &&
            v.value >= r.minValid &&
            v.value <= r.maxValid &&
            Number.isFinite(Date.parse(v.effectiveAt)) &&
            Date.parse(v.effectiveAt) <= Date.parse(input.evaluatedAt);
          if (
            !valid(latest) ||
            Date.parse(input.evaluatedAt) - Date.parse(latest.effectiveAt) >=
              settings.maxAgeMinutes * 60000 ||
            values.some((v) => v.effectiveAt === latest.effectiveAt && v.value !== latest.value)
          ) {
            result.missing.push(r.label);
            continue;
          }
          if (
            (r.low !== undefined && latest.value <= r.low) ||
            (r.high !== undefined && latest.value >= r.high)
          )
            result.findings.push({
              code: r.code + ':limit',
              text: `${r.label}: ${latest.value} ${r.unit}`,
              refs: [latest.ref],
            });
          const previous = values.find(
            (v) =>
              valid(v) &&
              Date.parse(v.effectiveAt) < Date.parse(latest.effectiveAt) &&
              Date.parse(latest.effectiveAt) - Date.parse(v.effectiveAt) <=
                settings.trendMinutes * 60000,
          );
          if (
            previous &&
            ((r.rise !== undefined && latest.value - previous.value >= r.rise) ||
              (r.fall !== undefined && previous.value - latest.value >= r.fall))
          )
            result.findings.push({
              code: r.code + ':trend',
              text: `${r.label}: ${previous.value} → ${latest.value} ${r.unit}`,
              refs: [previous.ref, latest.ref],
            });
        }
        result.status = result.findings.length
          ? 'alert'
          : result.missing.length
            ? 'insufficient-data'
            : 'no-trigger';
        return result;
      },
    };
    ctx.provide('riskEngine', engine);
  },
} satisfies Plugin;
