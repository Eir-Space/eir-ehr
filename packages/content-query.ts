import type { Entity } from './contracts.ts';
import type { ProblemRow, VitalPoint } from './content.ts';

// Typed queries derived from a provider's `list`, for providers with no native query language.
export function listQueries(
  list: (tenant: string, patientId: string, kind: string) => Promise<Entity[]>,
) {
  return {
    async vitalSeries(tenant: string, patientId: string, code: string, cap: number) {
      return (await list(tenant, patientId, 'observation'))
        .filter((e) => e.data.code === code && typeof e.data.value === 'number')
        .map((e): VitalPoint => ({
          id: e.id,
          version: e.version,
          code,
          value: e.data.value,
          unit: String(e.data.unit),
          effectiveAt: String(e.data.effectiveAt),
        }))
        .sort(
          (a, b) =>
            Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || a.id.localeCompare(b.id),
        )
        .slice(0, cap);
    },
    async problems(tenant: string, patientId: string, cap: number) {
      return (await list(tenant, patientId, 'condition'))
        .filter((e) => e.data.code && typeof e.data.code.display === 'string')
        .map((e): ProblemRow => ({
          id: e.id,
          version: e.version,
          system: e.data.code.system,
          code: e.data.code.code,
          display: e.data.code.display,
          ...(typeof e.data.onset === 'string' ? { onset: e.data.onset } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, cap);
    },
  };
}
