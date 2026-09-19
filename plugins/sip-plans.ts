import { assert, type Plugin } from '../packages/contracts.ts';
import { sipSaveInput, sipActionInput } from '../packages/coordination.ts';
import { Temporal } from '@js-temporal/polyfill';

export default {
  id: 'eir.coordination.sip',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['sipPlans'],
  requires: ['store', 'coordination'],
  setup(ctx) {
    const store = ctx.get('store'),
      coordination = ctx.get('coordination');
    assert(store.searchEntities, 503, 'SIP requires bounded search');
    const find = async (tenant: string, caseId: string) =>
      (await store.searchEntities!(tenant, 'samSip', { equals: { caseId }, limit: 1 }))[0];
    ctx.provide('sipPlans', {
      async get(actor, caseId) {
        return store.transaction(async () => {
          await coordination.authorize(actor, caseId);
          await store.audit(actor, 'coordination.sip-read', undefined, caseId);
          return (await find(actor.tenant, caseId)) ?? null;
        });
      },
      async save(actor, caseId, input) {
        const parsed = sipSaveInput.parse(input);
        return store.transaction(async () => {
          const scope = await coordination.authorize(actor, caseId, true),
            previous = await find(actor.tenant, caseId);
          assert(
            (previous?.version ?? 0) === parsed.version,
            409,
            'SIP changed; reload before saving',
          );
          assert(
            !previous || previous.data.status === 'draft',
            409,
            'Reopen the SIP before editing',
          );
          const units = scope.parties.map((p) => p.data.unitId);
          const contributors = scope.parties
            .filter((p) => !p.data.readOnly)
            .map((p) => p.data.unitId);
          assert(
            parsed.fields.goals.every((g) => contributors.includes(g.responsibleUnitId)) &&
              parsed.fields.participants.every((p) => !p.unitId || units.includes(p.unitId)),
            422,
            'SIP responsibilities must belong to participating units',
          );
          assert(
            parsed.fields.followUpOn >=
              Temporal.Instant.from(parsed.fields.meetingAt)
                .toZonedDateTimeISO('Europe/Stockholm')
                .toPlainDate()
                .toString(),
            422,
            'Follow-up must not precede the meeting',
          );
          const data = {
            caseId,
            fields: parsed.fields,
            status: 'draft',
            confirmations: {},
            coordinatorUnitId:
              previous?.data.coordinatorUnitId ??
              (scope.record.data.pathway === 'inpatient'
                ? scope.record.data.contact?.unitId
                : actor.unitId),
            author: actor.id,
          };
          assert(
            data.coordinatorUnitId,
            409,
            'Set the fixed primary-care contact before creating an inpatient SIP',
          );
          const result = previous
            ? await store.revise(actor, previous, parsed.version, data, 'coordination.sip-edited')
            : await store.insert(actor, 'samSip', null, data);
          await coordination.event(actor, scope.record, 'sip.saved', parsed.reason);
          return result;
        });
      },
      async action(actor, caseId, input) {
        const parsed = sipActionInput.parse(input);
        return store.transaction(async () => {
          const scope = await coordination.authorize(actor, caseId, true),
            row = await find(actor.tenant, caseId);
          assert(row, 404, 'SIP not found');
          const data = { ...row.data };
          if (parsed.action === 'accept') {
            assert(data.status === 'invited', 409, 'SIP must be invited before confirmation');
            data.confirmations = {
              ...data.confirmations,
              [actor.unitId!]: { actorId: actor.id, at: new Date().toISOString() },
            };
          } else {
            assert(data.coordinatorUnitId === actor.unitId, 403, 'SIP coordinator required');
            if (parsed.action === 'invite') {
              assert(data.status === 'draft', 409, 'Only a draft can be invited');
              if (scope.record.data.pathway === 'inpatient')
                assert(
                  scope.unit.kind === 'primary-care' &&
                    scope.record.data.contact?.unitId === actor.unitId,
                  409,
                  'The fixed primary-care contact must call the inpatient SIP',
                );
              const recipients = scope.parties
                .filter((p) => p.data.unitId !== actor.unitId)
                .map((p) => p.data.unitId);
              await coordination.publish(
                actor,
                scope,
                {
                  type: 'sip-invitation',
                  body: `SIP: ${data.fields.meetingAt}\n${data.fields.location}`,
                  sipId: row.id,
                },
                recipients,
              );
              data.status = 'invited';
              data.confirmations = {};
              await store.revise(
                actor,
                scope.record,
                scope.record.version,
                { ...scope.record.data, invitedAt: new Date().toISOString() },
                'coordination.sip-invited',
              );
            }
            if (parsed.action === 'finalize') {
              assert(
                data.status === 'invited' &&
                  scope.parties
                    .filter((p) => !p.data.readOnly)
                    .every((p) => data.confirmations[p.data.unitId]),
                409,
                'Every contributing unit must confirm the current plan',
              );
              data.status = 'agreed';
              data.finalizedAt = new Date().toISOString();
            }
            if (parsed.action === 'reopen') {
              assert(['agreed', 'invited'].includes(data.status), 409, 'SIP cannot be reopened');
              data.status = 'draft';
              data.confirmations = {};
            }
            if (parsed.action === 'close') {
              assert(
                data.status === 'agreed' &&
                  data.fields.goals.every((g: any) => g.status === 'completed'),
                409,
                'Complete and confirm all goals before closing the SIP',
              );
              data.status = 'closed';
            }
          }
          const result = await store.revise(
            actor,
            row,
            parsed.version,
            data,
            'coordination.sip-' + parsed.action,
          );
          await coordination.event(actor, scope.record, 'sip.' + parsed.action, parsed.reason);
          return result;
        });
      },
    });
  },
} satisfies Plugin;
