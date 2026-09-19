import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Actor, Entity } from './contracts.ts';

export const policyInput = z
  .object({
    version: z.string().trim().min(1).max(100),
    timeZone: z.string().default('Europe/Stockholm'),
    reviewMinutes: z.number().int().min(1).max(43200),
    criticalReviewMinutes: z.number().int().min(1).max(1440),
    escalationMinutes: z.number().int().min(1).max(43200),
    reminderMinutes: z.number().int().min(1).max(43200),
    fallbackActorId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type FollowUpPolicyValue = z.infer<typeof policyInput>;
export interface FollowUpPolicy {
  resolve(tenant: string, unitId: string): FollowUpPolicyValue | undefined;
}
export const openTask = (task: Entity) => ['requested', 'in-progress'].includes(task.data.status);
export function endOfDay(day: string, zone: string) {
  return Temporal.PlainDate.from(day).add({ days: 1 }).toZonedDateTime(zone).toInstant().toString();
}
export function followUpState(
  task: Entity,
  order: Entity | undefined,
  policy: FollowUpPolicyValue,
) {
  const stage = !openTask(task)
    ? 'completed'
    : !order
      ? 'action-required'
      : order.data.status === 'requested'
        ? 'awaiting-result'
        : order.data.status === 'received'
          ? 'awaiting-review'
          : 'action-required';
  const critical = !!order?.data.critical && stage === 'awaiting-review';
  const deadlineAt =
    stage === 'awaiting-review'
      ? new Date(
          Date.parse(task.data.resultReceivedAt ?? order?.updatedAt ?? task.updatedAt) +
            (critical ? policy.criticalReviewMinutes : policy.reviewMinutes) * 60000,
        ).toISOString()
      : (task.data.dueAt ?? order?.data.expectedAt ?? endOfDay(task.data.due, policy.timeZone));
  const cycle = `${order?.data.reportId ?? task.id}:${stage}:${deadlineAt}:${policy.version}`;
  return { stage, cycle, critical, deadlineAt, policyVersion: policy.version };
}
export const coverageInput = z
  .object({
    coverId: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export const notificationMessage = z
  .object({
    protocol: z.literal('eir.notification.v1'),
    messageId: z.uuid(),
    recipient: z.string().min(1).max(200),
    text: z.literal('Open Eir to review assigned work.'),
    url: z.url(),
  })
  .strict();
export type NotificationMessage = z.infer<typeof notificationMessage>;
export interface NotificationTransport {
  destination: string;
  send(message: NotificationMessage): Promise<void>;
}
export interface FollowUp {
  list(actor: Actor, query: unknown): Promise<Record<string, any>>;
  coverage(actor: Actor, input: unknown): Promise<Entity>;
  cancelCoverage(actor: Actor, id: string, version: number, reason: string): Promise<Entity>;
  action(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
  replay(actor: Actor, id: string, version: number, reason: string): Promise<Entity>;
  runOnce(): Promise<{ scanned: number; delivered: number }>;
}
