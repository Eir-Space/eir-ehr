import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromConfig } from '../packages/runtime.ts';
import { doctor, root } from './helpers.ts';

// Needs a running openEHR server with templates: npm run openehr:up && npm run openehr:setup
const url = process.env.EIR_TEST_OPENEHR_URL;
const user = process.env.EIR_TEST_OPENEHR_USER ?? 'ehrbase-user';
const password = process.env.EIR_TEST_OPENEHR_PASSWORD ?? 'SuperSecretPassword';

test(
  'projection: a real clinical workflow lands in openEHR, is queryable by archetype, and reconciles',
  { skip: url ? false : 'EIR_TEST_OPENEHR_URL is not set' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'eir-projection-openehr-'));
    await writeFile(
      join(dir, 'p.yaml'),
      `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: projection-openehr
patches:
  - insert:
      id: content-openehr
      module: ${JSON.stringify(root + 'plugins/content-openehr.ts')}
      config: { endpoint: ${JSON.stringify(url)}, username: ${JSON.stringify(user)}, password: ${JSON.stringify(password)} }
    before: ai-review
  - insert:
      id: projection
      module: ${JSON.stringify(root + 'plugins/projection.ts')}
      config: { target: openehr, tenants: [clinic-a], backoffBaseMs: 0 }
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
    const obs = (code: string, value: number, unit: string) =>
      clinical.create(doctor, patient.id, 'observation', {
        encounterId: encounter.id,
        code,
        value,
        unit,
        effectiveAt: '2026-10-06T09:55:00+02:00',
      });
    await obs('8867-4', 66, '/min');
    await obs('29463-7', 80, 'kg'); // body weight: no slot in the template
    const term = runtime
      .get('terminology')
      .search('infektion', 50)
      .items.find((x) => x.selectable)!;
    await clinical.create(doctor, patient.id, 'condition', {
      code: { system: term.system, code: term.code, display: term.display },
    });
    const note = await clinical.create(doctor, patient.id, 'note', {
      encounterId: encounter.id,
      text: 'Syntetisk anteckning',
    });
    const saved = await clinical.transition(doctor, note.id, 'save', 1, {
      text: 'Reviderad anteckning',
    });
    await clinical.transition(doctor, note.id, 'sign', saved.version, {});

    const projection = runtime.get('projection');
    const [first] = await projection.runOnce();
    assert.deepEqual(
      [first.scanned, first.projected, first.unmapped, first.failed],
      [4, 3, 1, 0],
      JSON.stringify(first),
    );
    const [second] = await projection.runOnce();
    assert.deepEqual([second.projected, second.upToDate, second.unmapped], [0, 3, 1]);
    const [report] = await projection.reconcile();
    assert.deepEqual(report.counts, { ok: 3, unmapped: 1 }, JSON.stringify(report));

    // Independent of Eir: plain AQL over what was projected.
    const ask = async (q: string) => {
      const r = await fetch(`${url}/rest/openehr/v1/query/aql`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ q, query_parameters: { pid: patient.id } }),
      });
      assert.equal(r.status, 200);
      return ((await r.json()) as { rows: unknown[][] }).rows;
    };
    const scope = 'FROM EHR e CONTAINS COMPOSITION c CONTAINS';
    const where = 'WHERE e/ehr_status/subject/external_ref/id/value = $pid';
    assert.deepEqual(
      await ask(
        `SELECT o/data[at0002]/events[at0003]/data[at0001]/items[at0004]/value/magnitude ${scope} OBSERVATION o[openEHR-EHR-OBSERVATION.pulse.v1] ${where}`,
      ),
      [[66]],
    );
    assert.deepEqual(
      await ask(
        `SELECT p/data[at0001]/items[at0002]/value/defining_code/code_string ${scope} EVALUATION p[openEHR-EHR-EVALUATION.problem_diagnosis.v1] ${where}`,
      ),
      [[term.code]],
    );
    // The signed note has three openEHR versions, as in the ledger.
    const store = runtime.contributions('contentStore').get('openehr')!;
    const [noteRecord] = await store.list('clinic-a', patient.id, 'note');
    assert.equal(noteRecord.version, 3);
    assert.equal(noteRecord.data.status, 'signed');
  },
);
