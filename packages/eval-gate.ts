import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Policy, PluginManifest } from './plugin-manifest.ts';
import { loadCases, suiteHash } from './eval-suite.ts';

// Startup gate: a language-model plugin runs only if the profile points at an evaluation report
// that passed, is current, and is for exactly this model and this suite. The report is a plain
// JSON file, so this is a process control (review and CI own its integrity), not tamper-proofing.
const reportSchema = z
  .object({
    schema: z.literal(1),
    useCase: z.literal('draft-note'),
    generatedAt: z.iso.datetime({ offset: true }),
    suiteHash: z.string().regex(/^[0-9a-f]{64}$/),
    subject: z.object({ family: z.string(), model: z.string() }).strict(),
    repeat: z.number().int().min(1),
    passed: z.boolean(),
    summary: z
      .object({ cases: z.number().int(), runs: z.number().int(), failedRuns: z.number().int() })
      .strict(),
    results: z.array(
      z.object({ caseId: z.string(), run: z.number().int(), passed: z.boolean() }).passthrough(),
    ),
  })
  .passthrough();

export async function checkEvaluations(input: {
  policy: Policy;
  evaluations: { row: string; report: string }[];
  rows: {
    id: string;
    pluginId: string;
    config: Record<string, unknown>;
    manifest?: PluginManifest;
  }[];
  now?: number;
}): Promise<string[]> {
  const gate = input.policy.requireEvaluation;
  if (!gate) return [];
  const out: string[] = [];
  const now = input.now ?? Date.now();
  const current = await suiteHash();
  const caseIds = (await loadCases()).map((c) => c.id);
  for (const row of input.rows) {
    if (!row.manifest?.intendedUse?.usesLanguageModel) continue;
    const label = `${row.pluginId} (${row.id})`;
    const entry = input.evaluations.find((e) => e.row === row.id);
    if (!entry) {
      out.push(`${label}: no evaluation report`);
      continue;
    }
    let report: z.infer<typeof reportSchema>;
    try {
      report = reportSchema.parse(JSON.parse(await readFile(entry.report, 'utf8')));
    } catch {
      out.push(`${label}: evaluation report is missing or malformed`);
      continue;
    }
    const family = row.manifest.evaluationFamily;
    const model = typeof row.config.model === 'string' ? row.config.model : '';
    if (!family) out.push(`${label}: manifest declares no evaluationFamily`);
    else if (report.subject.family !== family || !model || report.subject.model !== model)
      out.push(
        `${label}: report is for ${report.subject.family}:${report.subject.model}, not ${family}:${model || '(none)'}`,
      );
    if (report.suiteHash !== current)
      out.push(
        `${label}: report is for a different suite or pipeline version; run npm run eval again`,
      );
    const age = (now - Date.parse(report.generatedAt)) / 86400000;
    if (age > gate.maxAgeDays)
      out.push(`${label}: report is ${Math.floor(age)} days old (limit ${gate.maxAgeDays})`);
    if (age < -1) out.push(`${label}: report is dated in the future`);
    const covered = new Set(report.results.map((r) => r.caseId));
    const missing = caseIds.filter((id) => !covered.has(id));
    if (missing.length) out.push(`${label}: report does not cover ${missing.join(', ')}`);
    const failed = report.results.filter((r) => !r.passed).length;
    if (
      !report.passed ||
      failed > 0 ||
      report.summary.failedRuns > 0 ||
      report.summary.runs !== report.results.length
    )
      out.push(
        `${label}: evaluation did not pass (${failed} of ${report.results.length} runs failed)`,
      );
  }
  return out;
}
