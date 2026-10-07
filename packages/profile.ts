import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { policySchema } from './plugin-manifest.ts';

// A profile is a named composition built from ordered layers, as in the DeepSeek Harness
// pattern: each `extends` file applies first, then this file's rows, then its patches. A row
// has a stable id so a later layer can replace, remove or reconfigure it without copying the
// whole profile. JSON profiles are valid YAML and keep working unchanged.
const rowId = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const row = z
  .object({
    id: rowId.optional(),
    module: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
const patch = z.union([
  z.object({ replace: rowId, with: row.omit({ id: true }) }).strict(),
  z.object({ remove: rowId }).strict(),
  z.object({ disable: rowId }).strict(),
  // Shallow-merge into one row's config instead of replacing it.
  z.object({ configure: rowId, config: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      insert: row,
      before: rowId.optional(),
      after: rowId.optional(),
    })
    .strict(),
]);
const layer = z
  .object({
    profile: z.string().optional(),
    extends: z.array(z.string()).default([]),
    plugins: z.array(row).default([]),
    patches: z.array(patch).default([]),
    policy: policySchema.optional(),
    // Evaluation reports for language-model rows, by row id. A later layer replaces the same row's.
    evaluations: z.array(z.object({ row: rowId, report: z.string().min(1) }).strict()).default([]),
    chartRenderers: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
    defaultRenderer: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
  })
  .strict();

export type Row = { id: string; module: string; config: Record<string, unknown>; enabled: boolean };
export type ResolvedProfile = {
  profile: string;
  rows: Row[];
  policy: z.infer<typeof policySchema>;
  evaluations: { row: string; report: string }[];
  chartRenderers: string[];
  defaultRenderer: string;
  // Which file contributed or changed each row, for the dump command and audits.
  trace: string[];
};

const defaultId = (module: string) => basename(module).replace(/\.[^.]+$/, '');

export async function resolveProfile(path: string): Promise<ResolvedProfile> {
  const state: ResolvedProfile = {
    profile: '',
    rows: [],
    policy: policySchema.parse({}),
    evaluations: [],
    chartRenderers: [],
    defaultRenderer: '',
    trace: [],
  };
  await apply(resolve(path), state, []);
  if (!state.profile) throw new Error('Profile has no name');
  if (!state.chartRenderers.length) throw new Error('Profile enables no chart renderer');
  if (!state.chartRenderers.includes(state.defaultRenderer))
    throw new Error('Default renderer is not enabled');
  return state;
}

async function apply(path: string, state: ResolvedProfile, stack: string[]) {
  if (stack.includes(path)) throw new Error(`Profile extends cycle at ${path}`);
  const file = layer.parse(parse(await readFile(path, 'utf8')));
  const base = dirname(path);
  for (const parent of file.extends) await apply(resolve(base, parent), state, [...stack, path]);
  const name = basename(path);
  if (file.profile) state.profile = file.profile;
  if (file.policy) state.policy = file.policy;
  for (const e of file.evaluations) {
    state.evaluations = state.evaluations.filter((x) => x.row !== e.row);
    state.evaluations.push({ row: e.row, report: resolve(base, e.report) });
  }
  if (file.chartRenderers) state.chartRenderers = file.chartRenderers;
  if (file.defaultRenderer) state.defaultRenderer = file.defaultRenderer;
  // Module paths resolve against the file that wrote them, so a layer can live anywhere.
  const make = (r: z.infer<typeof row>): Row => ({
    id: r.id ?? defaultId(r.module),
    module: resolve(base, r.module),
    config: r.config ?? {},
    enabled: r.enabled,
  });
  const find = (id: string) => {
    const index = state.rows.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`${name}: patch targets unknown row ${id}`);
    return index;
  };
  for (const r of file.plugins) {
    const next = make(r);
    const existing = state.rows.findIndex((x) => x.id === next.id);
    if (existing >= 0) state.rows[existing] = next;
    else state.rows.push(next);
    state.trace.push(`${name}: row ${next.id}`);
  }
  for (const p of file.patches) {
    if ('replace' in p) {
      const i = find(p.replace);
      state.rows[i] = { ...make({ ...p.with, id: p.replace }) };
      state.trace.push(`${name}: replace ${p.replace} -> ${state.rows[i].module}`);
    } else if ('remove' in p) {
      state.rows.splice(find(p.remove), 1);
      state.trace.push(`${name}: remove ${p.remove}`);
    } else if ('disable' in p) {
      state.rows[find(p.disable)].enabled = false;
      state.trace.push(`${name}: disable ${p.disable}`);
    } else if ('configure' in p) {
      const target = state.rows[find(p.configure)];
      target.config = { ...target.config, ...p.config };
      state.trace.push(`${name}: configure ${p.configure}`);
    } else {
      const next = make(p.insert);
      if (state.rows.some((x) => x.id === next.id))
        throw new Error(`${name}: insert duplicates row ${next.id}`);
      if (p.before && p.after) throw new Error(`${name}: insert takes before or after, not both`);
      const at = p.before ? find(p.before) : p.after ? find(p.after) + 1 : state.rows.length;
      state.rows.splice(at, 0, next);
      state.trace.push(`${name}: insert ${next.id}`);
    }
  }
}
