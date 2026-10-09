import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';
import { buildIps } from '../packages/ips.ts';

// International Patient Summary export (the EHDS patient-summary document), built from the ledger
// behind the same authorization and audit as the FHIR export. The custodian is the organisation
// responsible for the record; it is required configuration, never defaulted, because a summary
// must not name an organisation the operator did not choose.
const options = z
  .object({
    custodian: z
      .object({
        name: z.string().trim().min(1).max(200),
        identifier: z
          .object({ system: z.url(), value: z.string().min(1).max(100) })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export default {
  id: 'eir.fhir.ips',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['fhirIps'],
  requires: ['clinical', 'store', 'access'],
  setup(ctx, config) {
    const { custodian } = options.parse(config);
    const clinical = ctx.get('clinical'),
      store = ctx.get('store'),
      access = ctx.get('access');
    ctx.provide('fhirIps', {
      async document(actor, patientId) {
        await access.permit(actor, 'chart.export', patientId);
        const entities = await clinical.chart(actor, patientId);
        return await store.transaction(async () => {
          await access.permit(actor, 'chart.export', patientId);
          const patient = entities.find((e) => e.kind === 'patient');
          assert(patient, 404, 'Patient not found');
          await store.audit(actor, 'fhir.ips', patientId);
          return buildIps({ patient, entities, custodian });
        });
      },
    });
  },
} satisfies Plugin;
