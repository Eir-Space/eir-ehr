import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert, type Actor, type Entity, type Plugin } from '../packages/contracts.ts';
import { entityQuery, type EntityQuery } from '../packages/entity-query.ts';
import { applyLabReport, reopenLabTask } from '../packages/lab-application.ts';
import { activeAssignment } from '../packages/workforce.ts';
import {
  canonical,
  connectedOrderInput,
  connectorConfig,
  operationQuery,
  operatorAction,
  orderAcknowledgement,
  payloadHash,
  protocol,
  resultMessage,
  type IntegrationRow,
  type Integrations,
  type LabConnector,
  type OrderMessage,
  type ResultMessage,
} from '../packages/integrations.ts';
import { connectorSecret, matchesSecret } from '../packages/integration-auth.ts';

const settingsSchema = z
  .object({
    connectors: z.array(connectorConfig).max(50).default([]),
    worker: z.boolean().default(false),
    pollMs: z.number().int().min(100).max(60000).default(1000),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    leaseMs: z.number().int().min(500).max(300000).default(30000),
    retryMs: z.number().int().min(10).max(3600000).default(5000),
    maxAttempts: z.number().int().min(1).max(20).default(6),
  })
  .strict()
  .refine((s) => s.leaseMs > s.timeoutMs + 100, 'Lease must outlive the transport deadline');
const connectionChange = operatorAction.extend({ enabled: z.boolean() });
const queueKinds = ['integrationOutbox', 'integrationInbox'] as const;
type QueueKind = (typeof queueKinds)[number];
const now = () => new Date().toISOString();
const machine = (c: LabConnector): Actor => ({
  id: `connector:${c.id}`,
  role: 'integration',
  tenant: c.tenant,
  unitId: c.unitId,
});
const summary = (r: Entity): IntegrationRow => ({
  id: r.id,
  version: r.version,
  createdAt: r.createdAt,
  connectorId: r.data.connectorId,
  state: r.data.state,
  messageId: r.data.messageId,
  orderId: r.data.orderId,
  attempts: r.data.attempts,
  availableAt: r.data.availableAt,
  code: r.data.code ?? null,
});

export default {
  id: 'eir.integrations',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['integrations'],
  requires: ['store', 'access', 'workforce', 'laboratories', 'careTeam', 'labTransport'],
  async setup(ctx, config) {
    const settings = settingsSchema.parse(config),
      store = ctx.get('store'),
      access = ctx.get('access'),
      workforce = ctx.get('workforce'),
      labs = ctx.get('laboratories'),
      team = ctx.get('careTeam'),
      transport = ctx.get('labTransport');
    assert(
      store.searchEntities,
      503,
      'Integration storage requires the bounded searchEntities capability',
    );
    const search = (tenant: string, kind: string, q: EntityQuery) =>
      store.searchEntities!(tenant, kind, q);
    const configured = new Map<string, LabConnector>();
    const connection = async (c: LabConnector) => {
      const [row] = await search(c.tenant, 'integrationConnection', {
        equals: { connectorId: c.id },
        limit: 1,
      });
      assert(row, 503, 'Connector has not been provisioned');
      return row;
    };
    const credentialHashes = new Set<string>();
    for (const c of settings.connectors) {
      for (const name of [c.inboundTokenEnv, c.outboundTokenEnv]) {
        const hash = payloadHash(connectorSecret(name));
        assert(
          !credentialHashes.has(hash),
          422,
          'Connector credentials must be unique per direction and scope',
        );
        credentialHashes.add(hash);
      }
      assert(!configured.has(c.id), 422, 'Connector identifiers must be unique');
      assert(
        workforce.units.some((u) => u.id === c.unitId && u.tenant === c.tenant),
        422,
        'Connector care unit is not configured',
      );
      assert(transport.protocol === c.adapter, 422, 'Incompatible laboratory transport');
      transport.validate(c);
      configured.set(c.id, c);
      const fingerprint = payloadHash({
        id: c.id,
        tenant: c.tenant,
        unitId: c.unitId,
        adapter: c.adapter,
        endpoint: c.endpoint,
      });
      await store.transaction(async () => {
        const [existing] = await search(c.tenant, 'integrationConnection', {
          equals: { connectorId: c.id },
          limit: 1,
        });
        if (existing)
          assert(
            existing.data.fingerprint === fingerprint,
            409,
            'Connector destination or scope changed; provision a new connector ID',
          );
        else
          await store.insert(machine(c), 'integrationConnection', null, {
            connectorId: c.id,
            unitId: c.unitId,
            enabled: true,
            fingerprint,
          });
      });
    }
    const getConfig = (id: string) => {
      const c = configured.get(id);
      assert(c, 404, 'Connector is unavailable');
      return c;
    };
    const authenticate = async (id: string, authorization: string) => {
      const c = configured.get(id);
      assert(
        c && matchesSecret(authorization, connectorSecret(c.inboundTokenEnv)),
        401,
        'Connector authentication required',
      );
      assert((await connection(c)).data.enabled, 403, 'Connector is disabled');
      return c;
    };
    const active = async (c: LabConnector) =>
      assert((await connection(c)).data.enabled, 409, 'Connector is disabled');
    const manage = async (actor: Actor) => {
      assert(actor.role === 'administrator', 403, 'Integration administrator required');
      await access.permit(actor, 'integration.manage');
    };
    const managed = async (actor: Actor, id: string) => {
      await manage(actor);
      const row = await store.get(actor.tenant, id);
      assert(
        row &&
          [...queueKinds, 'integrationConnection'].includes(row.kind) &&
          row.data.unitId === actor.unitId,
        404,
        'Integration record not found',
      );
      const c = getConfig(row.data.connectorId);
      assert(
        c.tenant === actor.tenant && c.unitId === actor.unitId,
        404,
        'Integration record not found',
      );
      return { row, c };
    };
    const findMessage = (c: LabConnector, kind: QueueKind, messageId: string) =>
      search(c.tenant, kind, { equals: { connectorId: c.id, messageId }, limit: 1 });
    const queueData = (c: LabConnector, message: OrderMessage | ResultMessage) => ({
      connectorId: c.id,
      unitId: c.unitId,
      messageId: message.messageId,
      orderId: message.orderId,
      payload: message,
      payloadHash: payloadHash(message),
      state: 'pending',
      attempts: 0,
      cycleAttempts: 0,
      availableAt: now(),
      lease: null,
      code: null,
    });
    const reviseQueue = (
      c: LabConnector,
      row: Entity,
      data: Record<string, unknown>,
      action: string,
    ) => store.revise(machine(c), row, row.version, { ...row.data, ...data }, action);
    const retryData = (row: Entity, code: string, quarantine = false) => {
      const exhausted = row.data.cycleAttempts >= settings.maxAttempts;
      return {
        state: quarantine || exhausted ? 'quarantined' : 'retry',
        code,
        lease: null,
        availableAt: new Date(
          Date.now() +
            Math.min(3600000, settings.retryMs * 2 ** Math.min(row.data.cycleAttempts - 1, 10)) +
            Math.floor(Math.random() * settings.retryMs),
        ).toISOString(),
      };
    };
    const claim = async (c: LabConnector, kind: QueueKind) =>
      store.transaction(async () => {
        if (!(await connection(c)).data.enabled) return;
        // Expired leases are eligible too; every attempt retains the immutable message identity.
        for (const state of ['sending', 'retry', 'pending']) {
          const [row] = await search(c.tenant, kind, {
            equals: { connectorId: c.id, state },
            dueBefore: now(),
            limit: 1,
          });
          if (!row) continue;
          if (row.data.cycleAttempts >= settings.maxAttempts) {
            await reviseQueue(
              c,
              row,
              { state: 'quarantined', code: 'attempts_exhausted', lease: null },
              'integration.exhausted',
            );
            continue;
          }
          return reviseQueue(
            c,
            row,
            {
              state: 'sending',
              attempts: row.data.attempts + 1,
              cycleAttempts: row.data.cycleAttempts + 1,
              lease: randomUUID(),
              availableAt: new Date(Date.now() + settings.leaseMs).toISOString(),
            },
            'integration.claimed',
          );
        }
      });
    const leased = async (c: LabConnector, claim: Entity) => {
      const row = await store.get(c.tenant, claim.id);
      return row?.data.state === 'sending' && row.data.lease === claim.data.lease ? row : undefined;
    };
    const finish = async (
      c: LabConnector,
      claimed: Entity,
      data: Record<string, unknown>,
      action: string,
    ) =>
      store.transaction(async () => {
        const row = await leased(c, claimed);
        if (row) await reviseQueue(c, row, { ...data, lease: null }, action);
      });
    const patientProblem = async (c: LabConnector, patientId: string) => {
      const patient = await store.get(c.tenant, patientId);
      if (patient?.kind !== 'patient' || patient.data.careUnitId !== c.unitId)
        return 'patient_scope_mismatch';
      if (patient.data.protectedIdentity || (await store.isBlocked(c.tenant, patientId)))
        return 'patient_restricted';
      return null;
    };
    const send = async (c: LabConnector, claimed: Entity, signal: AbortSignal) => {
      const problem = await store.transaction(async () => {
        const row = await leased(c, claimed);
        if (!row) return 'lease_lost';
        if (!(await connection(c)).data.enabled) return 'connector_disabled';
        return patientProblem(c, row.patientId);
      });
      if (problem) {
        await finish(
          c,
          claimed,
          retryData(claimed, problem, true),
          'integration.delivery-quarantined',
        );
        return;
      }
      const outcome = await transport.send(c, claimed.data.payload as OrderMessage, signal);
      if (outcome.kind === 'acknowledged') {
        const ack = orderAcknowledgement.safeParse(outcome.acknowledgement);
        if (
          !ack.success ||
          ack.data.messageId !== claimed.data.messageId ||
          ack.data.orderId !== claimed.data.orderId ||
          ack.data.patientId !== claimed.patientId ||
          ack.data.payloadHash !== claimed.data.payloadHash
        ) {
          await finish(
            c,
            claimed,
            retryData(claimed, 'invalid_acknowledgement', true),
            'integration.delivery-quarantined',
          );
          return;
        }
        await finish(
          c,
          claimed,
          {
            state: ack.data.status === 'accepted' ? 'acknowledged' : 'rejected',
            acknowledgement: ack.data,
            acknowledgedAt: now(),
            code: ack.data.reasonCode ?? null,
          },
          'integration.delivery-acknowledged',
        );
      } else
        await finish(
          c,
          claimed,
          retryData(claimed, outcome.code, outcome.kind === 'quarantine'),
          'integration.delivery-failed',
        );
    };
    const apply = async (c: LabConnector, claimed: Entity) => {
      try {
        return await store.transaction(async () => {
          const row = await leased(c, claimed);
          if (!row) return false;
          const message = resultMessage.parse(row.data.payload);
          const hold = async (code: string, deferred = false) => {
            await reviseQueue(
              c,
              row,
              retryData(row, code, !deferred),
              'integration.result-quarantined',
            );
            return false;
          };
          if (!(await connection(c)).data.enabled) return hold('connector_disabled');
          const problem = await patientProblem(c, message.patientId);
          if (problem) return hold(problem);
          const [outgoing] = await findMessage(c, 'integrationOutbox', message.orderMessageId);
          const order = await store.get(c.tenant, message.orderId);
          if (
            !outgoing ||
            outgoing.data.orderId !== message.orderId ||
            outgoing.patientId !== message.patientId ||
            order?.kind !== 'labOrder' ||
            order.patientId !== message.patientId ||
            order.data.connectorId !== c.id
          )
            return hold('order_patient_mismatch');
          if (
            canonical(outgoing.data.payload.patient.identifier) !==
            canonical(message.patientIdentifier)
          )
            return hold('identifier_mismatch');
          const patient = await store.get(c.tenant, message.patientId);
          if (
            patient!.data.identifier.system !== message.patientIdentifier.system ||
            patient!.data.identifier.value !== message.patientIdentifier.value
          )
            return hold('identifier_changed');
          if (outgoing.data.state !== 'acknowledged')
            return hold('order_not_acknowledged', outgoing.data.state !== 'rejected');
          if (order.data.status === 'cancelled') return hold('order_cancelled');
          if (
            Date.parse(message.report.collectedAt) > Date.parse(message.report.reportedAt) ||
            Date.parse(message.report.reportedAt) > Date.now()
          )
            return hold('invalid_report_times');
          if (message.supersedesMessageId) {
            const [predecessor] = await findMessage(
              c,
              'integrationInbox',
              message.supersedesMessageId,
            );
            if (!predecessor || predecessor.data.state !== 'applied')
              return hold('predecessor_pending', true);
            if (
              predecessor.data.orderId !== order.id ||
              predecessor.data.payload.patientId !== order.patientId ||
              predecessor.data.reportId !== order.data.reportId
            )
              return hold('correction_conflict');
            if (!message.report.correctionReason) return hold('correction_reason_required');
          } else if (order.data.reportId || message.report.correctionReason)
            return hold('correction_predecessor_required');
          const task = (await store.list(c.tenant, order.patientId, 'task')).find(
            (r) => r.data.linkedOrderId === order.id,
          );
          if (!task) return hold('review_owner_missing');
          const owners = await search(c.tenant, 'staffAssignment', {
            equals: { actorId: task.data.assigneeId, unitId: c.unitId, enabled: true },
            limit: 100,
          });
          const availableOwners = owners.filter(
            (r) =>
              activeAssignment(r) &&
              r.data.role === 'clinician' &&
              r.data.permissions.includes('lab.review'),
          );
          if (!availableOwners.length) return hold('review_owner_inactive');
          const grant = await store.getGrant(c.tenant, order.patientId, task.data.assigneeId);
          const relationships = await store.list(c.tenant, order.patientId, 'careRelationship');
          if (
            grant?.role !== 'clinician' ||
            grant.expires <= now() ||
            !relationships.some(
              (r) =>
                r.data.target === task.data.assigneeId &&
                r.data.expires > now() &&
                availableOwners.some((a) => a.id === r.data.assignmentId),
            )
          )
            return hold('review_owner_access_expired');
          const actor = machine(c);
          const report = await applyLabReport(
            store,
            actor,
            order,
            { ...message.report, source: `connector:${c.id}`, messageId: message.messageId },
            (updated) => reopenLabTask(store, actor, updated, team.timeZone),
            {
              connectorId: c.id,
              inboxId: row.id,
              payloadHash: row.data.payloadHash,
              supersedesMessageId: message.supersedesMessageId,
            },
          );
          await reviseQueue(
            c,
            row,
            { state: 'applied', reportId: report.id, appliedAt: now(), code: null, lease: null },
            'integration.result-applied',
          );
          return true;
        });
      } catch {
        // A failed clinical/audit write rolls back before its durable retry is recorded.
        await finish(
          c,
          claimed,
          retryData(claimed, 'result_application_failed'),
          'integration.result-failed',
        );
        return false;
      }
    };
    const service: Integrations = {
      async delivery(actor, orderId) {
        return store.transaction(async () => {
          const order = await store.get(actor.tenant, orderId);
          assert(order?.kind === 'labOrder', 404, 'Order not found');
          await access.permit(actor, 'chart.read', order.patientId);
          assert(actor.role === 'clinician' && order.data.outboxId, 404, 'Delivery not found');
          const row = await store.get(actor.tenant, order.data.outboxId);
          assert(
            row?.kind === 'integrationOutbox' && row.patientId === order.patientId,
            404,
            'Delivery not found',
          );
          return summary(row);
        });
      },
      async connectors(actor) {
        assert(actor.role === 'clinician', 403, 'Clinician required');
        await access.permit(actor, 'lab.order');
        const rows = [];
        for (const c of configured.values())
          if (
            c.tenant === actor.tenant &&
            c.unitId === actor.unitId &&
            (await connection(c)).data.enabled
          )
            rows.push({ id: c.id, name: c.name });
        return rows;
      },
      async order(actor, patientId, input) {
        const { connectorId, ...parsed } = connectedOrderInput.parse(input),
          c = getConfig(connectorId);
        return store.transaction(async () => {
          await access.permit(actor, 'lab.order', patientId);
          assert(
            actor.role === 'clinician' && actor.tenant === c.tenant && actor.unitId === c.unitId,
            403,
            'Connector scope does not match clinical assignment',
          );
          await active(c);
          assert(
            !(await patientProblem(c, patientId)),
            403,
            'Patient cannot be sent through this connector',
          );
          const order = await labs.order(actor, patientId, parsed);
          const [prior] = await findMessage(c, 'integrationOutbox', order.id);
          if (prior) {
            assert(order.data.connectorId === c.id, 409, 'Order connector changed');
            return order;
          }
          assert(
            !order.data.connectorId && order.version === 1 && order.data.status === 'requested',
            409,
            'Order cannot be routed to another connector',
          );
          const patient = (await store.get(actor.tenant, patientId))!;
          const message: OrderMessage = {
            protocol,
            type: 'lab.order',
            connectorId: c.id,
            messageId: order.id,
            orderId: order.id,
            patientId,
            patient: {
              name: patient.data.name,
              birthDate: patient.data.birthDate,
              identifier: {
                system: patient.data.identifier.system,
                value: patient.data.identifier.value,
              },
            },
            order: {
              test: order.data.test,
              question: order.data.question,
              specimen: order.data.specimen,
              priority: order.data.priority,
              orderedAt: order.createdAt,
              requester: { id: actor.id, unitId: c.unitId },
            },
          };
          const outgoing = await store.insert(
            actor,
            'integrationOutbox',
            patientId,
            queueData(c, message),
          );
          return store.revise(
            actor,
            order,
            order.version,
            { ...order.data, connectorId: c.id, outboxId: outgoing.id },
            'labOrder.dispatched',
          );
        });
      },
      async receive(id, authorization, input) {
        await authenticate(id, authorization);
        const message = resultMessage.parse(input);
        return store
          .transaction(async () => {
            const c = await authenticate(id, authorization);
            const [previous] = await findMessage(c, 'integrationInbox', message.messageId);
            if (previous) {
              if (previous.data.payloadHash !== payloadHash(message)) {
                await store.audit(
                  machine(c),
                  'integration.message-id-collision',
                  undefined,
                  previous.id,
                  'denied',
                );
                return { collision: true as const };
              }
              return {
                receiptId: previous.id,
                messageId: message.messageId,
                status: 'received' as const,
                payloadHash: previous.data.payloadHash as string,
              };
            }
            // It is not yet a clinical record. Unmatched identifiers stay in the restricted inbox.
            const row = await store.insert(
              machine(c),
              'integrationInbox',
              null,
              queueData(c, message),
            );
            return {
              receiptId: row.id,
              messageId: message.messageId,
              status: 'received' as const,
              payloadHash: row.data.payloadHash as string,
            };
          })
          .then((receipt) => {
            assert(
              !('collision' in receipt),
              409,
              'Message ID already exists with different content',
            );
            return receipt;
          });
      },
      async receipt(id, authorization, messageId) {
        const c = await authenticate(id, authorization);
        const [row] = await findMessage(c, 'integrationInbox', z.uuid().parse(messageId));
        assert(row, 404, 'Receipt not found');
        return { messageId, state: row.data.state, code: row.data.code ?? null };
      },
      async operations(actor, input) {
        return store.transaction(async () => {
          await manage(actor);
          const q = operationQuery.parse(input);
          let after: EntityQuery['after'];
          if (q.after) {
            let decoded: unknown;
            try {
              decoded = JSON.parse(Buffer.from(q.after, 'base64url').toString());
            } catch {
              assert(false, 422, 'Invalid cursor');
            }
            after = entityQuery.shape.after.parse(decoded);
          }
          const connectors = [];
          for (const c of configured.values())
            if (c.tenant === actor.tenant && c.unitId === actor.unitId) {
              const row = await connection(c);
              connectors.push({
                id: c.id,
                name: c.name,
                recordId: row.id,
                version: row.version,
                enabled: !!row.data.enabled,
              });
            }
          const rows = await search(
            actor.tenant,
            q.direction === 'outbox' ? 'integrationOutbox' : 'integrationInbox',
            {
              equals: {
                unitId: actor.unitId!,
                ...(q.connectorId ? { connectorId: q.connectorId } : {}),
                ...(q.state ? { state: q.state } : {}),
              },
              after,
              limit: q.limit,
            },
          );
          await store.audit(actor, 'integration.operations-read');
          const last = rows.at(-1);
          return {
            connectors,
            items: rows.map(summary),
            nextCursor:
              rows.length === q.limit && last
                ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
                    'base64url',
                  )
                : null,
          };
        });
      },
      async replay(actor, id, input) {
        const parsed = operatorAction.parse(input);
        return store.transaction(async () => {
          const { row, c } = await managed(actor, id);
          assert(
            queueKinds.includes(row.kind as QueueKind) && row.version === parsed.version,
            409,
            'Message changed',
          );
          assert(
            ['quarantined', 'retry'].includes(row.data.state),
            409,
            'Only failed or quarantined messages may be retried',
          );
          await active(c);
          return summary(
            await store.revise(
              actor,
              row,
              row.version,
              {
                ...row.data,
                state: 'pending',
                cycleAttempts: 0,
                availableAt: now(),
                code: null,
                lease: null,
                replayReason: parsed.reason,
                replayedBy: actor.id,
                replayedAt: now(),
              },
              'integration.replayed',
            ),
          );
        });
      },
      async connection(actor, id, input) {
        const parsed = connectionChange.parse(input);
        await store.transaction(async () => {
          const { row } = await managed(actor, id);
          assert(
            row.kind === 'integrationConnection' && row.version === parsed.version,
            409,
            'Connection changed',
          );
          await store.revise(
            actor,
            row,
            row.version,
            { ...row.data, enabled: parsed.enabled, reason: parsed.reason, changedBy: actor.id },
            'integration.connection-changed',
          );
        });
      },
      async runOnce(signal = new AbortController().signal) {
        const counts = { attempted: 0, applied: 0 };
        for (const c of configured.values()) {
          if (signal.aborted) break;
          const outgoing = await claim(c, 'integrationOutbox');
          if (outgoing) {
            await send(
              c,
              outgoing,
              AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
            );
            counts.attempted++;
          }
          if (signal.aborted) break;
          const incoming = await claim(c, 'integrationInbox');
          if (incoming && (await apply(c, incoming))) counts.applied++;
        }
        return counts;
      },
    };
    ctx.provide('integrations', service);
    if (settings.worker) {
      const stop = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let running: Promise<unknown> = Promise.resolve();
      const tick = () => {
        running = service
          .runOnce(stop.signal)
          .catch(() => {
            // Never log payloads, credentials or database/partner error messages.
            console.error('Integration worker cycle failed; pending leases remain recoverable');
          })
          .finally(() => {
            if (!stop.signal.aborted) timer = setTimeout(tick, settings.pollMs);
          });
      };
      timer = setTimeout(tick, 0);
      ctx.onDispose(async () => {
        stop.abort();
        clearTimeout(timer);
        await running;
      });
    }
  },
} satisfies Plugin;
