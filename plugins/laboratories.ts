import { assert, type Actor, type Plugin } from '../packages/contracts.ts';
import { applyLabReport } from '../packages/lab-application.ts';
import {
  labOrderInput,
  labReportInput,
  labReviewInput,
  labCancelInput,
} from '../packages/laboratories.ts';

export default {
  id: 'eir.laboratories',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['laboratories'],
  requires: ['store', 'access', 'careTeam'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      team = ctx.get('careTeam');
    const check = async (
      actor: Actor,
      patientId: string,
      action: 'lab.order' | 'lab.receive' | 'lab.review' = 'lab.order',
    ) => {
      assert(actor.role === 'clinician', 403, 'Clinician role required');
      await access.permit(actor, action, patientId);
    };
    const order = async (
      actor: Actor,
      id: string,
      action: 'lab.order' | 'lab.receive' | 'lab.review' = 'lab.order',
    ) => {
      const row = await store.get(actor.tenant, id);
      assert(row?.kind === 'labOrder', 404, 'Lab order not found');
      await check(actor, row.patientId, action);
      return row;
    };
    ctx.provide('laboratories', {
      async order(actor, patientId, input) {
        await check(actor, patientId);
        const parsed = labOrderInput.parse(input);
        return await store.transaction(async () => {
          await check(actor, patientId);
          const previous = (await store.list(actor.tenant, patientId, 'labOrder')).find(
            (r) => r.data.clientId === parsed.clientId,
          );
          if (previous) {
            assert(
              previous.data.author === actor.id &&
                previous.data.originalInput === JSON.stringify(parsed),
              409,
              'Order request already used',
            );
            return previous;
          }
          const encounter = await store.get(actor.tenant, parsed.encounterId);
          assert(
            encounter?.kind === 'encounter' &&
              encounter.patientId === patientId &&
              encounter.data.status === 'in-progress',
            409,
            'An open encounter for this patient is required',
          );
          const row = await store.insert(actor, 'labOrder', patientId, {
            ...parsed,
            status: 'requested',
            author: actor.id,
            originalInput: JSON.stringify(parsed),
          });
          await team.createLinkedTask(
            actor,
            patientId,
            {
              title: `Inväntar provsvar: ${parsed.test}`.slice(0, 200),
              assigneeId: parsed.assigneeId,
              due: parsed.due,
              priority: parsed.priority,
            },
            row.id,
          );
          return row;
        });
      },
      async receive(actor, id, version, input) {
        await order(actor, id, 'lab.receive');
        const parsed = labReportInput.parse(input);
        assert(
          Date.parse(parsed.collectedAt) <= Date.parse(parsed.reportedAt) &&
            Date.parse(parsed.reportedAt) <= Date.now(),
          422,
          'Collection must precede reporting; neither time may be in the future',
        );
        return await store.transaction(async () => {
          const row = await order(actor, id, 'lab.receive');
          const previous = (await store.list(actor.tenant, undefined, 'labReport')).find(
            (r) => r.data.source === parsed.source && r.data.messageId === parsed.messageId,
          );
          if (previous) {
            assert(
              previous.patientId === row.patientId &&
                previous.data.orderId === id &&
                previous.data.originalInput === JSON.stringify(parsed),
              409,
              'Source message ID has already been used with different content',
            );
            return previous;
          }
          assert(row.version === version, 409, 'Order changed. Reload before recording a result.');
          assert(
            !row.data.connectorId,
            409,
            'Connected orders receive results through their connector',
          );
          return applyLabReport(store, actor, row, parsed, (updated) =>
            team.syncLinkedTask(actor, updated, 'result'),
          );
        });
      },
      async review(actor, id, version, input) {
        await order(actor, id, 'lab.review');
        const parsed = labReviewInput.parse(input);
        return await store.transaction(async () => {
          const row = await order(actor, id, 'lab.review');
          assert(
            row.version === version &&
              row.data.status === 'received' &&
              row.data.reportId === parsed.reportId,
            409,
            'The report changed or was already reviewed. Reload before reviewing.',
          );
          const task = (await store.list(actor.tenant, row.patientId, 'task')).find(
            (r) => r.data.linkedOrderId === id,
          );
          assert(
            task && task.version === parsed.taskVersion,
            409,
            'Follow-up responsibility changed. Reload before reviewing.',
          );
          assert(
            task.data.assigneeId === actor.id,
            403,
            'Only the assigned reviewer may acknowledge this report',
          );
          assert(
            !row.data.critical || parsed.criticalAcknowledged,
            422,
            'Explicit acknowledgement of a critical report is required',
          );
          const review = await store.insert(actor, 'labReview', row.patientId, {
            ...parsed,
            orderId: id,
            author: actor.id,
            reviewedAt: new Date().toISOString(),
          });
          const updated = await store.revise(
            actor,
            row,
            version,
            {
              ...row.data,
              status: 'reviewed',
              reviewedReportId: parsed.reportId,
              reviewId: review.id,
            },
            'labOrder.review',
          );
          await team.syncLinkedTask(actor, updated, 'review', parsed.action);
          return review;
        });
      },
      async cancel(actor, id, version, input) {
        await order(actor, id);
        const parsed = labCancelInput.parse(input);
        return await store.transaction(async () => {
          const row = await order(actor, id);
          assert(row.version === version, 409, 'Order changed. Reload before cancelling.');
          assert(
            !row.data.connectorId,
            409,
            'Connected orders require confirmed cancellation with the laboratory',
          );
          assert(
            row.data.status === 'requested',
            409,
            'A received report must be reviewed, not cancelled',
          );
          const updated = await store.revise(
            actor,
            row,
            version,
            { ...row.data, status: 'cancelled', cancelReason: parsed.reason },
            'labOrder.cancel',
          );
          await team.syncLinkedTask(actor, updated, 'cancel', parsed.reason);
          return updated;
        });
      },
    });
  },
} satisfies Plugin;
