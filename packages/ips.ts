import { randomUUID } from 'node:crypto';
import type { Entity } from './contracts.ts';
import { project } from '../plugins/fhir-r4.ts';

// International Patient Summary (HL7 FHIR IPS 2.0.0, R4) as a document Bundle, built from the legal
// ledger. This is the EHDS patient summary shape. Rules:
// - Only current information: active problems, allergies and medications. Corrected
//   (entered-in-error) records are never included.
// - Absence is never asserted. Eir records "unknown" for allergies unless told otherwise, so a section
//   with nothing to report says the information is unavailable, not that there is none.
// - Narrative is generated from the same data as the structured entries, so the two cannot disagree.
// The validity of the output is checked with the official HL7 validator (npm run fhir:validate).
const IPS = 'http://hl7.org/fhir/uv/ips/StructureDefinition';
const LOINC = 'http://loinc.org';
const XHTML = 'http://www.w3.org/1999/xhtml';

export type Custodian = {
  name: string;
  identifier?: { system: string; value: string };
};
type Resource = Record<string, any>;

const escape = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const div = (html: string, lang?: string) => ({
  status: 'generated',
  div: `<div xmlns="${XHTML}"${lang ? ` lang="${lang}" xml:lang="${lang}"` : ''}>${html}</div>`,
});
const list = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '';

function describe(e: Entity): string {
  const d = e.data;
  switch (e.kind) {
    case 'condition':
      return `${escape(d.code.display)} (${escape(d.code.code)})${d.onset ? `, debut ${escape(d.onset)}` : ''}`;
    case 'allergy':
      return `${escape(d.substance)}: ${escape(d.reaction)} (allvarlighetsgrad: ${escape(d.criticality)})`;
    case 'medication':
      return `${escape(d.name)}${d.dosageText ? `, ${escape(d.dosageText)}` : ''} (källa: ${escape(d.source)})`;
    case 'patient':
      return `${escape(d.name)}, född ${escape(d.birthDate)}`;
    default:
      return escape(e.kind);
  }
}

export function buildIps(input: {
  patient: Entity;
  entities: Entity[];
  custodian: Custodian;
  now?: Date;
  newId?: () => string;
}): Resource {
  const id = input.newId ?? randomUUID;
  const now = (input.now ?? new Date()).toISOString();
  const ref = (resource: Resource) => `urn:uuid:${resource.id}`;
  const current = (kind: string) =>
    input.entities.filter((e) => e.kind === kind && e.data.status === 'active');

  const org: Resource = {
    resourceType: 'Organization',
    id: id(),
    meta: { profile: [`${IPS}/Organization-uv-ips`] },
    ...(input.custodian.identifier ? { identifier: [input.custodian.identifier] } : {}),
    name: input.custodian.name,
  };
  org.text = div(escape(input.custodian.name));

  const wrap = (e: Entity, profile: string): Resource => {
    const r = project(e);
    if (!r) throw new Error(`No FHIR projection for ${e.kind}`);
    // The export's bookkeeping (source system, version) is not part of a patient summary.
    return {
      ...r,
      meta: { profile: [`${IPS}/${profile}`] },
      text: div(describe(e)),
      // IPS requires a time on every medication statement. Eir does not record when use started, so
      // the time is declared unknown instead of being invented.
      ...(e.kind === 'medication'
        ? {
            _effectiveDateTime: {
              extension: [
                {
                  url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
                  valueCode: 'unknown',
                },
              ],
            },
          }
        : {}),
    };
  };
  const patient = wrap(input.patient, 'Patient-uv-ips');
  const problems = current('condition').map((e) => wrap(e, 'Condition-uv-ips'));
  const allergies = current('allergy').map((e) => wrap(e, 'AllergyIntolerance-uv-ips'));
  const medications = current('medication').map((e) => wrap(e, 'MedicationStatement-uv-ips'));

  const section = (
    title: string,
    code: string,
    display: string,
    entities: Entity[],
    resources: Resource[],
    emptyText: string,
  ) => ({
    title,
    code: { coding: [{ system: LOINC, code, display }] },
    text: div(entities.length ? list(entities.map(describe)) : `<p>${escape(emptyText)}</p>`),
    ...(resources.length
      ? { entry: resources.map((r) => ({ reference: ref(r) })) }
      : {
          emptyReason: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason',
                code: 'unavailable',
              },
            ],
          },
        }),
  });

  const composition: Resource = {
    resourceType: 'Composition',
    id: id(),
    meta: { profile: [`${IPS}/Composition-uv-ips`] },
    language: 'sv',
    status: 'final',
    type: {
      coding: [{ system: LOINC, code: '60591-5', display: 'Patient summary Document' }],
    },
    subject: { reference: ref(patient) },
    date: now,
    author: [{ reference: ref(org) }],
    title: 'Patientsammanfattning (International Patient Summary)',
    custodian: { reference: ref(org) },
    text: div(
      `<p>Patientsammanfattning för ${describe(input.patient)}, sammanställd ${escape(now)} av ${escape(input.custodian.name)}.</p>`,
      'sv',
    ),
    section: [
      section(
        'Problem',
        '11450-4',
        'Problem list - Reported',
        current('condition'),
        problems,
        'Ingen information om problem är tillgänglig.',
      ),
      section(
        'Allergier och överkänslighet',
        '48765-2',
        'Allergies and adverse reactions Document',
        current('allergy'),
        allergies,
        'Ingen information om allergier är tillgänglig. Frånvaro av allergi är inte bekräftad.',
      ),
      section(
        'Läkemedel',
        '10160-0',
        'History of Medication use Narrative',
        current('medication'),
        medications,
        'Ingen information om läkemedelsanvändning är tillgänglig.',
      ),
    ],
  };

  const resources = [composition, patient, org, ...problems, ...allergies, ...medications];
  return {
    resourceType: 'Bundle',
    id: id(),
    meta: { profile: [`${IPS}/Bundle-uv-ips`] },
    identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${id()}` },
    type: 'document',
    timestamp: now,
    entry: resources.map((resource) => ({ fullUrl: ref(resource), resource })),
  };
}
