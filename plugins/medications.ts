import { assert, type Actor, type Plugin } from '../packages/contracts.ts';
import { medicationInput, medicationUpdate, reconciliationInput } from '../packages/medications.ts';

export default {
  id: 'eir.medications',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['medications'],
  requires: ['store', 'access'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access');
    const check = (actor: Actor, patientId: string, write = false) => {
      assert(actor.role === 'clinician', 403, 'Clinician role required');
      access.permit(actor, write ? 'medication.write' : 'chart.read', patientId);
    };
    const snapshot = (actor: Actor, patientId: string) =>
      store
        .list(actor.tenant, patientId)
        .filter((r) => ['medication', 'allergy'].includes(r.kind))
        .map((r) => `${r.id}@${r.version}`)
        .sort();
    ctx.provide('medications', {
      list(actor, patientId) {
        check(actor, patientId);
        const current = snapshot(actor, patientId);
        const review =
          store
            .list(actor.tenant, patientId, 'medicationReview')
            .sort((a, b) => b.data.reviewNumber - a.data.reviewNumber)[0] ?? null;
        return {
          items: store.list(actor.tenant, patientId, 'medication'),
          snapshot: current,
          review,
          current: !!review && JSON.stringify(current) === JSON.stringify(review.data.snapshot),
        };
      },
      add(actor, patientId, input) {
        check(actor, patientId, true);
        const parsed = medicationInput.parse(input);
        return store.transaction(() => {
          const previous = store
            .list(actor.tenant, patientId, 'medication')
            .find((r) => r.data.clientId === parsed.clientId);
          if (previous) {
            assert(
              previous.data.author === actor.id &&
                previous.data.originalInput === JSON.stringify(parsed),
              409,
              'Medication request already used',
            );
            return previous;
          }
          return store.insert(actor, 'medication', patientId, {
            ...parsed,
            author: actor.id,
            originalInput: JSON.stringify(parsed),
          });
        });
      },
      update(actor, id, version, input) {
        const row = store.get(actor.tenant, id);
        assert(row?.kind === 'medication', 404, 'Medication not found');
        check(actor, row.patientId, true);
        const parsed = medicationUpdate.parse(input);
        assert(row.version === version, 409, 'Medication changed. Reload before saving.');
        assert(
          row.data.status !== 'entered-in-error',
          409,
          'A voided statement cannot be restored; create a new statement',
        );
        return store.transaction(() =>
          store.revise(
            actor,
            row,
            version,
            {
              ...row.data,
              ...parsed,
              changedBy: actor.id,
            },
            'medication.update',
          ),
        );
      },
      reconcile(actor, patientId, input) {
        access.permit(actor, 'medication.reconcile', patientId);
        const parsed = reconciliationInput.parse(input);
        parsed.snapshot.sort();
        return store.transaction(() => {
          const previous = store
            .list(actor.tenant, patientId, 'medicationReview')
            .find((r) => r.data.clientId === parsed.clientId);
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
            JSON.stringify(parsed.snapshot) === JSON.stringify(snapshot(actor, patientId)),
            409,
            'Medication or allergy list changed. Reload and reconcile again.',
          );
          const current = store
            .list(actor.tenant, patientId, 'medication')
            .filter((r) => ['active', 'on-hold'].includes(r.data.status));
          assert(
            parsed.noCurrentMedicines === (current.length === 0),
            422,
            'Explicitly confirm whether there are current medicines',
          );
          return store.insert(actor, 'medicationReview', patientId, {
            ...parsed,
            author: actor.id,
            reviewedAt: new Date().toISOString(),
            originalInput: JSON.stringify(parsed),
            reviewNumber:
              1 +
              Math.max(
                0,
                ...store
                  .list(actor.tenant, patientId, 'medicationReview')
                  .map((r) => r.data.reviewNumber),
              ),
          });
        });
      },
    });
  },
} satisfies Plugin;
