import { createOpenEhrStore } from '../packages/openehr.ts';
import { runContentContract } from './content-contract.ts';

// Needs a running openEHR server with the bundled templates uploaded:
//   npm run openehr:up && npm run openehr:setup && npm run test:openehr
const url = process.env.EIR_TEST_OPENEHR_URL;
runContentContract(
  'openEHR content store',
  async () => ({
    store: createOpenEhrStore({
      endpoint: url,
      username: process.env.EIR_TEST_OPENEHR_USER ?? 'ehrbase-user',
      // Disposable credential of the local compose stack.
      password: process.env.EIR_TEST_OPENEHR_PASSWORD ?? 'SuperSecretPassword',
    }),
    stop: async () => {},
  }),
  { skip: url ? false : 'EIR_TEST_OPENEHR_URL is not set' },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The point of the seam: clinical content written through Eir is queryable by archetype,
// without Eir, by any openEHR client.
test(
  'openEHR content store: data written by Eir is queryable with AQL by archetype',
  { skip: url ? false : 'EIR_TEST_OPENEHR_URL is not set' },
  async () => {
    const user = process.env.EIR_TEST_OPENEHR_USER ?? 'ehrbase-user';
    const password = process.env.EIR_TEST_OPENEHR_PASSWORD ?? 'SuperSecretPassword';
    const store = createOpenEhrStore({ endpoint: url, username: user, password });
    const tenant = `t-${randomUUID()}`;
    const patient = randomUUID();
    const actor = { id: 'doctor-a', tenant, role: 'clinician' as const };
    await store.insert(actor, 'observation', patient, {
      code: '8867-4',
      value: 64,
      unit: '/min',
      effectiveAt: '2026-10-06T09:55:00+02:00',
      author: 'doctor-a',
    });
    await store.insert(actor, 'condition', patient, {
      code: {
        system: 'ICD-10-SE',
        version: '2026',
        code: 'J06.9',
        display: 'Akut infektion i övre luftvägarna',
      },
      author: 'doctor-a',
    });
    const ask = async (q: string) => {
      const r = await fetch(`${url}/rest/openehr/v1/query/aql`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ q, query_parameters: { ns: `eir:${tenant}` } }),
      });
      assert.equal(r.status, 200);
      return ((await r.json()) as { rows: unknown[][] }).rows;
    };
    const scope = 'FROM EHR e CONTAINS COMPOSITION c CONTAINS';
    assert.deepEqual(
      await ask(
        `SELECT o/data[at0002]/events[at0003]/data[at0001]/items[at0004]/value/magnitude ${scope} OBSERVATION o[openEHR-EHR-OBSERVATION.pulse.v1] WHERE e/ehr_status/subject/external_ref/namespace = $ns`,
      ),
      [[64]],
    );
    assert.deepEqual(
      await ask(
        `SELECT p/data[at0001]/items[at0002]/value/defining_code/code_string ${scope} EVALUATION p[openEHR-EHR-EVALUATION.problem_diagnosis.v1] WHERE e/ehr_status/subject/external_ref/namespace = $ns`,
      ),
      [['J06.9']],
    );
  },
);
