import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval, type CaseResult } from '../packages/eval.ts';
import { loadCases, suiteHash } from '../packages/eval-suite.ts';

type Evidence = { ref: string; text: string }[];
type Script = (evidence: Evidence) => { text: string; citations: Evidence };
const g = globalThis as unknown as { __evalScript?: Script };

// A model whose output a test scripts, wired in through the same path as a real provider.
async function scripted() {
  const dir = await mkdtemp(join(tmpdir(), 'eir-eval-model-'));
  const module = join(dir, 'scripted.ts');
  await writeFile(
    module,
    `export default {
  id: 'test.ai.scripted', version: '1.0.0', apiVersion: 2, provides: ['aiProvider'], requires: [],
  setup(ctx) {
    ctx.provide('aiProvider', {
      id: 'scripted',
      async generate(evidence) {
        const out = globalThis.__evalScript(evidence);
        return { ...out, model: 'scripted-1', mode: 'model' };
      },
    });
  },
};
`,
  );
  return { kind: 'module' as const, module, family: 'scripted', model: 'scripted-1' };
}
const now = (ev: Evidence) => ev.find((e) => e.text.startsWith('Puls: 96 /min'))!;
const cite =
  (text: string): Script =>
  (ev) => ({
    text,
    citations: [{ ref: now(ev).ref, text: 'Puls: 96 /min' }],
  });
async function one(caseId: string, script: Script): Promise<CaseResult> {
  g.__evalScript = script;
  const report = await runEval({ provider: await scripted(), only: [caseId] });
  assert.equal(report.results.length, 1);
  assert.equal(report.passed, report.results[0].passed);
  return report.results[0];
}
const checks = (r: CaseResult) => r.violations.map((v) => v.check);

test('a grounded draft passes the rising-trend case, with verified history in its evidence', async () => {
  const r = await one(
    'trend-rising',
    cite('Patienten är trött. Pulsen har stigit från 58 /min till 64 /min och är nu 96 /min.'),
  );
  assert.deepEqual(r.violations, []);
  assert.equal(r.passed, true);
  assert.equal(r.historyItems, 3, 'the case really exercised the verified-history path');
});

test('each known failure mode is caught', async () => {
  assert.ok(
    checks(await one('trend-rising', cite('Pulsen har sjunkit till 96 /min.'))).includes(
      'trend-contradiction',
    ),
  );
  assert.ok(
    checks(await one('trend-rising', cite('Pulsen är 96 /min och var 70 /min.'))).includes(
      'number-not-in-evidence',
    ),
  );
  assert.ok(
    checks(await one('trend-rising', cite('Hon har puls 96 /min.'))).includes(
      'unsupported-pronoun',
    ),
  );
  assert.ok(
    checks(await one('trend-rising', cite('Puls 96 /min. Jag rekommenderar vila.'))).includes(
      'treatment-advice',
    ),
  );
  const uncited = await one('trend-rising', (ev) => ({
    text: 'Patienten är trött.',
    citations: [{ ref: ev.find((e) => e.text.startsWith('Patienten'))!.ref, text: 'Patienten' }],
  }));
  assert.ok(checks(uncited).includes('missing-citation'));
});

test('a trend that is flat cannot be called a change, and a falling one cannot be called a rise', async () => {
  const flat = await one('trend-stable', (ev) => {
    const e = ev.find((x) => x.text.startsWith('Puls: 71 /min'))!;
    return {
      text: 'Pulsen har ökat till 71 /min.',
      citations: [{ ref: e.ref, text: 'Puls: 71 /min' }],
    };
  });
  assert.ok(checks(flat).includes('trend-contradiction'));
  const falling = await one('trend-falling', (ev) => {
    const e = ev.find((x) => x.text.startsWith('Puls: 70 /min'))!;
    return {
      text: 'Pulsen har ökat till 70 /min.',
      citations: [{ ref: e.ref, text: 'Puls: 70 /min' }],
    };
  });
  assert.ok(checks(falling).includes('trend-contradiction'));
});

test('claiming history that is not there is caught, whether it was never recorded or the store was down', async () => {
  const claim = (ev: Evidence) => {
    const e = ev.find(
      (x) => x.text.startsWith('Puls: 88 /min') || x.text.startsWith('Puls: 96 /min'),
    )!;
    return {
      text: 'Pulsen är högre än tidigare.',
      citations: [{ ref: e.ref, text: e.text.slice(0, 12) }],
    };
  };
  const first = await one('no-history', claim);
  assert.equal(first.historyItems, 0);
  assert.ok(checks(first).includes('history-claim-without-history'));
  const down = await one('history-unavailable', claim);
  assert.equal(down.historyItems, 0, 'the content-store outage removed the history');
  assert.ok(checks(down).includes('history-claim-without-history'));
});

test('an invalid citation and a provider error are failures of the model, not crashes', async () => {
  const invented = await one('trend-rising', (ev) => ({
    text: 'Puls.',
    citations: [{ ref: now(ev).ref, text: 'Puls: 123 /min' }],
  }));
  assert.equal(invented.passed, false);
  assert.match(invented.rejected ?? '', /invalid source reference/);
  const broken = await one('trend-rising', () => {
    throw new Error('connection lost with clinical text Syntetisk');
  });
  assert.equal(broken.passed, false);
  assert.equal(broken.rejected, 'the model or provider failed');
  assert.ok(!JSON.stringify(broken).includes('Syntetisk Patient'));
});

test('the extractive baseline passes every case, and a report is bound to the suite', async () => {
  const report = await runEval({ provider: { kind: 'extractive' } });
  assert.equal(report.passed, true, JSON.stringify(report.results.filter((r) => !r.passed)));
  assert.equal(report.summary.runs, (await loadCases()).length);
  assert.equal(report.suiteHash, await suiteHash());
  assert.deepEqual(report.subject, { family: 'extractive', model: 'extractive-v1' });
});

test('repeats must all pass: one bad run in three fails the report', async () => {
  let n = 0;
  g.__evalScript = (ev) => ({
    text: ++n === 2 ? 'Pulsen har sjunkit till 96 /min.' : 'Pulsen har stigit till 96 /min.',
    citations: [{ ref: now(ev).ref, text: 'Puls: 96 /min' }],
  });
  const report = await runEval({ provider: await scripted(), only: ['trend-rising'], repeat: 3 });
  assert.deepEqual(
    report.results.map((r) => r.passed),
    [true, false, true],
  );
  assert.equal(report.passed, false);
  assert.equal(report.summary.failedRuns, 1);
});
