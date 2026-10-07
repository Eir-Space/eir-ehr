import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Entity } from '../packages/contracts.ts';
import { buildIps } from '../packages/ips.ts';
import { createFhirStore } from '../packages/fhir-store.ts';
import { validate } from '../scripts/fhir-validate.ts';

// Runs the official HL7 validator (in Docker; first run downloads a pinned, checksum-verified jar).
//   EIR_TEST_FHIR_VALIDATE=1 npm test            IPS documents against the IPS 2.0.0 guide
//   plus EIR_TEST_FHIR_URL=http://127.0.0.1:8091/fhir   also the resources stored by the FHIR provider
const enabled = process.env.EIR_TEST_FHIR_VALIDATE === '1';
const skip = enabled ? false : 'EIR_TEST_FHIR_VALIDATE is not set';
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
const code = {
  system: 'http://hl7.org/fhir/sid/icd-10-se',
  version: '2026',
  code: 'A09.9',
  display: 'Gastroenterit och kolit av ospecificerad orsak',
};
const patient = entity('patient', {
  name: 'Syntetisk Patient',
  birthDate: '1985-03-12',
  identifier: { system: 'urn:eir:identifier:local', value: 'X-1' },
});
const ips = (entities: Entity[]) =>
  buildIps({
    patient,
    entities,
    custodian: {
      name: 'Syntetisk Vårdcentral',
      identifier: { system: 'urn:eir:organisation:syntetisk', value: 'SYN-1' },
    },
    now: new Date(at),
  });
const describeErrors = (r: { file: string; errors: { expression?: string[]; text: string }[] }) =>
  r.errors.map((e) => `${e.expression?.join(',')}: ${e.text}`).join('\n');

test(
  'IPS documents, full and empty, validate against IPS 2.0.0 with no errors',
  { skip, timeout: 600000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eir-ips-validate-'));
    const full = ips([
      entity('condition', { code, status: 'active', onset: '2026-09-01' }),
      entity('allergy', {
        substance: 'Penicillin',
        reaction: 'Utslag',
        criticality: 'high',
        status: 'active',
      }),
      entity('medication', {
        name: 'Metformin 500 mg tablett',
        dosageText: '1 tablett 2 gånger dagligen',
        indication: 'Typ 2-diabetes',
        source: 'record',
        sourceDetail: 'Journal',
        status: 'active',
      }),
    ]);
    const files = [join(dir, 'full.json'), join(dir, 'empty.json')];
    await writeFile(files[0], JSON.stringify(full));
    await writeFile(files[1], JSON.stringify(ips([])));
    for (const r of await validate(files, { ig: ['hl7.fhir.uv.ips#2.0.0'] }))
      assert.equal(r.errors.length, 0, `${r.file}\n${describeErrors(r)}`);
  },
);

test(
  'resources the FHIR provider stores validate as FHIR R4 with no errors',
  {
    skip:
      enabled && process.env.EIR_TEST_FHIR_URL
        ? false
        : 'needs EIR_TEST_FHIR_VALIDATE=1 and EIR_TEST_FHIR_URL',
    timeout: 600000,
  },
  async () => {
    const url = process.env.EIR_TEST_FHIR_URL!;
    const store = createFhirStore({ endpoint: url });
    const actor = { id: 'doctor-a', tenant: `t-${randomUUID()}`, role: 'clinician' as const };
    const pid = randomUUID();
    const made = [
      await store.insert(actor, 'observation', pid, {
        code: '8867-4',
        value: 72,
        unit: '/min',
        effectiveAt: '2026-10-06T09:55:00+02:00',
        display: 'Puls',
        status: 'final',
        author: 'doctor-a',
      }),
      await store.insert(actor, 'condition', pid, {
        code,
        onset: '2026-01-05',
        status: 'active',
        author: 'doctor-a',
      }),
      await store.insert(actor, 'note', pid, {
        text: 'Syntetisk anteckning',
        status: 'draft',
        author: 'doctor-a',
      }),
    ];
    const dir = await mkdtemp(join(tmpdir(), 'eir-fhir-validate-'));
    const files: string[] = [];
    for (const [i, e] of made.entries()) {
      const type = ['Observation', 'Condition', 'DocumentReference'][i];
      const res = await fetch(`${url}/${type}/${e.id}`, {
        headers: { accept: 'application/fhir+json' },
      });
      const body = await res.json();
      // The server adds its own narrative-free metadata; validate what a client would receive.
      files.push(join(dir, `${type}.json`));
      await writeFile(files[i], JSON.stringify(body));
    }
    // The envelope extension is defined by a StructureDefinition shipped in this repository.
    const extension = join(process.cwd(), 'fhir/StructureDefinition-eir-envelope.json');
    for (const r of await validate(files, { ig: [extension] }))
      assert.equal(r.errors.length, 0, `${r.file}\n${describeErrors(r)}`);
  },
);
