import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, doctor, root } from './helpers.ts';
import { createApp } from '../apps/app.ts';
import { importIcd, icdSource } from '../packages/icd.ts';
import { seedDemo } from '../apps/seed.ts';

test('verified Swedish catalogue supports codes, accents, synonyms, categories and bounded results', async (t) => {
  const { runtime } = await fixture();
  t.after(() => runtime.stop());
  const terms = runtime.get('terminology');
  assert.equal(terms.source.count, 38631);
  assert.equal(terms.source.version, '2026-01-01');
  assert.equal(terms.lookup('i109')?.code, 'I10.9');
  assert.equal(terms.lookup('I10')?.selectable, false);
  assert.equal(terms.lookup('I10.9')?.selectable, true);
  assert.equal(terms.lookup('B90.0')?.notPrincipal, true);
  assert.equal(terms.lookup('D63.0')?.manifestation, true);
  assert.equal(terms.lookup('Z999999'), undefined);
  assert.equal(terms.search('e119').items[0].code, 'E11.9');
  assert.equal(terms.search('I10.9').items[0].code, 'I10.9');
  assert.equal(terms.search('I10.').items[0].code, 'I10.9');
  assert.ok(terms.search('hypertoni').items.some((r) => r.code === 'I10.9'));
  assert.ok(terms.search('hösnuva').items.some((r) => r.code === 'J30.1'));
  assert.deepEqual(terms.search('hösnuva'), terms.search('hosnuva'));
  assert.equal(terms.search('no-such-diagnosis').total, 0);
  assert.equal(terms.search('', 1).items.length, 1);
  assert.equal(terms.search('diabetes', 2).items.length, 2);
  assert.throws(() => terms.search('x'.repeat(101)));
  assert.throws(() => terms.search('x', 51));
  assert.throws(() => importIcd(Buffer.from('unreviewed release')), /checksum/);
});

test('diagnosis API authenticates, canonicalizes coding and exports its release version', async (t) => {
  const { runtime, patient } = await fixture();
  const app = await createApp(runtime, root);
  t.after(async () => {
    await app.close();
    runtime.stop();
  });
  const token = runtime.get('identity').issue!(doctor);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ url: '/api/terminology/diagnoses?q=I10' })).statusCode, 401);
  const search = await app.inject({ url: '/api/terminology/diagnoses?q=I109&limit=5', headers });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().items[0].code, 'I10.9');
  for (const query of ['limit=51', 'limit=abc', 'q=' + 'x'.repeat(101), 'extra=1'])
    assert.equal(
      (await app.inject({ url: `/api/terminology/diagnoses?${query}`, headers })).statusCode,
      422,
    );
  const create = (code: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/patients/${patient.id}/records/condition`,
      headers,
      payload: { code },
    });
  const coding = {
    system: icdSource.system,
    version: icdSource.version,
    code: 'i109',
    display: 'Incorrect client label',
  };
  const saved = await create(coding);
  assert.equal(saved.statusCode, 201);
  assert.equal(saved.json().data.code.code, 'I10.9');
  assert.equal(saved.json().data.code.display, runtime.get('terminology').lookup('I10.9')!.display);
  assert.equal((await create({ ...coding, code: 'I10' })).statusCode, 422);
  assert.equal((await create({ ...coding, code: 'NOT-A-CODE' })).statusCode, 422);
  assert.equal(
    (await create({ ...coding, system: 'https://untrusted.example/codes' })).statusCode,
    422,
  );
  assert.equal((await create({ ...coding, version: '2025' })).statusCode, 409);
  const bundle = (
    await app.inject({ url: `/api/patients/${patient.id}/export/fhir`, headers })
  ).json();
  assert.equal(
    bundle.entry.find((e: any) => e.resource.resourceType === 'Condition').resource.code.coding[0]
      .version,
    icdSource.version,
  );
});

test('fictional patient scenarios have distinct records, open work and immutable signed history', async (t) => {
  const { runtime, clinical } = await fixture();
  t.after(() => runtime.stop());
  const actor = { ...doctor, tenant: 'demo-clinic' };
  seedDemo(runtime, actor);
  const patients = clinical.patients(actor);
  assert.equal(patients.length, 4);
  assert.equal(patients[0].data.name, 'Anna Lindberg');
  assert.equal(new Set(patients.map((p) => p.data.identifier.value)).size, 4);
  for (const patient of patients) {
    assert.equal(patient.data.identifier.type, 'local');
    assert.match(patient.data.identifier.value, /^DEMO-00[1-4]$/);
    const chart = clinical.chart(actor, patient.id);
    assert.equal(
      chart.filter((r) => r.kind === 'encounter' && r.data.status === 'in-progress').length,
      1,
    );
    assert.equal(chart.filter((r) => r.kind === 'note' && r.data.status === 'signed').length, 1);
    assert.equal(chart.filter((r) => r.kind === 'note' && r.data.status === 'draft').length, 1);
    assert.equal(chart.filter((r) => r.kind === 'task').length, 2);
    const observations = chart.filter((r) => r.kind === 'observation');
    assert.equal(observations.length, 10);
    assert.equal(new Set(observations.map((r) => r.data.effectiveAt)).size, 2);
    assert.ok(observations.every((r) => Date.parse(r.data.effectiveAt) <= Date.now()));
    assert.ok(
      chart
        .filter((r) => r.kind === 'condition')
        .every((r) => r.data.code.version === icdSource.version),
    );
  }
});
