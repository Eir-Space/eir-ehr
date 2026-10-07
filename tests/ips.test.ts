import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Entity } from '../packages/contracts.ts';
import { buildIps } from '../packages/ips.ts';
import { fromConfig } from '../packages/runtime.ts';
import { createApp } from '../apps/app.ts';
import { doctor, root } from './helpers.ts';

const at = '2026-10-07T10:00:00.000Z';
const entity = (kind: string, data: Record<string, any>): Entity => ({
  id: randomUUID(),
  tenant: 'clinic-a',
  patientId: 'p',
  kind,
  version: 1,
  createdAt: at,
  updatedAt: at,
  data,
});
const patient = entity('patient', {
  name: 'Syntetisk <Patient> & Co',
  birthDate: '1985-03-12',
  identifier: { system: 'urn:eir:identifier:local', value: 'X-1' },
});
const code = {
  system: 'http://hl7.org/fhir/sid/icd-10-se',
  version: '2026',
  code: 'A09.9',
  display: 'Gastroenterit',
};
const build = (entities: Entity[]) =>
  buildIps({ patient, entities, custodian: { name: 'Syntetisk Vårdcentral' }, now: new Date(at) });
const sections = (b: any) => b.entry[0].resource.section as any[];
const resources = (b: any, type: string) =>
  b.entry.map((e: any) => e.resource).filter((r: any) => r.resourceType === type);

test('the document has the IPS shape: a document Bundle led by a Composition with the three required sections', () => {
  const b = build([entity('condition', { code, status: 'active' })]);
  assert.equal(b.type, 'document');
  assert.equal(b.entry[0].resource.resourceType, 'Composition');
  assert.equal(b.entry[0].resource.type.coding[0].code, '60591-5');
  assert.deepEqual(
    sections(b).map((s) => s.code.coding[0].code),
    ['11450-4', '48765-2', '10160-0'],
  );
  assert.ok(b.meta.profile[0].endsWith('Bundle-uv-ips'));
  // Every reference in the Composition resolves to an entry in the same Bundle.
  const urls = new Set(b.entry.map((e: any) => e.fullUrl));
  const refs = [
    b.entry[0].resource.subject,
    b.entry[0].resource.custodian,
    ...b.entry[0].resource.author,
    ...sections(b).flatMap((s) => s.entry ?? []),
  ];
  for (const r of refs) assert.ok(urls.has(r.reference), r.reference);
});

test('only current records are included, and corrected ones never are', () => {
  const b = build([
    entity('condition', { code, status: 'active' }),
    entity('condition', { code: { ...code, code: 'J06.9' }, status: 'entered-in-error' }),
    entity('allergy', {
      substance: 'Penicillin',
      reaction: 'Utslag',
      criticality: 'high',
      status: 'active',
    }),
    entity('allergy', {
      substance: 'Nötter',
      reaction: 'Svullnad',
      criticality: 'low',
      status: 'entered-in-error',
    }),
    entity('medication', {
      name: 'Metformin',
      dosageText: null,
      source: 'record',
      sourceDetail: 'Journal',
      status: 'stopped',
      indication: '',
    }),
    entity('observation', { code: '8867-4', value: 72, unit: '/min', status: 'final' }),
  ]);
  assert.equal(resources(b, 'Condition').length, 1);
  assert.equal(resources(b, 'AllergyIntolerance').length, 1);
  assert.equal(
    resources(b, 'MedicationStatement').length,
    0,
    'a stopped medication is not current',
  );
  assert.equal(resources(b, 'Observation').length, 0);
});

test('absence is never asserted: an empty section says the information is unavailable', () => {
  const b = build([]);
  for (const s of sections(b)) {
    assert.equal(s.entry, undefined);
    assert.equal(s.emptyReason.coding[0].code, 'unavailable');
  }
  assert.match(sections(b)[1].text.div, /Frånvaro av allergi är inte bekräftad/);
  assert.ok(!JSON.stringify(b).includes('no-known'), 'no "no known allergy" assertion');
});

test('a medication with no recorded start is declared unknown, never given an invented date', () => {
  const b = build([
    entity('medication', {
      name: 'Metformin',
      dosageText: '1 tablett',
      source: 'record',
      sourceDetail: 'Journal',
      status: 'active',
      indication: '',
    }),
  ]);
  const m = resources(b, 'MedicationStatement')[0];
  assert.equal(m.effectiveDateTime, undefined);
  assert.equal(m._effectiveDateTime.extension[0].valueCode, 'unknown');
});

test('narrative is escaped so record text cannot inject markup', () => {
  const b = build([
    entity('condition', {
      code: { ...code, display: '<script>alert(1)</script>' },
      status: 'active',
    }),
  ]);
  // Narrative is XHTML, so it must be escaped; structured fields are JSON data and stay as recorded.
  const narratives = [
    ...b.entry.map((e: any) => e.resource.text?.div),
    ...sections(b).map((x: any) => x.text.div),
  ].filter(Boolean) as string[];
  assert.ok(narratives.length >= 5);
  assert.ok(narratives.every((n) => !n.includes('<script>')));
  assert.ok(narratives.some((n) => n.includes('&#60;script&#62;')));
  assert.equal(resources(b, 'Condition')[0].code.coding[0].display, '<script>alert(1)</script>');
  assert.ok(b.entry[0].resource.text.div.includes('Syntetisk &#60;Patient&#62; &#38; Co'));
});

test('the diagnosis code system is translated for the wire, not the ledger', () => {
  const b = build([entity('condition', { code, status: 'active' })]);
  assert.equal(
    resources(b, 'Condition')[0].code.coding[0].system,
    'https://eir.space/fhir/CodeSystem/icd-10-se',
  );
});

test('the plugin and the route serve the document behind authorization and audit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'eir-ips-'));
  await writeFile(
    join(dir, 'p.yaml'),
    `extends: [${JSON.stringify(root + 'eir.config.json')}]\nprofile: ips-test\npatches:\n  - insert: { id: fhir-ips, module: ${JSON.stringify(root + 'plugins/fhir-ips.ts')}, config: { custodian: { name: Syntetisk Vårdcentral } } }\n    before: ai-review\n`,
  );
  const { runtime } = await fromConfig(join(dir, 'p.yaml'), {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [{ id: 'doctor-a', tenant: 'clinic-a', name: 'Emma Sjöberg', profession: 'Läkare' }],
    },
  });
  const app = await createApp(runtime, root);
  t.after(async () => {
    await app.close();
    await runtime.stop();
  });
  const p = await runtime.get('clinical').register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: 'IPS-T' },
  });
  const headers = { authorization: `Bearer ${await runtime.get('identity').issue!(doctor)}` };
  const res = await app.inject({ url: `/api/patients/${p.id}/export/ips`, headers });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/fhir\+json/);
  assert.equal(res.json().type, 'document');
  assert.equal((await app.inject({ url: `/api/patients/${p.id}/export/ips` })).statusCode, 401);
  const other = { ...doctor, id: 'doctor-b', tenant: 'clinic-b' };
  await assert.rejects(runtime.get('fhirIps').document(other, p.id));
  const rows = (await (runtime.get('store') as any).auditEntries('clinic-a', p.id)) as {
    action: string;
  }[];
  assert.ok(rows.some((r) => r.action === 'fhir.ips'));
  const spec = (await app.inject({ url: '/api/openapi.json', headers })).json();
  assert.ok(spec.paths['/patients/{id}/export/ips'].get);
  // The custodian is required configuration.
  await assert.rejects(
    fromConfig(
      await (async () => {
        await writeFile(
          join(dir, 'bad.yaml'),
          `extends: [${JSON.stringify(root + 'eir.config.json')}]\nprofile: bad\npatches:\n  - insert: { id: fhir-ips, module: ${JSON.stringify(root + 'plugins/fhir-ips.ts')} }\n    before: ai-review\n`,
        );
        return join(dir, 'bad.yaml');
      })(),
      { 'eir.storage.sqlite': { path: ':memory:' } },
    ),
  );
});
