// Conformance suite for the ContentStore seam. A provider is accepted by passing this, not by
// claiming compatibility. Call `runContentContract` from one test file per provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor, Entity } from '../packages/contracts.ts';
import type { ContentStore } from '../packages/content.ts';

export type Harness = { store: ContentStore; stop(): Promise<void> };
type Options = { skip?: string | false };
const code = { system: 'ICD-10-SE', version: '2026', code: 'A09', display: 'Akut gastroenterit' };
const samples: Record<string, (n: number) => Record<string, any>> = {
  observation: (n) => ({
    encounterId: randomUUID(),
    code: '8867-4',
    value: 70 + n,
    unit: '/min',
    effectiveAt: '2026-10-06T09:55:00+02:00',
    display: 'Puls',
    status: 'final',
    author: 'doctor-a',
  }),
  condition: () => ({ code, onset: '2026-01-05', status: 'active', author: 'doctor-a' }),
  note: (n) => ({
    encounterId: randomUUID(),
    text: `Syntetisk anteckning ${n}: återbesök, trött, ingen feber.`,
    clientId: randomUUID(),
    status: 'draft',
    author: 'doctor-a',
  }),
};
const actor = (tenant: string): Actor => ({ id: 'doctor-a', tenant, role: 'clinician' });
const status = (e: unknown) => (e as { status?: number }).status;
const plain = (e: Entity) => ({
  kind: e.kind,
  patientId: e.patientId,
  version: e.version,
  data: e.data,
});

export function runContentContract(
  name: string,
  make: () => Promise<Harness>,
  options: Options = {},
) {
  const t = (title: string, fn: (h: Harness) => Promise<void>) =>
    test(`${name}: ${title}`, { skip: options.skip }, async () => {
      const h = await make();
      try {
        await fn(h);
      } finally {
        await h.stop();
      }
    });
  const fresh = () => ({ tenant: `t-${randomUUID()}`, patient: randomUUID() });
  const kindsOf = (h: Harness) => h.store.kinds.filter((k) => k in samples);

  t('declares the three clinical kinds and is healthy', async ({ store }) => {
    for (const k of ['observation', 'condition', 'note']) assert.ok(store.kinds.includes(k), k);
    await store.health();
  });

  t('insert returns version 1 and get, list round-trip the data for every kind', async (h) => {
    const { tenant, patient } = fresh();
    for (const kind of kindsOf(h)) {
      const data = samples[kind](1);
      const made = await h.store.insert(actor(tenant), kind, patient, data);
      assert.match(made.id, /^[0-9a-f-]{36}$/);
      assert.equal(made.version, 1);
      assert.equal(made.tenant, tenant);
      assert.equal(made.patientId, patient);
      assert.equal(made.kind, kind);
      assert.ok(Date.parse(made.createdAt) > 0 && Date.parse(made.updatedAt) > 0);
      assert.deepEqual(made.data, data, `${kind} insert data`);
      const read = await h.store.get(tenant, made.id);
      assert.ok(read, `${kind} get`);
      assert.deepEqual(plain(read), plain(made), `${kind} get equals insert`);
      const listed = await h.store.list(tenant, patient, kind);
      assert.deepEqual(
        listed.map((e) => e.id),
        [made.id],
      );
    }
    assert.equal((await h.store.list(tenant, patient)).length, kindsOf(h).length);
  });

  t('revise bumps the version, keeps identity and history is complete', async (h) => {
    const { tenant, patient } = fresh();
    for (const kind of kindsOf(h)) {
      const v1 = await h.store.insert(actor(tenant), kind, patient, samples[kind](1));
      const next = { ...samples[kind](2) };
      for (const key of ['encounterId', 'clientId']) if (key in v1.data) next[key] = v1.data[key];
      const v2 = await h.store.revise(actor(tenant), v1, 1, next, `${kind}.saved`);
      assert.equal(v2.version, 2);
      assert.equal(v2.id, v1.id);
      assert.equal(v2.createdAt, v1.createdAt);
      assert.deepEqual(v2.data, next, `${kind} revised data`);
      assert.deepEqual(plain((await h.store.get(tenant, v1.id))!), plain(v2));
      const history = await h.store.history(tenant, v1.id);
      assert.deepEqual(
        history.map((e) => e.version),
        [1, 2],
      );
      assert.deepEqual(history[0].data, v1.data, `${kind} history v1`);
      assert.deepEqual(history[1].data, next, `${kind} history v2`);
    }
  });

  t(
    'a stale or mismatched version is a 409 and concurrent revisions cannot both win',
    async (h) => {
      const { tenant, patient } = fresh();
      const kind = kindsOf(h)[0];
      const v1 = await h.store.insert(actor(tenant), kind, patient, samples[kind](1));
      await h.store.revise(actor(tenant), v1, 1, samples[kind](2), 'x');
      await assert.rejects(
        h.store.revise(actor(tenant), v1, 1, samples[kind](3), 'x'),
        (e) => status(e) === 409,
      );
      const v2 = (await h.store.get(tenant, v1.id))!;
      await assert.rejects(
        h.store.revise(actor(tenant), v2, 1, samples[kind](3), 'x'),
        (e) => status(e) === 409,
      );
      const results = await Promise.allSettled([
        h.store.revise(actor(tenant), v2, 2, samples[kind](4), 'x'),
        h.store.revise(actor(tenant), v2, 2, samples[kind](5), 'x'),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await h.store.get(tenant, v1.id))!.version, 3);
    },
  );

  t('tenants and patients are isolated', async (h) => {
    const a = fresh(),
      b = fresh();
    const kind = kindsOf(h)[0];
    const made = await h.store.insert(actor(a.tenant), kind, a.patient, samples[kind](1));
    assert.equal(await h.store.get(b.tenant, made.id), undefined);
    assert.deepEqual(await h.store.list(b.tenant, a.patient), []);
    assert.deepEqual(await h.store.history(b.tenant, made.id), []);
    assert.deepEqual(await h.store.list(a.tenant, b.patient), []);
    await assert.rejects(
      h.store.revise(actor(b.tenant), made, 1, samples[kind](2), 'x'),
      (e) => status(e) === 403 || status(e) === 409,
    );
    assert.equal((await h.store.get(a.tenant, made.id))!.version, 1);
  });

  t('unknown ids are absent, not errors', async ({ store }) => {
    const { tenant } = fresh();
    assert.equal(await store.get(tenant, randomUUID()), undefined);
    assert.equal(await store.get(tenant, 'not-a-uuid'), undefined);
    assert.deepEqual(await store.history(tenant, randomUUID()), []);
  });

  t('a signed note is immutable', async ({ store }) => {
    const { tenant, patient } = fresh();
    const draft = await store.insert(actor(tenant), 'note', patient, samples.note(1));
    const signed = await store.revise(
      actor(tenant),
      draft,
      1,
      {
        ...draft.data,
        status: 'signed',
        signedBy: 'doctor-a',
        signedAt: '2026-10-06T10:00:00.000Z',
      },
      'note.signed',
    );
    assert.equal(signed.data.status, 'signed');
    await assert.rejects(
      store.revise(actor(tenant), signed, 2, { ...signed.data, text: 'ändrad' }, 'x'),
    );
    const after = await store.get(tenant, draft.id);
    assert.equal(after!.version, 2);
    assert.equal(after!.data.text, draft.data.text);
  });

  t('an origin key makes insert findable and survives revision, within one tenant', async (h) => {
    if (!h.store.findByOrigin) return; // optional capability
    const { tenant, patient } = fresh();
    const origin = `origin-${randomUUID()}`;
    const made = await h.store.insert(actor(tenant), 'note', patient, samples.note(1), origin);
    assert.equal((await h.store.findByOrigin(tenant, patient, origin))?.id, made.id);
    assert.equal(await h.store.findByOrigin(tenant, patient, `origin-${randomUUID()}`), undefined);
    assert.equal(await h.store.findByOrigin(`t-${randomUUID()}`, patient, origin), undefined);
    assert.equal(await h.store.findByOrigin(tenant, randomUUID(), origin), undefined);
    await h.store.revise(actor(tenant), made, 1, samples.note(2), 'x');
    assert.equal((await h.store.findByOrigin(tenant, patient, origin))?.version, 2);
  });

  t(
    'typed queries return current versions, newest first, scoped to tenant and patient',
    async (h) => {
      const store = h.store;
      if (!store.vitalSeries || !store.problems) return; // optional capability
      const { tenant, patient } = fresh();
      const older = {
        ...samples.observation(1),
        value: 60,
        effectiveAt: '2026-10-05T08:00:00+02:00',
      };
      const newer = {
        ...samples.observation(2),
        value: 70,
        effectiveAt: '2026-10-06T08:00:00+02:00',
      };
      const a = await store.insert(actor(tenant), 'observation', patient, older);
      const b = await store.insert(actor(tenant), 'observation', patient, newer);
      const series = await store.vitalSeries(tenant, patient, '8867-4', 10);
      assert.deepEqual(
        series.map((p) => p.id),
        [b.id, a.id],
      );
      assert.deepEqual(
        series.map((p) => [p.value, p.unit, p.version, p.code]),
        [
          [70, '/min', 1, '8867-4'],
          [60, '/min', 1, '8867-4'],
        ],
      );
      assert.equal(Date.parse(series[0].effectiveAt), Date.parse(newer.effectiveAt));
      assert.equal((await store.vitalSeries(tenant, patient, '8867-4', 1)).length, 1);
      await store.revise(actor(tenant), a, 1, { ...older, value: 61 }, 'x');
      const after = await store.vitalSeries(tenant, patient, '8867-4', 10);
      assert.deepEqual(
        after.find((p) => p.id === a.id) && [
          after.find((p) => p.id === a.id)!.value,
          after.find((p) => p.id === a.id)!.version,
        ],
        [61, 2],
      );
      assert.equal(
        (
          await store
            .vitalSeries(tenant, patient, '8310-5', 10)
            .catch((e) => (status(e) === 422 ? [] : Promise.reject(e)))
        ).length,
        0,
      );
      assert.deepEqual(await store.vitalSeries(`t-${randomUUID()}`, patient, '8867-4', 10), []);
      assert.deepEqual(await store.vitalSeries(tenant, randomUUID(), '8867-4', 10), []);
      const c = await store.insert(actor(tenant), 'condition', patient, samples.condition(1));
      const problems = await store.problems(tenant, patient, 10);
      assert.deepEqual(
        problems.map((p) => [p.id, p.code, p.display, p.version]),
        [[c.id, 'A09', 'Akut gastroenterit', 1]],
      );
      assert.deepEqual(await store.problems(`t-${randomUUID()}`, patient, 10), []);
    },
  );

  t('an unsupported kind is rejected with 422, not stored lossily', async ({ store }) => {
    const { tenant, patient } = fresh();
    await assert.rejects(
      store.insert(actor(tenant), 'spaceship', patient, {}),
      (e) => status(e) === 422,
    );
  });
}
