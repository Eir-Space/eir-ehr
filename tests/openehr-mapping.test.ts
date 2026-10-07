import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from '../packages/contracts.ts';
import { Runtime } from '../packages/runtime.ts';
import { createOpenEhrStore, fromFlat, toFlat, vitalMap } from '../packages/openehr.ts';
import content from '../plugins/content-openehr.ts';

const actor: Actor = { id: 'doctor-a', tenant: 'clinic-a', role: 'clinician' };
const when = '2026-10-06T09:55:00+02:00';
const pulse = {
  code: '8867-4',
  value: 72,
  unit: '/min',
  effectiveAt: when,
  author: 'doctor-a',
  status: 'final',
};
const status = (e: unknown) => (e as { status?: number }).status;

test('observations map to archetype paths with openEHR units and round-trip', () => {
  const flat = toFlat('observation', pulse, actor, when);
  const p = 'vital_signs_observations/vital_signs/pulse_heart_beat';
  assert.equal(flat[`${p}/heart_rate|magnitude`], 72);
  assert.equal(flat[`${p}/heart_rate|unit`], '/min');
  assert.equal(flat[`${p}/time`], when);
  assert.deepEqual(fromFlat('observation', flat), pulse);
  const temp = toFlat(
    'observation',
    { ...pulse, code: '8310-5', unit: 'Cel', value: 37.2 },
    actor,
    when,
  );
  assert.equal(
    temp['vital_signs_observations/vital_signs/body_temperature/temperature|unit'],
    '°C',
  );
  const spo2 = toFlat(
    'observation',
    { ...pulse, code: '59408-5', unit: '%', value: 97 },
    actor,
    when,
  );
  assert.equal(
    spo2['vital_signs_observations/vital_signs/indirect_oximetry/spo2|denominator'],
    100,
  );
});

test('anything the template cannot hold is refused, never stored lossily', () => {
  assert.equal(vitalMap['29463-7'], undefined);
  assert.throws(
    () => toFlat('observation', { ...pulse, code: '29463-7', unit: 'kg', value: 80 }, actor, when),
    (e) => status(e) === 422,
  );
  assert.throws(
    () => toFlat('observation', { ...pulse, unit: 'bpm' }, actor, when),
    (e) => status(e) === 422,
  );
  assert.throws(
    () => toFlat('condition', { code: { code: 'A09' } }, actor, when),
    (e) => status(e) === 422,
  );
  assert.throws(
    () => toFlat('note', { text: '' }, actor, when),
    (e) => status(e) === 422,
  );
  assert.throws(
    () => toFlat('encounter', {}, actor, when),
    (e) => status(e) === 422,
  );
});

test('a diagnosis keeps its code system, code and display as a coded value', () => {
  const data = {
    code: { system: 'ICD-10-SE', version: '2026', code: 'A09', display: 'Akut gastroenterit' },
    onset: '2026-01-05',
    status: 'active',
  };
  const flat = toFlat('condition', data, actor, when);
  const p = 'problem_list/problems_and_issues/problem_diagnosis:0/problem_diagnosis_name';
  assert.equal(flat[`${p}|code`], 'A09');
  assert.equal(flat[`${p}|terminology`], 'ICD-10-SE');
  assert.deepEqual(fromFlat('condition', flat), data);
});

test('archetyped paths are canonical: an edit made elsewhere wins over the envelope', () => {
  const flat = toFlat('observation', pulse, actor, when);
  const p = 'vital_signs_observations/vital_signs/pulse_heart_beat';
  flat[`${p}/heart_rate|magnitude`] = 99;
  flat[`${p}/time`] = '2026-10-06T08:00:00+00:00';
  const read = fromFlat('observation', flat);
  assert.equal(read.value, 99);
  assert.equal(read.effectiveAt, '2026-10-06T08:00:00+00:00');
  assert.equal(read.author, 'doctor-a');
  // The same instant in another notation keeps the notation Eir wrote.
  flat[`${p}/time`] = '2026-10-06T07:55:00Z';
  flat[`${p}/heart_rate|magnitude`] = 72;
  assert.equal(fromFlat('observation', flat).effectiveAt, when);
});

test('a composition from another system, or with a damaged envelope, still reads', () => {
  const note = { 'clinical_notes/clinical_synopsis:0/notes': 'Skriven i annat system' };
  assert.deepEqual(fromFlat('note', note), { text: 'Skriven i annat system' });
  const damaged = { ...note, 'clinical_notes/_feeder_audit/original_content': '{not json' };
  assert.deepEqual(fromFlat('note', damaged), { text: 'Skriven i annat system' });
});

test('the adapter only contacts allowed hosts and needs a credential', () => {
  const ok = { username: 'u', password: 'p' };
  assert.throws(
    () => createOpenEhrStore({ ...ok, endpoint: 'http://example.com/ehrbase' }),
    /allowedHosts/,
  );
  assert.throws(
    () => createOpenEhrStore({ ...ok, endpoint: 'http://u:p@127.0.0.1/ehrbase' }),
    /allowedHosts/,
  );
  assert.throws(() => createOpenEhrStore({ username: 'u' }), /password/);
  assert.throws(
    () => createOpenEhrStore({ username: 'u', passwordEnv: 'EIR_TEST_UNSET_PASSWORD_VAR' }),
    /not set/,
  );
  assert.ok(
    createOpenEhrStore({
      ...ok,
      endpoint: 'https://ehr.example.org/ehrbase',
      allowedHosts: ['ehr.example.org'],
    }),
  );
});

test('the plugin registers the store under its key', async () => {
  const runtime = await new Runtime().start([
    { plugin: content, config: { key: 'clinical-openehr', username: 'u', password: 'p' } },
  ]);
  assert.deepEqual([...runtime.contributions('contentStore').keys()], ['clinical-openehr']);
  await runtime.stop();
});
