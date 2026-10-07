// Evaluates a model for drafting notes against the synthetic clinical cases in evals/cases.
//   npm run eval -- --model extractive
//   npm run eval -- --model qwen3.5:4b --repeat 3
// Options: --endpoint <loopback ollama url>  --only case-id,case-id  --out report.json
// Writes a report (default evals/reports/<family>-<model>.json) and exits 1 unless every case
// passed on every repeat. A passing report for the exact model and suite is what a profile's
// requireEvaluation policy accepts. Passing means the known failure checks did not fire; it does
// not mean the drafts are clinically correct.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runEval, subjectOf, type ProviderSpec } from '../packages/eval.ts';
import { projectRoot } from '../packages/eval-suite.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const model = option('model') ?? 'extractive';
const provider: ProviderSpec =
  model === 'extractive'
    ? { kind: 'extractive' }
    : { kind: 'ollama', model, endpoint: option('endpoint') };
const repeat = Number(option('repeat') ?? 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new Error('--repeat must be 1 to 20');
const subject = subjectOf(provider);
const out = resolve(
  option('out') ??
    join(
      projectRoot,
      'evals/reports',
      `${subject.family}-${subject.model.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`,
    ),
);

console.log(`Evaluating ${subject.family}:${subject.model} (repeat ${repeat})`);
const report = await runEval({
  provider,
  repeat,
  only: option('only')?.split(','),
  onResult: (r) =>
    console.log(
      `${r.passed ? 'pass' : 'FAIL'}  ${r.caseId}${repeat > 1 ? `#${r.run}` : ''}  ${Math.round(r.ms / 1000)}s` +
        (r.rejected ? `  rejected: ${r.rejected}` : '') +
        r.violations.map((v) => `\n        - ${v.check}: ${v.detail}`).join(''),
    ),
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(
  `\n${report.passed ? 'PASSED' : 'FAILED'}: ${report.summary.runs - report.summary.failedRuns}/${report.summary.runs} runs. Report: ${out}`,
);
process.exitCode = report.passed ? 0 : 1;
