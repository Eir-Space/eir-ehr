import { assert, type Actor, type Plugin } from '../packages/contracts.ts';
import { medicationInput, medicationUpdate, reconciliationInput } from '../packages/medications.ts';

export default {
  id: 'eir.medications',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['medications'],
  requires: ['store', 'access'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access');
    const check = async (actor: Actor, patientId: string, write = false) => {
      assert(actor.role === 'clinician', 403, 'Clinician role required');
      await access.permit(actor, write ? 'medication.write' : 'chart.read', patientId);
    };
    const snapshot = async (actor: Actor, patientId: string) =>
      (await store.list(actor.tenant, patientId))
        .filter((r) => ['medication', 'allergy'].includes(r.kind))
        .map((r) => `${r.id}@${r.version}`)
        .sort();
    ctx.provide('medications', {
      async list(actor, patientId) {
        await check(actor, patientId);
        return await store.transaction(async () => {
          await check(actor, patientId);
          const current = await snapshot(actor, patientId);
          const review =
            (await store.list(actor.tenant, patientId, 'medicationReview')).sort(
              (a, b) => b.data.reviewNumber - a.data.reviewNumber,
            )[0] ?? null;
          return {
            items: await store.list(actor.tenant, patientId, 'medication'),
            snapshot: current,
            review,
            current: !!review && JSON.stringify(current) === JSON.stringify(review.data.snapshot),
          };
        });
      },
      async add(actor, patientId, input) {
        await check(actor, patientId, true);
        const parsed = medicationInput.parse(input);
        return await store.transaction(async () => {
          await check(actor, patientId, true);
          const previous = (await store.list(actor.tenant, patientId, 'medication')).find(
            (r) => r.data.clientId === parsed.clientId,
          );
          if (previous) {
            assert(
              previous.data.author === actor.id &&
                previous.data.originalInput === JSON.stringify(parsed),
              409,
              'Medication request already used',
            );
            return previous;
          }
          return await store.insert(actor, 'medication', patientId, {
            ...parsed,
            author: actor.id,
            originalInput: JSON.stringify(parsed),
          });
        });
      },
      async update(actor, id, version, input) {
        const row = await store.get(actor.tenant, id);
        assert(row?.kind === 'medication', 404, 'Medication not found');
        await check(actor, row.patientId, true);
        const parsed = medicationUpdate.parse(input);
        return await store.transaction(async () => {
          const row = await store.get(actor.tenant, id);
          assert(row?.kind === 'medication', 404, 'Medication not found');
          await check(actor, row.patientId, true);
          assert(row.version === version, 409, 'Medication changed. Reload before saving.');
          assert(
            row.data.status !== 'entered-in-error',
            409,
            'A voided statement cannot be restored; create a new statement',
          );
          return await store.revise(
            actor,
            row,
            version,
            {
              ...row.data,
              ...parsed,
              changedBy: actor.id,
            },
            'medication.update',
          );
        });
      },
      async reconcile(actor, patientId, input) {
        await access.permit(actor, 'medication.reconcile', patientId);
        const parsed = reconciliationInput.parse(input);
        parsed.snapshot.sort();
        return await store.transaction(async () => {
          await access.permit(actor, 'medication.reconcile', patientId);
          const previous = (await store.list(actor.tenant, patientId, 'medicationReview')).find(
            (r) => r.data.clientId === parsed.clientId,
          );
          if (previous) {
            assert(
              previous.data.author === actor.id &&
                previous.data.originalInput === JSON.stringify(parsed),
              409,
              'Review request already used',
            );
            return previous;
          }
          assert(
            JSON.stringify(parsed.snapshot) === JSON.stringify(await snapshot(actor, patientId)),
            409,
            'Medication or allergy list changed. Reload and reconcile again.',
          );
          const current = (await store.list(actor.tenant, patientId, 'medication')).filter((r) =>
            ['active', 'on-hold'].includes(r.data.status),
          );
          assert(
            parsed.noCurrentMedicines === (current.length === 0),
            422,
            'Explicitly confirm whether there are current medicines',
          );
          return await store.insert(actor, 'medicationReview', patientId, {
            ...parsed,
            author: actor.id,
            reviewedAt: new Date().toISOString(),
            originalInput: JSON.stringify(parsed),
            reviewNumber:
              1 +
              Math.max(
                0,
                ...(await store.list(actor.tenant, patientId, 'medicationReview')).map(
                  (r) => r.data.reviewNumber,
                ),
              ),
          });
        });
      },
    });
  },
} satisfies Plugin;
