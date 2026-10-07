import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse } from 'yaml';

// The evaluation suite is a set of YAML cases plus the code that checks and drives them. Its hash
// covers all of it, so a report is only valid for the exact suite (and pipeline) it ran against.
const code = z.string().regex(/^\d{1,7}-\d$/);
const name = z.string().regex(/^[a-z][a-z0-9-]*$/);
const observation = z
  .object({ name: name.optional(), code, value: z.number(), daysAgo: z.number().min(0).max(3650) })
  .strict();
const note = z.object({ name: name.optional(), text: z.string().min(1).max(2000) }).strict();
const encounter = z
  .object({
    reason: z.string().min(1).max(200),
    observations: z.array(observation).default([]),
    notes: z.array(note).default([]),
  })
  .strict();
export const caseSchema = z
  .object({
    id: name,
    title: z.string().min(1).max(200),
    // Oldest first. Every encounter but the last is signed off and closed; the last stays open.
    encounters: z.array(encounter).min(1).max(5),
    conditions: z
      .array(z.object({ name: name.optional(), code: z.string().min(1) }).strict())
      .default([]),
    // The content store fails during the proposal, so no history can be gathered.
    contentOutage: z.boolean().default(false),
    expect: z
      .object({
        mustCite: z.array(name).default([]),
        trend: z
          .object({ code, direction: z.enum(['rising', 'falling', 'stable']) })
          .strict()
          .optional(),
        noHistoryClaims: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();
export type EvalCase = z.infer<typeof caseSchema>;

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..');
export const casesDir = join(projectRoot, 'evals/cases');
// Code that decides what the suite measures. Changing any of it invalidates old reports.
const measured = ['packages/eval-checks.ts', 'packages/eval.ts', 'plugins/ai-review.ts'];

export async function loadCases(dir = casesDir): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const cases = await Promise.all(
    files.map(async (f) => caseSchema.parse(parse(await readFile(join(dir, f), 'utf8')))),
  );
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate evaluation case: ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}

export async function suiteHash(dir = casesDir): Promise<string> {
  const hash = createHash('sha256').update('eir-eval-suite-v1\n');
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.yaml')).sort())
    hash.update(`case ${f}\n`).update(await readFile(join(dir, f)));
  for (const f of measured) hash.update(`code ${f}\n`).update(await readFile(join(projectRoot, f)));
  return hash.digest('hex');
}
