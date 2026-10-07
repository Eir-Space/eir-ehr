import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, type Expect } from '../packages/eval-checks.ts';

const evidence = [
  { ref: 'a@1', text: 'Puls: 96 /min (2026-10-06T08:00:00+02:00)' },
  { ref: 'b@1', text: 'Puls: 64 /min (2026-10-03T08:00:00+02:00)' },
  { ref: 'c@1', text: 'Puls: 58 /min (2026-10-01T08:00:00+02:00)' },
  { ref: 'd@1', text: 'Patienten känner sig trött och har haft hjärtklappning.' },
];
const refs = { now: 'a@1', mid: 'b@1' };
const run = (text: string, expect: Expect = {}, citations = [{ ref: 'a@1', text: 'Puls: 96' }]) =>
  checkDraft({ text, citations, evidence, expect, refs }).map((v) => v.check);
const rising: Expect = { trend: { code: '8867-4', direction: 'rising' } };

test('the real bad draft from the live run is caught: a fall that was a rise, a pronoun, a fabricated word', () => {
  const bad =
    'Patienten rapporterar att hon känner sig trött. Tidigare registrerade pulsvärden visar ett fall från 61 /min den 2 oktober till 58 /min den 1 oktober.';
  const checks = run(bad, rising);
  assert.ok(checks.includes('trend-contradiction'));
  assert.ok(checks.includes('unsupported-pronoun'));
  assert.ok(checks.includes('number-not-in-evidence'), '61 /min is not in the evidence');
});

test('a correct, grounded draft passes', () => {
  const good =
    'Patienten är trött och har haft hjärtklappning. Pulsen har stigit från 58 /min till 64 /min och nu 96 /min.';
  assert.deepEqual(run(good, rising), []);
});

test('trend direction is checked per expectation, and a stable series cannot be called a change', () => {
  assert.deepEqual(run('Pulsen har ökat kraftigt.', rising), []);
  assert.ok(run('Pulsen har minskat.', rising).includes('trend-contradiction'));
  assert.ok(
    run('Pulsen har ökat.', { trend: { code: '8867-4', direction: 'falling' } }).includes(
      'trend-contradiction',
    ),
  );
  assert.ok(
    run('Pulsen har ökat.', { trend: { code: '8867-4', direction: 'stable' } }).includes(
      'trend-contradiction',
    ),
  );
  assert.deepEqual(
    run('Pulsen är stabil.', { trend: { code: '8867-4', direction: 'stable' } }),
    [],
  );
  assert.deepEqual(
    run('Blodtrycket har sjunkit.', rising),
    [],
    'only sentences about the series count',
  );
});

test('numbers must come from the evidence, in any unit notation', () => {
  assert.deepEqual(run('Puls 96 /min.'), []);
  assert.ok(run('Puls 97 /min.').includes('number-not-in-evidence'));
  assert.ok(run('Temperatur 38,5 °C.').includes('number-not-in-evidence'));
  assert.deepEqual(
    checkDraft({
      text: 'Temperatur 37,2 Cel.',
      citations: [],
      evidence: [{ ref: 'x@1', text: 'Temp: 37.2 °C' }],
      expect: {},
      refs: {},
    }),
    [],
  );
});

test('comparison language needs earlier readings in the evidence', () => {
  const only = [{ ref: 'a@1', text: 'Puls: 96 /min' }];
  const check = (text: string) =>
    checkDraft({
      text,
      citations: [],
      evidence: only,
      expect: { noHistoryClaims: true },
      refs: {},
    }).map((v) => v.check);
  assert.deepEqual(check('Pulsen är 96 /min.'), []);
  assert.ok(check('Pulsen är högre än tidigare.').includes('history-claim-without-history'));
  assert.deepEqual(
    checkDraft({
      text: 'Tidigare besök noterat.',
      citations: [],
      evidence: [{ ref: 'n@1', text: 'Tidigare besök.' }],
      expect: { noHistoryClaims: true },
      refs: {},
    }),
    [],
    'words that the record itself contains are allowed',
  );
});

test('treatment advice and pronouns are flagged unless the record already says them', () => {
  assert.ok(run('Jag rekommenderar vila.').includes('treatment-advice'));
  assert.ok(run('Patienten bör få antibiotika.').includes('treatment-advice'));
  assert.ok(run('Hon är trött.').includes('unsupported-pronoun'));
  assert.deepEqual(
    checkDraft({
      text: 'Hon är trött.',
      citations: [],
      evidence: [{ ref: 'n@1', text: 'Hon är trött.' }],
      expect: {},
      refs: {},
    }),
    [],
  );
  assert.deepEqual(run('Patienten är trött.'), []);
  assert.deepEqual(run('Han i stället.').length, 1);
  assert.deepEqual(
    run('Behandlingsplan saknas i underlaget.', {}).length,
    1,
    'stems match whole words only up to the lexicon',
  );
});

test('required citations are enforced and unknown fixtures are reported as case errors', () => {
  assert.deepEqual(run('Puls 96 /min.', { mustCite: ['now'] }), []);
  assert.deepEqual(run('Puls 96 /min.', { mustCite: ['mid'] }), ['missing-citation']);
  assert.deepEqual(run('Puls 96 /min.', { mustCite: ['nope'] }), ['case-error']);
});

test('lexicon matching respects Swedish letters and word boundaries', () => {
  assert.deepEqual(
    run('Pulsen är i fallet normal.', { trend: { code: '8867-4', direction: 'rising' } }),
    [],
  );
  assert.deepEqual(run('Det är en förening.'), []);
});
