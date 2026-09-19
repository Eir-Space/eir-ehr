import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fixture, doctor } from './helpers.ts';
import { Runtime } from '../packages/runtime.ts';
import type { Plugin } from '../packages/contracts.ts';
import countrySE from '../plugins/country-se.ts';
import countryEU from '../plugins/country-eu-local.ts';
test('Swedish identifiers use established validation with explicit century and namespaces', async (t) => {
  const runtime = await new Runtime().start([{ plugin: countrySE }]);
  t.after(async () => await runtime.stop());
  const country = runtime.get('country');
  const valid = country.identifier({ type: 'personnummer', value: '199001010017' });
  assert.equal(valid.system, 'http://electronichealth.se/identifier/personnummer');
  assert.throws(() => country.identifier({ type: 'personnummer', value: '9001010017' }));
  assert.throws(() => country.identifier({ type: 'personnummer', value: '199001010018' }));
  assert.throws(() => country.identifier({ type: 'personnummer', value: '199002310017' }));
  const c = country.identifier({ type: 'samordningsnummer', value: '197010632391' });
  assert.equal(c.type, 'samordningsnummer');
  assert.throws(() => country.identifier({ type: 'personnummer', value: '197010632391' }));
});
test('country provider can be replaced; duplicate providers and dependency cycles fail', async () => {
  const runtime = await new Runtime().start([
    { plugin: countryEU, config: { code: 'DK', locale: 'da-DK' } },
  ]);
  assert.equal(runtime.get('country').code, 'DK');
  await runtime.stop();
  await assert.rejects(
    new Runtime().start([{ plugin: countrySE }, { plugin: countryEU }]),
    /Duplicate provider/,
  );
  const bad: Plugin = { ...countrySE, requires: ['store'] };
  await assert.rejects(new Runtime().start([{ plugin: bad }]), /Missing or cyclic/);
});
test('plugin failure unwinds previously acquired resources', async () => {
  let disposed = false;
  const first: Plugin = {
    ...countrySE,
    setup(ctx) {
      countrySE.setup(ctx);
      return () => {
        disposed = true;
      };
    },
  };
  const fail: Plugin = {
    id: 'test.fail',
    version: '1.0.0',
    apiVersion: 2,
    requires: ['country'],
    provides: ['aiProvider'],
    setup() {
      throw new Error('failure');
    },
  };
  await assert.rejects(new Runtime().start([{ plugin: first }, { plugin: fail }]));
  assert.equal(disposed, true);
});
test('AI proposal requires review, creates only draft, and rejects replay or stale context', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const ai = f.runtime.get('aiReview');
  const proposal = await ai.propose(doctor, f.patient.id, f.encounter.id);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'note')).length, 0);
  const accepted = await ai.review(doctor, proposal.id, 1, 'accept');
  assert.equal((await f.store.get(doctor.tenant, accepted.data.noteId))?.data.status, 'draft');
  await assert.rejects(
    async () => await ai.review(doctor, proposal.id, 1, 'accept'),
    /already reviewed/,
  );
  const stale = await ai.propose(doctor, f.patient.id, f.encounter.id);
  await f.clinical.create(doctor, f.patient.id, 'allergy', {
    substance: 'Synthetic substance',
    reaction: 'Synthetic reaction',
    criticality: 'unable-to-assess',
  });
  await assert.rejects(
    async () => await ai.review(doctor, stale.id, 1, 'accept'),
    /context changed/,
  );
  const rejected = await ai.review(doctor, stale.id, 1, 'reject');
  assert.equal(rejected.data.status, 'rejected');
});
test('AI rejects invented citations and rechecks access after inference', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const provider = f.runtime.get('aiProvider');
  provider.generate = async () => ({
    text: 'Invented',
    mode: 'model',
    model: 'test',
    citations: [{ ref: 'wrong@1', text: 'absent' }],
  });
  await assert.rejects(
    f.runtime.get('aiReview').propose(doctor, f.patient.id, f.encounter.id),
    /invalid source/,
  );
  provider.generate = async (evidence) => {
    await f.runtime
      .get('access')
      .block(
        { id: 'patient', role: 'patient', tenant: doctor.tenant, patientId: f.patient.id },
        f.patient.id,
        true,
      );
    return { text: evidence[0].text, mode: 'model', model: 'test', citations: [evidence[0]] };
  };
  await assert.rejects(
    f.runtime.get('aiReview').propose(doctor, f.patient.id, f.encounter.id),
    /No active/,
  );
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'proposal')).length, 0);
});
test('FHIR export maps supported records with resolvable patient references and no AI proposal leakage', async (t) => {
  const f = await fixture();
  t.after(async () => await f.runtime.stop());
  const note = await f.clinical.create(doctor, f.patient.id, 'note', {
    encounterId: f.encounter.id,
    text: 'Svensk journaltext åäö',
  });
  await f.clinical.transition(doctor, note.id, 'sign', 1, {});
  await f.runtime.get('aiReview').propose(doctor, f.patient.id, f.encounter.id);
  const bundle = await f.runtime.get('fhir').bundle(doctor, f.patient.id);
  assert.equal(bundle.type, 'collection');
  assert.equal(bundle.entry.length, 3);
  const doc = bundle.entry.find(
    (e: any) => e.resource.resourceType === 'DocumentReference',
  ).resource;
  assert.equal(
    Buffer.from(doc.content[0].attachment.data, 'base64').toString(),
    'Svensk journaltext åäö',
  );
  assert.equal(doc.docStatus, 'final');
  assert.ok(bundle.entry.some((e: any) => e.fullUrl === doc.subject.reference));
});

test('AI inference runs outside transactions and rejects evidence changed during generation', async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  const context = new AsyncLocalStorage<boolean>();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn) => transaction(() => context.run(true, fn));
  f.runtime.get('aiProvider').generate = async (evidence) => {
    assert.equal(context.getStore(), undefined);
    await f.clinical.create(doctor, f.patient.id, 'allergy', {
      substance: 'Updated during inference',
      reaction: 'Reported reaction',
      criticality: 'unable-to-assess',
    });
    return { text: evidence[0].text, mode: 'model', model: 'test', citations: [evidence[0]] };
  };
  await assert.rejects(
    () => f.runtime.get('aiReview').propose(doctor, f.patient.id, f.encounter.id),
    /context changed/,
  );
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'proposal')).length, 0);
  assert.equal((await f.store.list(doctor.tenant, f.patient.id, 'allergy')).length, 1);
});
