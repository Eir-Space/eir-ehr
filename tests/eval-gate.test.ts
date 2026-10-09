import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile } from '../packages/runtime.ts';
import { loadCases, suiteHash } from '../packages/eval-suite.ts';
import { root } from './helpers.ts';

type Over = Record<string, unknown>;
async function makeReport(over: Over = {}) {
  const ids = (await loadCases()).map((c) => c.id);
  const results = ids.map((caseId) => ({ caseId, run: 1, passed: true, violations: [] }));
  return {
    schema: 1,
    useCase: 'draft-note',
    generatedAt: new Date().toISOString(),
    suiteHash: await suiteHash(),
    subject: { family: 'ollama', model: 'test-model' },
    repeat: 1,
    passed: true,
    summary: { cases: ids.length, runs: ids.length, failedRuns: 0 },
    results,
    ...over,
  };
}
// A profile that runs the ollama plugin for `test-model`, gated on an evaluation report.
async function load(
  report: unknown,
  options: { gate?: boolean; model?: string; omitEntry?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'eir-gate-'));
  if (report !== undefined)
    await writeFile(
      join(dir, 'report.json'),
      typeof report === 'string' ? report : JSON.stringify(report),
    );
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: gate-test
${options.gate === false ? '' : 'policy: { requireEvaluation: { useCase: draft-note, maxAgeDays: 90 } }\n'}${options.omitEntry ? '' : 'evaluations: [{ row: ai-provider, report: ./report.json }]\n'}patches:
  - remove: ai-extractive
  - insert: { id: ai-provider, module: ${JSON.stringify(root + 'plugins/ai-ollama.ts')}, config: { model: ${options.model ?? 'test-model'} } }
    before: ai-review
`,
  );
  return await loadProfile(join(dir, 'p.yaml'));
}
const refuses = (pattern: RegExp) => (e: unknown) =>
  /Profile policy violations/.test(String(e)) && pattern.test(String(e));

test('a passing, current report for exactly this model lets the profile load', async () => {
  const { loaded } = await load(await makeReport());
  assert.ok(loaded.some((l) => l.plugin.id === 'eir.ai.ollama'));
});

test('a language model with no report, or an unreadable one, is refused', async () => {
  await assert.rejects(
    load(await makeReport(), { omitEntry: true }),
    refuses(/no evaluation report/),
  );
  await assert.rejects(load('{not json'), refuses(/missing or malformed/));
  await assert.rejects(load({ schema: 1 }), refuses(/missing or malformed/));
});

test('a failed evaluation is refused, including a flipped flag over failing results', async () => {
  const failing = (await makeReport()).results.map((r, i) =>
    i === 2 ? { ...r, passed: false } : r,
  );
  await assert.rejects(
    load(
      await makeReport({
        passed: false,
        results: failing,
        summary: { cases: 7, runs: 7, failedRuns: 1 },
      }),
    ),
    refuses(/did not pass \(1 of 7/),
  );
  await assert.rejects(
    load(await makeReport({ results: failing })),
    refuses(/did not pass/),
    'passed: true cannot hide a failed run',
  );
});

test('a report for another model, another family, or another suite is refused', async () => {
  await assert.rejects(
    load(await makeReport({ subject: { family: 'ollama', model: 'other-model' } })),
    refuses(/not ollama:test-model/),
  );
  await assert.rejects(
    load(await makeReport({ subject: { family: 'extractive', model: 'test-model' } })),
    refuses(/not ollama:test-model/),
  );
  await assert.rejects(
    load(await makeReport({ suiteHash: 'a'.repeat(64) })),
    refuses(/different suite or pipeline/),
  );
});

test('a stale report, a future-dated one, or one that skips cases is refused', async () => {
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  await assert.rejects(load(await makeReport({ generatedAt: old })), refuses(/120 days old/));
  const future = new Date(Date.now() + 10 * 86400000).toISOString();
  await assert.rejects(load(await makeReport({ generatedAt: future })), refuses(/future/));
  const partial = (await makeReport()).results.slice(0, 3);
  await assert.rejects(
    load(await makeReport({ results: partial, summary: { cases: 3, runs: 3, failedRuns: 0 } })),
    refuses(/does not cover/),
  );
});

test('the gate applies only when the profile asks, and not to plugins that use no language model', async () => {
  await load(undefined, { gate: false, omitEntry: true });
  // The default dev profile runs the extractive provider: no language model, so no report needed.
  const dir = await mkdtemp(join(tmpdir(), 'eir-gate-'));
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]\nprofile: gate-extractive\npolicy: { requireEvaluation: { useCase: draft-note } }\n`,
  );
  await loadProfile(join(dir, 'p.yaml'));
});
