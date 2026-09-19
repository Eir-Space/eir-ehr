import { Temporal } from '@js-temporal/polyfill';
import type { z } from 'zod';
import { assert, type Actor, type Entity, type Store } from './contracts.ts';
import { labReportInput } from './laboratories.ts';

// Internal domain functions. Callers authorize the principal and hold a store transaction.
export async function applyLabReport(
  store: Store,
  actor: Actor,
  order: Entity,
  input: z.infer<typeof labReportInput>,
  sync: (order: Entity) => Promise<unknown>,
  provenance: Record<string, unknown> = {},
) {
  assert(order.data.status !== 'cancelled', 409, 'Order is cancelled');
  assert(
    !order.data.reportId || input.correctionReason,
    422,
    'A replacement report requires a correction reason',
  );
  assert(order.data.reportId || !input.correctionReason, 422, 'There is no report to correct');
  const report = await store.insert(actor, 'labReport', order.patientId, {
    ...input,
    orderId: order.id,
    encounterId: order.data.encounterId,
    author: actor.id,
    supersedes: order.data.reportId ?? null,
    receivedAt: new Date().toISOString(),
    status: order.data.reportId ? 'corrected' : 'final',
    originalInput: JSON.stringify(input),
    ...provenance,
  });
  const updated = await store.revise(
    actor,
    order,
    order.version,
    {
      ...order.data,
      status: 'received',
      reportId: report.id,
      reviewedReportId: null,
      critical: input.results.some((r) => r.flag === 'critical'),
    },
    'labOrder.result',
  );
  await sync(updated);
  return report;
}

export async function reopenLabTask(store: Store, actor: Actor, order: Entity, timeZone: string) {
  const row = (await store.list(actor.tenant, order.patientId, 'task')).find(
    (r) => r.data.linkedOrderId === order.id,
  );
  assert(row, 409, 'Order follow-up is missing');
  const today = Temporal.Now.plainDateISO(timeZone).toString();
  const data: Record<string, any> = {
    ...row.data,
    status: 'requested',
    title:
      `${order.data.critical ? 'Kritiskt provsvar' : 'Granska provsvar'}: ${order.data.test}`.slice(
        0,
        200,
      ),
    priority: order.data.critical ? 'urgent' : order.data.priority,
    due: row.data.due < today ? row.data.due : today,
    reportId: order.data.reportId,
    resultReceivedAt: new Date().toISOString(),
  };
  delete data.dueAt;
  delete data.followUp;
  delete data.completedAt;
  delete data.completedBy;
  delete data.resolution;
  return store.revise(actor, row, row.version, data, 'task.lab-result');
}
