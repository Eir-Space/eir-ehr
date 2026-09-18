import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicDemo } from '../apps/public-demo.ts';
import { root } from './helpers.ts';

test('public demo isolates visitors, validates start mode, rejects national IDs and destroys sessions', async (t) => {
  const app = await createPublicDemo(root);
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/deployment.json' })).json().mode, 'public-demo');
  assert.equal((await app.inject({ url: '/guide.html' })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/demo/start', payload: {} })).statusCode,
    422,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/demo/start',
        payload: { syntheticOnly: true },
        headers: { origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  );
  const start = () =>
    app.inject({ method: 'POST', url: '/demo/start', payload: { syntheticOnly: true } });
  const a = (await start()).json();
  const b = (await start()).json();
  assert.notEqual(a.token, b.token);
  const headers = { authorization: `Bearer ${a.token}` };
  const other = { authorization: `Bearer ${b.token}` };
  const patients = (await app.inject({ url: '/api/patients', headers })).json();
  const otherPatients = (await app.inject({ url: '/api/patients', headers: other })).json();
  assert.notEqual(patients[0].id, otherPatients[0].id);
  assert.equal(
    (await app.inject({ url: `/api/patients/${patients[0].id}/chart`, headers: other })).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: '/api/patients', headers: { authorization: 'Bearer made-up' } }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/patients',
        headers,
        payload: {
          name: 'Synthetic only',
          identifier: { type: 'personnummer', value: '199001010017' },
          birthDate: '1990-01-01',
        },
      })
    ).statusCode,
    422,
  );
  const chart = (
    await app.inject({ url: `/api/patients/${patients[0].id}/chart`, headers })
  ).json();
  const encounter = chart.find(
    (r: any) => r.kind === 'encounter' && r.data.status === 'in-progress',
  );
  const saved = await app.inject({
    method: 'POST',
    url: `/api/patients/${patients[0].id}/records/note`,
    headers,
    payload: { encounterId: encounter.id, text: 'Synthetic visitor note' },
  });
  assert.equal(saved.statusCode, 201);
  assert.equal(
    (await app.inject({ url: `/api/records/${saved.json().id}/history`, headers: other }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/logout', headers, payload: {} })).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/api/patients', headers })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/patients', headers: other })).statusCode, 200);
});

test('demo capacity reservations, expiry cleanup and request budgets are enforced', async (t) => {
  let clock = Date.now();
  const app = await createPublicDemo(root, {
    now: () => clock,
    ttl: 1000,
    capacity: 1,
    requests: 1,
  });
  t.after(() => app.close());
  const start = () =>
    app.inject({ method: 'POST', url: '/demo/start', payload: { syntheticOnly: true } });
  const attempts = await Promise.all([start(), start()]);
  assert.deepEqual(attempts.map((a) => a.statusCode).sort(), [201, 503]);
  const token = attempts.find((a) => a.statusCode === 201)!.json().token;
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ url: '/api/patients', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/patients', headers })).statusCode, 429);
  // Destruction must remain available even after exhausting the request allowance.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/logout', headers, payload: {} })).statusCode,
    200,
  );
  const next = (await start()).json();
  clock += 1001;
  assert.equal(
    (await app.inject({ url: '/api/patients', headers: { authorization: `Bearer ${next.token}` } }))
      .statusCode,
    401,
  );
  assert.equal((await start()).statusCode, 201);
  clock += 1001;
  assert.equal((await start()).statusCode, 201);
});

test('public demo caps payload size and write allowance', async (t) => {
  const app = await createPublicDemo(root, { writes: 1, bytes: 100 });
  t.after(() => app.close());
  const { token } = (
    await app.inject({ method: 'POST', url: '/demo/start', payload: { syntheticOnly: true } })
  ).json();
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/patients',
        headers,
        payload: { name: 'x'.repeat(33000) },
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/patients', headers, payload: {} })).statusCode,
    422,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/patients', headers, payload: {} })).statusCode,
    429,
  );
});
