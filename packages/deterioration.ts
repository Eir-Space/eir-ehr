import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Entity } from './contracts.ts';

export type RiskReading = {
  ref: string;
  kind: 'vital' | 'lab';
  code: string;
  system: string;
  value: number;
  unit: string;
  effectiveAt: string;
};
export type RiskLab = {
  ref: string;
  name: string;
  value: string;
  unit: string;
  flag: string;
  effectiveAt: string;
};
export type RiskInput = {
  protocol: 'eir.risk.v1';
  evaluatedAt: string;
  ageYears: number;
  readings: RiskReading[];
  labs: RiskLab[];
};
export const riskOutput = z
  .object({
    status: z.enum(['alert', 'no-trigger', 'insufficient-data', 'unavailable']),
    findings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(100),
            text: z.string().min(1).max(500),
            refs: z.array(z.string().min(1).max(100)).min(1).max(20),
          })
          .strict(),
      )
      .max(50),
    missing: z.array(z.string().min(1).max(200)).max(50),
  })
  .strict();
export type RiskOutput = z.infer<typeof riskOutput>;
export interface RiskEngine {
  id: string;
  version: string;
  label: string;
  intendedUse: string;
  evaluate(input: RiskInput): Promise<RiskOutput>;
}
export interface Deterioration {
  list(
    actor: Actor,
    input?: unknown,
  ): Promise<{
    enabled: boolean;
    engine: { id: string; version: string; label: string; intendedUse: string };
    worker: boolean;
    pollMs: number;
    nextCursor: string | null;
    items: {
      monitor: Entity;
      patientName: string;
      assessment: Entity | null;
      alerts: Entity[];
      tasks: Entity[];
      events: Entity[];
    }[];
  }>;
  enroll(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  stop(actor: Actor, id: string, input: unknown): Promise<Entity>;
  evaluate(actor: Actor, id: string): Promise<void>;
  respond(actor: Actor, id: string, input: unknown): Promise<Entity>;
  runOnce(): Promise<{ scanned: number }>;
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ageAt = (birthDate: string, at: string) => {
  const birth = new Date(birthDate),
    now = new Date(at);
  return (
    now.getUTCFullYear() -
    birth.getUTCFullYear() -
    (at.slice(5, 10) < birthDate.slice(5, 10) ? 1 : 0)
  );
};

// Explicit encounter scope prevents a previous admission's observations driving an alert.
export function riskInput(
  patient: Entity,
  encounterId: string,
  records: Entity[],
  at: string,
): RiskInput {
  const readings: RiskReading[] = [];
  const labs: RiskLab[] = [];
  for (const row of records) {
    if (row.data.encounterId !== encounterId || row.data.status !== 'final') continue;
    if (row.kind === 'observation')
      readings.push({
        ref: `${row.id}@${row.version}`,
        kind: 'vital',
        system: 'http://loinc.org',
        code: row.data.code,
        value: row.data.value,
        unit: row.data.unit,
        effectiveAt: row.data.effectiveAt,
      });
  }
  // Only the current report on each order is projected; superseded results stay historical.
  for (const order of records.filter(
    (r) =>
      r.kind === 'labOrder' && r.data.encounterId === encounterId && r.data.status !== 'cancelled',
  )) {
    const report = records.find((r) => r.id === order.data.reportId && r.kind === 'labReport');
    if (!report) continue;
    for (const [index, result] of (report.data.results ?? []).entries())
      labs.push({
        ref: `${report.id}@${report.version}#${index}`,
        name: result.name,
        value: result.value,
        unit: result.unit,
        flag: result.flag,
        effectiveAt: report.data.collectedAt,
      });
  }
  return {
    protocol: 'eir.risk.v1',
    evaluatedAt: at,
    ageYears: ageAt(patient.data.birthDate, at),
    readings: readings.sort((a, b) => a.ref.localeCompare(b.ref) || a.code.localeCompare(b.code)),
    labs: labs.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}
