import type { Entity, Plugin } from '../packages/contracts.ts';

const reference = (id: string) => ({ reference: `urn:uuid:${id}` });
const concept = (code: string) => ({
  coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code }],
});
export function project(e: Entity): Record<string, any> | null {
  const d = e.data;
  const common = {
    id: e.id,
    meta: { versionId: String(e.version), lastUpdated: e.updatedAt, source: 'urn:eir:ehr' },
  };
  const subject = reference(e.patientId);
  switch (e.kind) {
    case 'medication':
      return {
        ...common,
        resourceType: 'MedicationStatement',
        status: d.status,
        medicationCodeableConcept: { text: d.name },
        subject,
        dateAsserted: e.updatedAt,
        informationSource: d.source === 'patient' ? subject : { display: d.sourceDetail },
        ...(d.dosageText ? { dosage: [{ text: d.dosageText }] } : {}),
        ...(d.indication ? { reasonCode: [{ text: d.indication }] } : {}),
        note: [{ text: `${d.source}: ${d.sourceDetail}${d.reason ? '. ' + d.reason : ''}` }],
      };
    case 'labOrder':
      return {
        ...common,
        resourceType: 'ServiceRequest',
        status:
          d.status === 'cancelled' ? 'revoked' : d.status === 'reviewed' ? 'completed' : 'active',
        intent: 'order',
        priority: d.priority,
        code: { text: d.test },
        subject,
        encounter: reference(d.encounterId),
        authoredOn: e.createdAt,
        requester: { identifier: { system: 'urn:eir:actor', value: d.author } },
        reasonCode: [{ text: d.question }],
        note: [
          {
            text: `Provmaterial: ${d.specimen}. ${d.connectorId ? `Delivery managed by connector ${d.connectorId}; acknowledgement tracked separately.` : 'Local order; no external transmission recorded.'}`,
          },
        ],
      };
    case 'labReport':
      return {
        ...common,
        resourceType: 'DiagnosticReport',
        status: d.status,
        code: { text: 'Laboratoriesvar' },
        subject,
        encounter: reference(d.encounterId),
        basedOn: [reference(d.orderId)],
        effectiveDateTime: d.collectedAt,
        issued: d.reportedAt,
        identifier: [
          {
            system: `urn:eir:lab-source:${encodeURIComponent(e.tenant)}:${encodeURIComponent(d.source)}`,
            value: d.messageId,
          },
        ],
        performer: [{ display: d.source }],
        contained: d.results.map((r: any, i: number) => ({
          resourceType: 'Observation',
          id: `result-${i}`,
          status: d.status,
          code: { text: r.name },
          subject,
          effectiveDateTime: d.collectedAt,
          valueString: `${r.value}${r.unit ? ' ' + r.unit : ''}`,
          ...(r.reference ? { referenceRange: [{ text: r.reference }] } : {}),
          ...(r.flag !== 'unknown'
            ? {
                interpretation: [
                  {
                    coding: [
                      {
                        system:
                          'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                        code: (
                          { normal: 'N', high: 'H', low: 'L', critical: 'AA' } as Record<
                            string,
                            string
                          >
                        )[r.flag],
                      },
                    ],
                  },
                ],
              }
            : {}),
        })),
        result: d.results.map((_: unknown, i: number) => ({ reference: `#result-${i}` })),
        ...(d.correctionReason ? { conclusion: `Rättelse: ${d.correctionReason}` } : {}),
      };
    case 'patient':
      return {
        ...common,
        resourceType: 'Patient',
        identifier: [
          {
            system:
              d.identifier.system === 'urn:eir:identifier:local'
                ? `urn:eir:identifier:local:${encodeURIComponent(e.tenant)}`
                : d.identifier.system,
            value: d.identifier.value,
          },
        ],
        name: [{ text: d.name }],
        birthDate: d.birthDate,
      };
    case 'encounter':
      return {
        ...common,
        resourceType: 'Encounter',
        status: d.status,
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
        subject,
        period: { start: e.createdAt, ...(d.closedAt ? { end: d.closedAt } : {}) },
        reasonCode: [{ text: d.reason }],
      };
    case 'observation':
      return {
        ...common,
        resourceType: 'Observation',
        status: d.status,
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'vital-signs',
              },
            ],
          },
        ],
        code: { coding: [{ system: 'http://loinc.org', code: d.code, display: d.display }] },
        subject,
        encounter: reference(d.encounterId),
        effectiveDateTime: d.effectiveAt,
        valueQuantity: {
          value: d.value,
          unit: d.unit,
          system: 'http://unitsofmeasure.org',
          code: d.unit,
        },
      };
    case 'condition':
      return {
        ...common,
        resourceType: 'Condition',
        ...(d.status === 'entered-in-error'
          ? {
              verificationStatus: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
                    code: 'entered-in-error',
                  },
                ],
              },
            }
          : { clinicalStatus: concept(d.status) }),
        code: { coding: [d.code] },
        subject,
        ...(d.onset ? { onsetDateTime: d.onset } : {}),
      };
    case 'allergy':
      return {
        ...common,
        resourceType: 'AllergyIntolerance',
        ...(d.status === 'entered-in-error'
          ? {
              verificationStatus: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
                    code: 'entered-in-error',
                  },
                ],
              },
            }
          : {
              clinicalStatus: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
                    code: d.status,
                  },
                ],
              },
            }),
        code: { text: d.substance },
        patient: subject,
        criticality: d.criticality,
        reaction: [{ manifestation: [{ text: d.reaction }] }],
      };
    case 'note':
      return {
        ...common,
        resourceType: 'DocumentReference',
        status: 'current',
        docStatus: d.status === 'signed' ? (d.amends ? 'amended' : 'final') : 'preliminary',
        subject,
        date: e.updatedAt,
        author: [{ identifier: { system: 'urn:eir:actor', value: d.author } }],
        context: { encounter: [reference(d.encounterId)] },
        ...(d.amends ? { relatesTo: [{ code: 'appends', target: reference(d.amends) }] } : {}),
        content: [
          {
            attachment: {
              contentType: 'text/plain; charset=utf-8',
              data: Buffer.from(d.text).toString('base64'),
              title: d.amends ? 'Journal amendment' : 'Clinical note',
            },
          },
        ],
      };
    case 'task':
      return {
        ...common,
        resourceType: 'Task',
        status: d.status,
        intent: 'order',
        description: d.title,
        ...(d.assigneeId
          ? { owner: { identifier: { system: 'urn:eir:actor', value: d.assigneeId } } }
          : {}),
        priority: d.priority === 'urgent' ? 'urgent' : 'routine',
        for: subject,
        restriction: { period: { end: d.due } },
      };
    default:
      return null;
  }
}
export default {
  id: 'eir.fhir.r4-export',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['fhir'],
  requires: ['clinical', 'store', 'access'],
  setup(ctx) {
    const clinical = ctx.get('clinical'),
      store = ctx.get('store');
    ctx.provide('fhir', {
      async bundle(actor, patientId) {
        await ctx.get('access').permit(actor, 'chart.export', patientId);
        return await store.transaction(async () => {
          await ctx.get('access').permit(actor, 'chart.export', patientId);
          const entities = await clinical.chart(actor, patientId);
          // Superseded reports stay in the clinical history, not alongside current reports in an export.
          const currentReports = new Set(
            entities.filter((r) => r.kind === 'labOrder').map((r) => r.data.reportId),
          );
          const resources = entities
            .filter((r) => r.kind !== 'labReport' || currentReports.has(r.id))
            .map(project)
            .filter((r): r is Record<string, any> => r !== null);
          await store.audit(actor, 'fhir.export', patientId);
          return {
            resourceType: 'Bundle',
            type: 'collection',
            timestamp: new Date().toISOString(),
            entry: resources.map((resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource })),
          };
        });
      },
    });
  },
} satisfies Plugin;
