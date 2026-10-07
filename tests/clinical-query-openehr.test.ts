import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
import { doctor, root } from './helpers.ts';

// Needs a running openEHR server with templates: npm run openehr:up && npm run openehr:setup
const url = process.env.EIR_TEST_OPENEHR_URL;
test(
  'clinical query: answers come from openEHR AQL, verified against the ledger, and external edits are caught',
  { skip: url ? false : 'EIR_TEST_OPENEHR_URL is not set' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'eir-query-openehr-'));
    await writeFile(
      join(dir, 'p.yaml'),
      `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: query-openehr
patches:
  - insert:
      id: content-openehr
      module: ${JSON.stringify(root + 'plugins/content-openehr.ts')}
      config: { endpoint: ${JSON.stringify(url)}, username: ehrbase-user, password: SuperSecretPassword }
    before: ai-review
  - insert: { id: projection, module: ${JSON.stringify(root + 'plugins/projection.ts')}, config: { target: openehr, tenants: [clinic-a], backoffBaseMs: 0 } }
    before: ai-review
  - insert: { id: clinical-query, module: ${JSON.stringify(root + 'plugins/clinical-query.ts')}, config: { source: openehr } }
    before: ai-review
`,
    );
    const { runtime } = await fromConfig(join(dir, 'p.yaml'), {
      'eir.storage.sqlite': { path: ':memory:' },
      'eir.care-team': {
        members: [
          { id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' },
        ],
      },
    });
    t.after(() => runtime.stop());
    const clinical = runtime.get('clinical');
    const patient = await clinical.register(doctor, {
      name: 'Syntetisk Patient',
      birthDate: '1985-03-12',
      identifier: { type: 'local', value: `TEST-${Date.now()}` },
    });
    const encounter = await clinical.create(doctor, patient.id, 'encounter', { reason: 'Test' });
    const obs = (value: number, day: number, code = '8867-4', unit = '/min') =>
      clinical.create(doctor, patient.id, 'observation', {
        encounterId: encounter.id,
        code,
        value,
        unit,
        effectiveAt: `2026-10-0${day}T08:00:00+02:00`,
      });
    const a = await obs(60, 1);
    const b = await obs(70, 3);
    const c = await obs(65, 2);
    await obs(80, 4, '29463-7', 'kg'); // body weight: no slot in the template
    const term = runtime
      .get('terminology')
      .search('infektion', 50)
      .items.find((x) => x.selectable)!;
    const problem = await clinical.create(doctor, patient.id, 'condition', {
      code: { system: term.system, code: term.code, display: term.display },
    });
    await runtime.get('projection').runOnce();

    const query = runtime.get('clinicalQuery');
    const series = await query.vitals(doctor, patient.id, { code: '8867-4' });
    assert.deepEqual(
      series.points.map((p) => [p.value, p.ref]),
      [
        [70, `${b.id}@1`],
        [65, `${c.id}@1`],
        [60, `${a.id}@1`],
      ],
    );
    assert.equal(series.complete, true);
    assert.equal(series.source, 'openehr');
    const problems = await query.problems(doctor, patient.id);
    assert.deepEqual(
      problems.problems.map((p) => [p.entityId, p.code, p.status]),
      [[problem.id, term.code, 'active']],
    );
    assert.equal(problems.complete, true);
    const weight = await query.vitals(doctor, patient.id, { code: '29463-7' });
    assert.deepEqual(
      [weight.points.length, weight.coverage.unmapped, weight.complete],
      [0, 1, false],
    );

    // Someone edits a composition directly in the openEHR system, behind Eir's back.
    const store = runtime.contributions('contentStore').get('openehr')!;
    const ledger = runtime.get('store');
    const links = await ledger.list('clinic-a', patient.id, 'contentLink');
    const contentId = String(links.find((l) => l.data.entityId === b.id)!.data.contentId);
    const remote = (await store.get('clinic-a', contentId))!;
    await store.revise(doctor, remote, remote.version, { ...remote.data, value: 99 }, 'external');
    const drifted = await query.vitals(doctor, patient.id, { code: '8867-4' });
    assert.deepEqual(
      drifted.points.map((p) => p.value),
      [65, 60],
      'the edited row is not served',
    );
    assert.equal(drifted.coverage.diverged, 1);
    assert.equal(drifted.complete, false);
    const [report] = await runtime.get('projection').reconcile();
    assert.equal(report.counts.ahead, 1);
  },
);
