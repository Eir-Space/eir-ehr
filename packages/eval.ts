import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fault, type Actor } from './contracts.ts';
import { checkDraft, type Violation } from './eval-checks.ts';
import { loadCases, projectRoot, suiteHash, type EvalCase } from './eval-suite.ts';
import type { MemoryContent } from './memory-content.ts';
import { fromConfig } from './runtime.ts';
import { vitals } from '../plugins/clinical.ts';

// Runs synthetic cases through the real proposal pipeline (record, projection, verified history,
// evidence, model, citation validation) with the model under test, then applies the deterministic
// checks. The model is wired in directly, never through the router, so a fallback cannot hide a
// failing model behind the extractive provider.
export type ProviderSpec =
  | { kind: 'extractive' }
  | { kind: 'ollama'; model: string; endpoint?: string }
  | {
      kind: 'module';
      module: string;
      config?: Record<string, unknown>;
      family: string;
      model: string;
    };
export type Subject = { family: string; model: string };
export type CaseResult = {
  caseId: string;
  run: number;
  passed: boolean;
  rejected?: string;
  violations: Violation[];
  model?: string;
  mode?: string;
  historyItems?: number;
  draft?: string;
  ms: number;
};
export type Report = {
  schema: 1;
  useCase: 'draft-note';
  generatedAt: string;
  suiteHash: string;
  subject: Subject;
  repeat: number;
  passed: boolean;
  summary: { cases: number; runs: number; failedRuns: number };
  results: CaseResult[];
};

const doctor: Actor = { id: 'doctor-a', tenant: 'clinic-a', role: 'clinician' };
const json = (v: unknown) => JSON.stringify(v);

export const subjectOf = (spec: ProviderSpec): Subject =>
  spec.kind === 'extractive'
    ? { family: 'extractive', model: 'extractive-v1' }
    : spec.kind === 'ollama'
      ? { family: 'ollama', model: spec.model }
      : { family: spec.family, model: spec.model };

function profileFor(spec: ProviderSpec) {
  const provider =
    spec.kind === 'extractive'
      ? ''
      : `  - remove: ai-extractive
  - insert: { id: ai-provider, module: ${json(spec.kind === 'ollama' ? join(projectRoot, 'plugins/ai-ollama.ts') : spec.module)}, config: ${json(spec.kind === 'ollama' ? { model: spec.model, ...(spec.endpoint ? { endpoint: spec.endpoint } : {}) } : (spec.config ?? {}))} }
    before: ai-review
`;
  return `extends: [${json(join(projectRoot, 'eir.config.json'))}]
profile: evaluation
patches:
${provider}  - insert: { id: content-memory, module: ${json(join(projectRoot, 'plugins/content-memory.ts'))} }
    before: ai-review
  - insert: { id: projection, module: ${json(join(projectRoot, 'plugins/projection.ts'))}, config: { target: memory, tenants: [clinic-a], backoffBaseMs: 0 } }
    before: ai-review
  - insert: { id: clinical-query, module: ${json(join(projectRoot, 'plugins/clinical-query.ts'))}, config: { source: memory } }
    before: ai-review
  - configure: ai-review
    config: { history: { perCode: 5 } }
`;
}

async function runCase(c: EvalCase, spec: ProviderSpec, run: number): Promise<CaseResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'eir-eval-'));
  await writeFile(join(dir, 'profile.yaml'), profileFor(spec));
  const { runtime } = await fromConfig(join(dir, 'profile.yaml'), {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [{ id: 'doctor-a', tenant: 'clinic-a', name: 'Eval Läkare', profession: 'Läkare' }],
    },
  });
  try {
    const clinical = runtime.get('clinical');
    const patient = await clinical.register(doctor, {
      name: 'Syntetisk Patient',
      birthDate: '1985-03-12',
      identifier: { type: 'local', value: `EVAL-${c.id.toUpperCase()}-${run}` },
    });
    const refs: Record<string, string> = {};
    let open = '';
    for (const [i, spec] of c.encounters.entries()) {
      const last = i === c.encounters.length - 1;
      const encounter = await clinical.create(doctor, patient.id, 'encounter', {
        reason: spec.reason,
      });
      for (const o of spec.observations) {
        const made = await clinical.create(doctor, patient.id, 'observation', {
          encounterId: encounter.id,
          code: o.code,
          value: o.value,
          unit: vitals[o.code].unit,
          effectiveAt: new Date(Date.now() - o.daysAgo * 86400000).toISOString(),
        });
        if (o.name) refs[o.name] = `${made.id}@${made.version}`;
      }
      for (const n of spec.notes) {
        const made = await clinical.create(doctor, patient.id, 'note', {
          encounterId: encounter.id,
          text: n.text,
        });
        if (n.name) refs[n.name] = `${made.id}@${made.version}`;
        if (!last) await clinical.transition(doctor, made.id, 'sign', made.version, {});
      }
      if (last) open = encounter.id;
      else await clinical.transition(doctor, encounter.id, 'close', encounter.version, {});
    }
    for (const cond of c.conditions) {
      const term = runtime.get('terminology').lookup(cond.code);
      if (!term?.selectable)
        throw new Error(`Case ${c.id}: ${cond.code} is not a selectable diagnosis`);
      const made = await clinical.create(doctor, patient.id, 'condition', {
        code: { system: term.system, code: term.code, display: term.display },
      });
      if (cond.name) refs[cond.name] = `${made.id}@${made.version}`;
    }
    await runtime.get('projection').runOnce();
    if (c.contentOutage)
      (runtime.contributions('contentStore').get('memory') as unknown as MemoryContent).failNext = {
        list: 100000,
      };
    try {
      const proposal = await runtime.get('aiReview').propose(doctor, patient.id, open);
      const d = proposal.data as Record<string, any>;
      const violations = checkDraft({
        text: d.text,
        citations: d.citations,
        evidence: d.evidence,
        expect: { ...c.expect, mustCite: c.expect.mustCite },
        refs,
      });
      return {
        caseId: c.id,
        run,
        passed: violations.length === 0,
        violations,
        model: d.model,
        mode: d.mode,
        historyItems: (d.historyRefs ?? []).length,
        draft: String(d.text).slice(0, 1500),
        ms: Date.now() - started,
      };
    } catch (error) {
      // An invalid citation, a timeout or a provider error is a failure of the model for this use.
      return {
        caseId: c.id,
        run,
        passed: false,
        rejected: error instanceof Fault ? error.message : 'the model or provider failed',
        violations: [],
        ms: Date.now() - started,
      };
    }
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runEval(options: {
  provider: ProviderSpec;
  repeat?: number;
  only?: string[];
  cases?: EvalCase[];
  onResult?: (r: CaseResult) => void;
}): Promise<Report> {
  const all = options.cases ?? (await loadCases());
  const cases = options.only ? all.filter((c) => options.only!.includes(c.id)) : all;
  const repeat = options.repeat ?? 1;
  const results: CaseResult[] = [];
  for (const c of cases)
    for (let run = 1; run <= repeat; run++) {
      const r = await runCase(c, options.provider, run);
      results.push(r);
      options.onResult?.(r);
    }
  const failedRuns = results.filter((r) => !r.passed).length;
  return {
    schema: 1,
    useCase: 'draft-note',
    generatedAt: new Date().toISOString(),
    suiteHash: await suiteHash(),
    subject: subjectOf(options.provider),
    repeat,
    // Zero tolerance: every case must pass on every repeat.
    passed: results.length > 0 && failedRuns === 0,
    summary: { cases: cases.length, runs: results.length, failedRuns },
    results,
  };
}
