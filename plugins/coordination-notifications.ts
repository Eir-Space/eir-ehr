import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assert, type Actor, type Plugin } from '../packages/contracts.ts';

export default {
  id: 'eir.coordination.notifications',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['coordinationNotifications'],
  requires: ['store', 'workforce', 'coordinationDirectory', 'notificationTransport'],
  setup(ctx, config) {
    const settings = z
      .object({
        worker: z.boolean().default(false),
        origin: z.url().default('http://127.0.0.1:4181'),
      })
      .strict()
      .parse(config);
    const origin = new URL(settings.origin);
    assert(
      !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash &&
        origin.pathname === '/' &&
        (origin.protocol === 'https:' ||
          (origin.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))),
      422,
      'Notification origin requires HTTPS or loopback, without credentials or path',
    );
    const store = ctx.get('store'),
      directory = ctx.get('coordinationDirectory'),
      transport = ctx.get('notificationTransport');
    assert(store.searchEntities, 503, 'Coordination notifications require bounded search');
    const eligible = async (tenant: string, row: import('../packages/contracts.ts').Entity) => {
      const record = await store.get(tenant, row.data.caseId),
        message = await store.get(tenant, row.data.messageId);
      const patient = record ? await store.get(tenant, record.data.sourcePatientId) : undefined;
      const party = (
        await store.searchEntities!(tenant, 'samParty', {
          equals: { caseId: row.data.caseId, unitId: row.data.unitId, active: true },
          limit: 1,
        })
      )[0];
      return !!(
        record &&
        party &&
        message?.data.status === 'sent' &&
        patient &&
        !patient.data.protectedIdentity &&
        !(await store.isBlocked(tenant, patient.id)) &&
        record.data.consent.granted &&
        record.data.consent.validUntil > new Date().toISOString() &&
        record.data.consent.unitIds.includes(row.data.unitId)
      );
    };
    const service = {
      async runOnce() {
        let delivered = 0;
        const tenants = new Set(ctx.get('workforce').units.map((u) => u.tenant));
        for (const tenant of tenants) {
          const rows = await store.searchEntities!(tenant, 'samNotification', {
            statuses: ['pending', 'sending'],
            dueBefore: new Date().toISOString(),
            limit: 50,
          });
          for (const row of rows) {
            const actor: Actor = {
              id: 'coordination-notifier',
              role: 'integration',
              tenant,
              unitId: row.data.unitId,
            };
            const claimed = await store.transaction(async () => {
              const current = await store.get(tenant, row.id);
              if (
                !current ||
                current.version !== row.version ||
                current.data.availableAt > new Date().toISOString()
              )
                return null;
              const route = directory.unit(tenant, row.data.unitId)?.notificationRecipient;
              if (
                !route ||
                route !== row.data.recipient ||
                (current.data.destination &&
                  (current.data.destination !== transport.destination ||
                    current.data.origin !== settings.origin)) ||
                !(await eligible(tenant, current))
              ) {
                await store.revise(
                  actor,
                  current,
                  current.version,
                  { ...current.data, status: 'cancelled' },
                  'coordination.notification-cancelled',
                );
                return null;
              }
              if (current.data.attempts >= 5) {
                await store.revise(
                  actor,
                  current,
                  current.version,
                  { ...current.data, status: 'failed' },
                  'coordination.notification-failed',
                );
                return null;
              }
              return store.revise(
                actor,
                current,
                current.version,
                {
                  ...current.data,
                  status: 'sending',
                  destination: transport.destination,
                  origin: settings.origin,
                  lease: randomUUID(),
                  attempts: current.data.attempts + 1,
                  availableAt: new Date(Date.now() + 60000).toISOString(),
                },
                'coordination.notification-claimed',
              );
            });
            if (!claimed) continue;
            let success = false;
            try {
              await transport.send({
                protocol: 'eir.notification.v1',
                messageId: row.id,
                recipient: row.data.recipient,
                text: 'Open Eir to review assigned work.',
                url: settings.origin,
              });
              success = true;
            } catch {
              /* No upstream response text or patient data is logged. */
            }
            await store.transaction(async () => {
              const latest = await store.get(tenant, row.id);
              if (!latest || latest.data.lease !== claimed.data.lease) return;
              await store.revise(
                actor,
                latest,
                latest.version,
                {
                  ...latest.data,
                  status: success ? 'delivered' : latest.data.attempts >= 5 ? 'failed' : 'pending',
                  availableAt: new Date(
                    Date.now() + 60000 * 2 ** latest.data.attempts,
                  ).toISOString(),
                  deliveredAt: success ? new Date().toISOString() : null,
                },
                'coordination.notification-result',
              );
            });
            if (success) delivered++;
          }
        }
        return { delivered };
      },
    };
    ctx.provide('coordinationNotifications', service);
    if (settings.worker) {
      let stopped = false,
        timer: ReturnType<typeof setTimeout>,
        pending: Promise<unknown> = Promise.resolve();
      const tick = () => {
        pending = service
          .runOnce()
          .catch(() => console.error('Coordination notification cycle failed'))
          .finally(() => {
            if (!stopped) timer = setTimeout(tick, 10000);
          });
      };
      timer = setTimeout(tick, 10000);
      ctx.onDispose(async () => {
        stopped = true;
        clearTimeout(timer);
        await pending;
      });
    }
  },
} satisfies Plugin;
