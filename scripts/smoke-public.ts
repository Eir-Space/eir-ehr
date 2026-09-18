import assert from 'node:assert/strict';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:4181').origin;
const tokens: string[] = [];
async function request(path: string, token?: string, body?: unknown, expected = 200) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, expected, `${path}: HTTP ${response.status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response.json();
}
try {
  assert.equal((await request('/deployment.json')).mode, 'public-demo');
  for (let i = 0; i < 2; i++)
    tokens.push((await request('/demo/start', undefined, { syntheticOnly: true }, 201)).token);
  const [a, b] = tokens;
  const patient = (await request('/api/patients', a))[0];
  await request(`/api/patients/${patient.id}/chart`, b, undefined, 403);
  const chart = await request(`/api/patients/${patient.id}/chart`, a);
  const encounter = chart.find(
    (r: any) => r.kind === 'encounter' && r.data.status === 'in-progress',
  );
  const matches = await request('/api/terminology/diagnoses?q=I109', a);
  assert.equal(matches.items[0].code, 'I10.9');
  assert.equal(matches.source.version, '2026-01-01');
  const note = await request(
    `/api/patients/${patient.id}/records/note`,
    a,
    { encounterId: encounter.id, text: 'Synthetic deployment smoke test.' },
    201,
  );
  const signed = await request(`/api/records/${note.id}/sign`, a, {
    version: note.version,
    data: {},
  });
  assert.equal(signed.data.status, 'signed');
  const proposal = await request(`/api/patients/${patient.id}/ai`, a, {
    encounterId: encounter.id,
  });
  assert.equal(proposal.kind, 'proposal');
  const bundle = await request(`/api/patients/${patient.id}/export/fhir`, a);
  assert.equal(bundle.resourceType, 'Bundle');
  assert(bundle.entry.some((entry: any) => entry.resource.resourceType === 'DocumentReference'));
  console.log(
    `PASS ${origin}: session isolation, diagnosis lookup, clinical write/sign, AI proposal and FHIR export.`,
  );
} finally {
  for (const token of tokens) await request('/api/logout', token, {}).catch(() => {});
}
