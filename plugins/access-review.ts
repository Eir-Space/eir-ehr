import { assert, type Plugin } from '../packages/contracts.ts';
import {
  reasonInput,
  auditQuery,
  auditReviewInput,
  protectionInput,
} from '../packages/workforce.ts';

export default {
  id: 'eir.access-review',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['accessReview'],
  requires: ['store', 'access', 'workforce'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access');
    ctx.provide('accessReview', {
      async list(actor, input) {
        await access.permit(actor, 'audit.review');
        const query = auditQuery.parse(input);
        const entries = await store.auditPage(actor.tenant, {
          ...query,
          unitId: actor.unitId!,
          limit: query.limit + 1,
        });
        const more = entries.length > query.limit;
        const page = entries.slice(0, query.limit);
        const reviews = await store.list(actor.tenant, undefined, 'accessReview');
        await store.audit(actor, 'audit.page-read');
        return {
          entries: page.map((entry) => ({
            ...entry,
            reviews: reviews.filter((r) => r.data.seq === entry.seq && r.data.hash === entry.hash),
          })),
          nextBefore: more ? page.at(-1)!.seq : null,
          verification: { ok: (await store.verifyAudit()).ok },
        };
      },
      async review(actor, input) {
        await access.permit(actor, 'audit.review');
        return store.transaction(async () => {
          await access.permit(actor, 'audit.review');
          const parsed = auditReviewInput.parse(input);
          const entry = await store.auditEntry(actor.tenant, parsed.seq);
          assert(
            entry &&
              entry.unitId === actor.unitId &&
              entry.hash === parsed.hash &&
              entry.actor !== actor.id,
            403,
            'Cannot review this event or your own access',
          );
          return store.insert(actor, 'accessReview', null, {
            ...parsed,
            reviewer: actor.id,
            unitId: actor.unitId,
          });
        });
      },
      async emergency(actor, patientId, input) {
        await access.permit(actor, 'access.emergency');
        await access.permit(actor, 'chart.read');
        return store.transaction(async () => {
          await access.permit(actor, 'access.emergency');
          await access.permit(actor, 'chart.read');
          const parsed = reasonInput.parse(input);
          const patient = await store.get(actor.tenant, patientId);
          assert(
            patient?.kind === 'patient' &&
              patient.data.careUnitId === actor.unitId &&
              !(await store.isBlocked(actor.tenant, patientId)),
            403,
            'Exceptional access is unavailable for this patient',
          );
          if (patient.data.protectedIdentity) await access.permit(actor, 'patient.protected');
          const grant = await store.insert(actor, 'emergencyAccess', patientId, {
            ...parsed,
            assignmentId: actor.assignmentId,
            expires: new Date(Date.now() + 15 * 60000).toISOString(),
          });
          await store.audit(actor, 'access.emergency-opened', patientId, grant.id);
          return grant;
        });
      },
      async protect(actor, patientId, version, input) {
        await access.permit(actor, 'access.manage', patientId);
        await access.permit(actor, 'patient.protected');
        return store.transaction(async () => {
          await access.permit(actor, 'access.manage', patientId);
          await access.permit(actor, 'patient.protected');
          const parsed = protectionInput.parse(input);
          const patient = (await store.get(actor.tenant, patientId))!;
          const updated = await store.revise(
            actor,
            patient,
            version,
            { ...patient.data, protectedIdentity: parsed.protected },
            'patient.protection-changed',
          );
          await store.insert(actor, 'protectionChange', patientId, parsed);
          return updated;
        });
      },
    });
  },
} satisfies Plugin;
