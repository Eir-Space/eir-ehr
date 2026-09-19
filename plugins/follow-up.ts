import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert, type Actor, type Entity, type Plugin } from '../packages/contracts.ts';
import {
  coverageInput,
  followUpState,
  openTask,
  policyInput,
  type FollowUp,
} from '../packages/follow-up.ts';
import { entityQuery, type EntityQuery } from '../packages/entity-query.ts';

const iso = () => new Date().toISOString();
const reasonInput = z.string().trim().min(5).max(2000);
const cursorSchema = entityQuery.shape.after.unwrap();
const cursor = (row: Entity) => ({ createdAt: row.createdAt, id: row.id });
type Scope = { tenant: string; id: string };
const machine = (scope: Scope): Actor => ({
  id: `follow-up:${scope.id}`,
  tenant: scope.tenant,
  unitId: scope.id,
  role: 'integration',
});

export default {
  id: 'eir.follow-up',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['followUp'],
  requires: ['store', 'access', 'workforce', 'followUpPolicy', 'notificationTransport'],
  async setup(ctx, config) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      workforce = ctx.get('workforce');
    const policies = ctx.get('followUpPolicy'),
      transport = ctx.get('notificationTransport');
    const policyFor = (tenant: string, unitId: string) => {
      const value = policies.resolve(tenant, unitId);
      return value ? policyInput.parse(value) : undefined;
    };
    const settings = z
      .object({
        worker: z.boolean().default(false),
        pollMs: z.number().int().min(100).max(60000).default(5000),
        leaseMs: z.number().int().min(11000).max(300000).default(30000),
        retryMs: z.number().int().min(10).max(3600000).default(5000),
        maxAttempts: z.number().int().min(1).max(20).default(6),
        routes: z
          .array(
            z
              .object({
                tenant: z.string(),
                unitId: z.string(),
                actorId: z.string(),
                recipient: z.string().min(1).max(200),
              })
              .strict(),
          )
          .default([]),
        workspaceUrl: z.url().default('https://ehr.eir.space/'),
      })
      .strict()
      .parse(config);
    const url = new URL(settings.workspaceUrl);
    assert(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))),
      422,
      'Unsafe workspace URL',
    );
    assert(
      new Set(settings.routes.map((r) => `${r.tenant}/${r.unitId}/${r.actorId}`)).size ===
        settings.routes.length,
      422,
      'Duplicate notification route',
    );
    assert(store.searchEntities, 503, 'Follow-up requires bounded entity search');
    const search = (tenant: string, kind: string, query: EntityQuery) =>
      store.searchEntities!(tenant, kind, query);
    const route = (scope: Scope, id: string) =>
      settings.routes.find(
        (r) => r.tenant === scope.tenant && r.unitId === scope.id && r.actorId === id,
      );
    const cursors = new Map<string, string>();
    for (const scope of workforce.units) {
      await store.transaction(async () => {
        let row = (
          await search(scope.tenant, 'followUpWorker', { equals: { unitId: scope.id }, limit: 1 })
        )[0];
        row ??= await store.insert(machine(scope), 'followUpWorker', null, {
          unitId: scope.id,
          after: null,
          lastCycleAt: null,
        });
        cursors.set(`${scope.tenant}/${scope.id}`, row.id);
      });
    }
    const eligible = async (scope: Scope, id: string, task: Entity) => {
      for (const assignment of await search(scope.tenant, 'staffAssignment', {
        equals: { actorId: id, unitId: scope.id },
        limit: 100,
      })) {
        if (assignment.data.role !== 'clinician') continue;
        try {
          const candidate = workforce.actor(assignment);
          await workforce.current(candidate);
          const permissions =
            (await access.context?.(candidate, task.patientId))?.permissions ?? [];
          if (
            permissions.includes('chart.read') &&
            permissions.includes(task.data.linkedOrderId ? 'lab.review' : 'task.write')
          )
            return true;
        } catch {
          /* An expired assignment must not receive clinical work. */
        }
      }
      return false;
    };
    const readTask = async (actor: Actor, id: string, version?: number) => {
      assert(actor.role === 'clinician' && actor.unitId, 403, 'Clinical assignment required');
      const task = await store.get(actor.tenant, id);
      assert(task?.kind === 'task', 404, 'Follow-up not found');
      await access.permit(actor, 'task.write', task.patientId);
      if (version !== undefined)
        assert(task.version === version, 409, 'Follow-up changed. Reload before saving.');
      return task;
    };
    const processTask = async (scope: Scope, id: string) =>
      store.transaction(async () => {
        let task = await store.get(scope.tenant, id);
        if (!task || !openTask(task)) return;
        const policy = policyFor(scope.tenant, scope.id);
        if (!policy) return;
        const patient = await store.get(scope.tenant, task.patientId);
        if (patient?.kind !== 'patient' || patient.data.careUnitId !== scope.id) return;
        const actor = machine(scope);
        const order = task.data.linkedOrderId
          ? await store.get(scope.tenant, task.data.linkedOrderId)
          : undefined;
        if (
          task.data.linkedOrderId &&
          (!order || order.patientId !== task.patientId || order.kind !== 'labOrder')
        )
          return;
        const state = followUpState(task, order, policy);
        const previous = task.data.followUp?.cycle === state.cycle ? task.data.followUp : {};
        const overdue = Date.parse(state.deadlineAt) <= Date.now();
        const level =
          Date.parse(state.deadlineAt) + policy.escalationMinutes * 60000 <= Date.now() ? 1 : 0;
        const owner = task.data.assigneeId ?? task.data.author;
        const visitedOwners: string[] = previous.visitedOwners ?? [owner];
        let target = owner,
          blocker: string | null = null;
        const coverage = (
          await search(scope.tenant, 'followUpCoverage', {
            equals: { unitId: scope.id, ownerId: owner, active: true },
            limit: 100,
          })
        ).find(
          (r) =>
            Date.parse(r.data.startsAt) <= Date.now() && Date.parse(r.data.endsAt) > Date.now(),
        );
        if (coverage) {
          if (await eligible(scope, coverage.data.coverId, task)) target = coverage.data.coverId;
          else blocker = 'coverage_ineligible';
        }
        const ownerEligible = await eligible(scope, target, task);
        if (!ownerEligible || level > 0) {
          if (policy.fallbackActorId && (await eligible(scope, policy.fallbackActorId, task)))
            target = policy.fallbackActorId;
          else if (!ownerEligible) blocker = 'owner_ineligible';
          else if (level > 0) blocker ??= 'escalation_recipient_missing';
        }
        if (!(await eligible(scope, target, task))) blocker = 'owner_ineligible';
        if (target !== owner && (visitedOwners.includes(target) || visitedOwners.length >= 32)) {
          target = owner;
          blocker = 'coverage_cycle';
        }
        const activeRoute = route(scope, target);
        const notify = state.critical || overdue || target !== owner;
        if (notify && !activeRoute) blocker ??= 'notification_route_missing';
        const lastNotification = previous.notificationId
          ? await store.get(scope.tenant, previous.notificationId)
          : undefined;
        const unresolved =
          lastNotification && !['delivered', 'cancelled'].includes(lastNotification.data.state);
        const newEvent =
          previous.cycle !== state.cycle || previous.ownerId !== target || previous.level !== level;
        const repeat =
          !unresolved &&
          (lastNotification?.data.code === 'route_changed' ||
            Date.parse(previous.notifiedAt ?? '1970-01-01') + policy.reminderMinutes * 60000 <=
              Date.now());
        let notificationId = previous.notificationId ?? null,
          notifiedAt = previous.notifiedAt ?? null;
        if (
          notify &&
          activeRoute &&
          (await eligible(scope, target, task)) &&
          (newEvent || repeat)
        ) {
          const notification = await store.insert(actor, 'followUpNotification', task.patientId, {
            taskId: task.id,
            unitId: scope.id,
            cycle: state.cycle,
            recipientId: target,
            routeRecipient: activeRoute.recipient,
            workspaceUrl: settings.workspaceUrl,
            destination: transport.destination,
            state: 'pending',
            attempts: 0,
            availableAt: iso(),
            lease: null,
            code: null,
            messageId: randomUUID(),
          });
          notificationId = notification.id;
          notifiedAt = iso();
        }
        const next = {
          ...state,
          ownerId: target,
          level,
          blocker,
          notificationId,
          notifiedAt,
          visitedOwners: target === owner ? visitedOwners : [...visitedOwners, target],
        };
        if (JSON.stringify(previous) !== JSON.stringify(next) || target !== owner) {
          task = await store.revise(
            actor,
            task,
            task.version,
            { ...task.data, assigneeId: target, followUp: next },
            'follow-up.evaluate',
          );
          if (newEvent || previous.blocker !== blocker)
            await store.insert(actor, 'followUpEvent', task.patientId, {
              taskId: task.id,
              unitId: scope.id,
              cycle: state.cycle,
              type: 'escalation',
              level,
              blocker,
              ownerId: target,
              previousOwnerId: owner,
              policyVersion: policy.version,
            });
        }
      });
    const deliver = async (scope: Scope) => {
      const actor = machine(scope);
      const claimed = await store.transaction(async () => {
        const candidates = [];
        for (const state of ['pending', 'retry', 'sending']) {
          const rows = await search(scope.tenant, 'followUpNotification', {
            equals: { unitId: scope.id, state },
            dueBefore: iso(),
            limit: 1,
          });
          if (rows[0]) candidates.push(rows[0]);
        }
        for (const row of candidates.sort((a, b) =>
          a.data.availableAt.localeCompare(b.data.availableAt),
        )) {
          const task = await store.get(scope.tenant, row.data.taskId);
          const policy = policyFor(scope.tenant, scope.id);
          const order = task?.data.linkedOrderId
            ? await store.get(scope.tenant, task.data.linkedOrderId)
            : undefined;
          const selected = route(scope, row.data.recipientId);
          if (
            !task ||
            !openTask(task) ||
            !policy ||
            followUpState(task, order, policy).cycle !== row.data.cycle ||
            (task.data.assigneeId ?? task.data.author) !== row.data.recipientId ||
            !(await eligible(scope, row.data.recipientId, task))
          ) {
            await store.revise(
              actor,
              row,
              row.version,
              { ...row.data, state: 'cancelled', code: 'work_changed', lease: null },
              'follow-up.notification-cancelled',
            );
            return;
          }
          const routeChanged =
            !selected ||
            selected.recipient !== row.data.routeRecipient ||
            settings.workspaceUrl !== row.data.workspaceUrl ||
            transport.destination !== row.data.destination;
          if (routeChanged || row.data.attempts >= settings.maxAttempts) {
            await store.revise(
              actor,
              row,
              row.version,
              {
                ...row.data,
                state: routeChanged ? 'cancelled' : 'failed',
                code: routeChanged ? 'route_changed' : 'attempts_exhausted',
                lease: null,
              },
              routeChanged ? 'follow-up.notification-cancelled' : 'follow-up.notification-failed',
            );
            return;
          }
          return store.revise(
            actor,
            row,
            row.version,
            {
              ...row.data,
              state: 'sending',
              attempts: row.data.attempts + 1,
              lease: randomUUID(),
              availableAt: new Date(Date.now() + settings.leaseMs).toISOString(),
            },
            'follow-up.notification-claimed',
          );
        }
      });
      if (!claimed) return 0;
      let success = false;
      try {
        await transport.send({
          protocol: 'eir.notification.v1',
          messageId: claimed.data.messageId,
          recipient: claimed.data.routeRecipient,
          text: 'Open Eir to review assigned work.',
          url: claimed.data.workspaceUrl,
        });
        success = true;
      } catch {
        /* Do not expose gateway responses or addresses in logs. */
      }
      await store.transaction(async () => {
        const row = await store.get(scope.tenant, claimed.id);
        if (row?.data.state !== 'sending' || row.data.lease !== claimed.data.lease) return;
        await store.revise(
          actor,
          row,
          row.version,
          {
            ...row.data,
            state: success
              ? 'delivered'
              : row.data.attempts >= settings.maxAttempts
                ? 'failed'
                : 'retry',
            code: success ? null : 'delivery_unconfirmed',
            lease: null,
            availableAt: new Date(
              Date.now() +
                Math.min(3600000, settings.retryMs * 2 ** Math.min(row.data.attempts - 1, 12)),
            ).toISOString(),
          },
          success ? 'follow-up.notification-delivered' : 'follow-up.notification-unconfirmed',
        );
      });
      return success ? 1 : 0;
    };
    const service: FollowUp = {
      async list(actor, input) {
        assert(actor.role === 'clinician' && actor.unitId, 403, 'Clinical assignment required');
        await access.permit(actor, 'task.write');
        const query = z
          .object({
            after: z.string().max(1000).optional(),
            status: z.enum(['open', 'closed']).default('open'),
            taskId: z.uuid().optional(),
            eventAfter: z.string().max(1000).optional(),
          })
          .strict()
          .parse(input);
        const parseCursor = (value?: string) => {
          if (!value) return undefined;
          try {
            return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
          } catch {
            assert(false, 422, 'Invalid pagination cursor');
          }
        };
        const after = parseCursor(query.after),
          eventAfter = parseCursor(query.eventAfter);
        return store.transaction(async () => {
          await access.permit(actor, 'task.write');
          const scope = { tenant: actor.tenant, id: actor.unitId! };
          const policy = policyFor(scope.tenant, scope.id);
          const rows = query.taskId
            ? [await readTask(actor, query.taskId)]
            : await search(actor.tenant, 'task', {
                after,
                statuses:
                  query.status === 'closed'
                    ? ['completed', 'cancelled']
                    : ['requested', 'in-progress'],
                limit: 50,
              });
          const items = [];
          for (const task of rows) {
            const patient = await store.get(actor.tenant, task.patientId);
            if (
              !patient ||
              patient.data.careUnitId !== actor.unitId ||
              !(await access.allowed(actor, task.patientId))
            )
              continue;
            await access.check(actor, task.patientId);
            const order = task.data.linkedOrderId
              ? await store.get(actor.tenant, task.data.linkedOrderId)
              : undefined;
            const state = policy ? followUpState(task, order, policy) : null;
            const notification = task.data.followUp?.notificationId
              ? await store.get(actor.tenant, task.data.followUp.notificationId)
              : undefined;
            const events = query.taskId
              ? await search(actor.tenant, 'followUpEvent', {
                  equals: { taskId: task.id },
                  after: eventAfter,
                  limit: 50,
                })
              : [];
            items.push({
              task,
              patientName: patient.data.name,
              state,
              overdue: state && openTask(task) && Date.parse(state.deadlineAt) <= Date.now(),
              orderId: order?.id ?? null,
              notification: notification
                ? {
                    id: notification.id,
                    version: notification.version,
                    state: notification.data.state,
                    attempts: notification.data.attempts,
                    code: notification.data.code,
                  }
                : null,
              events,
              nextEventCursor:
                events.length === 50
                  ? Buffer.from(JSON.stringify(cursor(events.at(-1)!))).toString('base64url')
                  : null,
            });
          }
          const worker = await store.get(actor.tenant, cursors.get(`${scope.tenant}/${scope.id}`)!);
          const coverage = await search(actor.tenant, 'followUpCoverage', {
            equals: { unitId: actor.unitId!, ownerId: actor.id, active: true },
            limit: 100,
          });
          await store.audit(actor, 'follow-up.workspace');
          return {
            items,
            policy: policy ?? null,
            lastCycleAt: worker?.data.lastCycleAt ?? null,
            lastFullScanAt: worker?.data.lastFullScanAt ?? null,
            coverage,
            nextCursor:
              !query.taskId && rows.length === 50
                ? Buffer.from(JSON.stringify(cursor(rows.at(-1)!))).toString('base64url')
                : null,
          };
        });
      },
      async coverage(actor, input) {
        assert(actor.role === 'clinician' && actor.unitId, 403, 'Clinical assignment required');
        const parsed = coverageInput.parse(input);
        assert(
          Date.parse(parsed.endsAt) > Date.parse(parsed.startsAt) &&
            Date.parse(parsed.endsAt) > Date.now() &&
            Date.parse(parsed.endsAt) - Date.parse(parsed.startsAt) <= 90 * 86400000,
          422,
          'Invalid coverage period',
        );
        assert(parsed.coverId !== actor.id, 422, 'Choose another covering clinician');
        return store.transaction(async () => {
          await access.permit(actor, 'task.write');
          assert(
            (await access.members?.(actor))?.some((m) => m.id === parsed.coverId),
            422,
            'Unknown covering clinician',
          );
          const rows = await search(actor.tenant, 'followUpCoverage', {
            equals: { unitId: actor.unitId!, ownerId: actor.id, active: true },
            limit: 100,
          });
          assert(
            rows.length < 100 &&
              !rows.some(
                (r) =>
                  Date.parse(r.data.startsAt) < Date.parse(parsed.endsAt) &&
                  Date.parse(parsed.startsAt) < Date.parse(r.data.endsAt),
              ),
            409,
            'Coverage periods overlap or require cleanup',
          );
          return store.insert(actor, 'followUpCoverage', null, {
            ...parsed,
            startsAt: new Date(parsed.startsAt).toISOString(),
            endsAt: new Date(parsed.endsAt).toISOString(),
            ownerId: actor.id,
            unitId: actor.unitId,
            active: true,
          });
        });
      },
      async cancelCoverage(actor, id, version, reason) {
        reasonInput.parse(reason);
        return store.transaction(async () => {
          assert(actor.role === 'clinician', 403, 'Clinical assignment required');
          await access.permit(actor, 'task.write');
          const row = await store.get(actor.tenant, id);
          assert(
            row?.kind === 'followUpCoverage' &&
              row.data.unitId === actor.unitId &&
              row.data.ownerId === actor.id,
            404,
            'Coverage not found',
          );
          assert(row.version === version && row.data.active, 409, 'Coverage changed');
          return store.revise(
            actor,
            row,
            version,
            { ...row.data, active: false, cancellationReason: reason },
            'follow-up.coverage-cancelled',
          );
        });
      },
      async action(actor, id, version, input) {
        const parsed = z
          .object({ type: z.enum(['contact-attempt', 'action', 'complete']), note: reasonInput })
          .strict()
          .parse(input);
        await readTask(actor, id, version);
        return store.transaction(async () => {
          const task = await readTask(actor, id, version);
          assert(
            openTask(task) && (task.data.assigneeId ?? task.data.author) === actor.id,
            403,
            'Only the current owner can record follow-up',
          );
          const order = task.data.linkedOrderId
            ? await store.get(actor.tenant, task.data.linkedOrderId)
            : undefined;
          assert(
            !task.data.linkedOrderId ||
              (order?.kind === 'labOrder' && order.patientId === task.patientId),
            409,
            'Linked order is unavailable',
          );
          if (order) {
            await access.permit(actor, 'lab.review', task.patientId);
            assert(
              order.data.status === 'reviewed' &&
                order.data.reviewedReportId === order.data.reportId &&
                order.data.reportId === task.data.reportId,
              409,
              'Review the current report before follow-up',
            );
          }
          await store.insert(actor, 'followUpEvent', task.patientId, {
            taskId: id,
            unitId: actor.unitId,
            type: parsed.type,
            note: parsed.note,
            reportId: order?.data.reportId ?? null,
            author: actor.id,
          });
          if (order && parsed.type === 'complete')
            await store.revise(
              actor,
              order,
              order.version,
              { ...order.data, actionRequired: false, actionCompletedAt: iso() },
              'labOrder.action-completed',
            );
          return store.revise(
            actor,
            task,
            version,
            {
              ...task.data,
              ...(parsed.type === 'complete'
                ? {
                    status: 'completed',
                    resolution: parsed.note,
                    completedBy: actor.id,
                    completedAt: iso(),
                  }
                : { lastActionAt: iso() }),
            },
            `follow-up.${parsed.type}`,
          );
        });
      },
      async replay(actor, id, version, reason) {
        reasonInput.parse(reason);
        return store.transaction(async () => {
          const row = await store.get(actor.tenant, id);
          assert(
            row?.kind === 'followUpNotification' && row.data.unitId === actor.unitId,
            404,
            'Notification not found',
          );
          const task = await readTask(actor, row.data.taskId);
          assert(
            (task.data.assigneeId ?? task.data.author) === actor.id && openTask(task),
            403,
            'Current owner required',
          );
          assert(
            row.version === version && row.data.state === 'failed',
            409,
            'Notification cannot be replayed',
          );
          return store.revise(
            actor,
            row,
            version,
            { ...row.data, state: 'retry', attempts: 0, availableAt: iso(), replayReason: reason },
            'follow-up.notification-replay',
          );
        });
      },
      async runOnce() {
        let scanned = 0,
          delivered = 0;
        for (const scope of workforce.units) {
          if (!policyFor(scope.tenant, scope.id)) continue;
          const workerId = cursors.get(`${scope.tenant}/${scope.id}`)!;
          const worker = (await store.get(scope.tenant, workerId))!;
          const rows = await search(scope.tenant, 'task', {
            ...(worker.data.after ? { after: worker.data.after } : {}),
            statuses: ['requested', 'in-progress'],
            limit: 50,
          });
          for (const task of rows) {
            await processTask(scope, task.id);
            scanned++;
          }
          delivered += await deliver(scope);
          await store.transaction(async () => {
            const current = (await store.get(scope.tenant, workerId))!;
            if (current.version !== worker.version) return;
            await store.revise(
              machine(scope),
              current,
              current.version,
              {
                ...current.data,
                after: rows.length === 50 ? cursor(rows.at(-1)!) : null,
                lastCycleAt: iso(),
                lastFullScanAt: rows.length < 50 ? iso() : (current.data.lastFullScanAt ?? null),
              },
              'follow-up.worker-cycle',
            );
          });
        }
        return { scanned, delivered };
      },
    };
    ctx.provide('followUp', service);
    if (settings.worker) {
      let stopping = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      let active: Promise<void> = Promise.resolve();
      const tick = () => {
        active = service
          .runOnce()
          .then(
            () => {},
            () => {
              console.error('Follow-up worker cycle failed; clinical work remains open');
            },
          )
          .finally(() => {
            if (!stopping) timer = setTimeout(tick, settings.pollMs);
          });
      };
      timer = setTimeout(tick, settings.pollMs);
      ctx.onDispose(async () => {
        stopping = true;
        clearTimeout(timer);
        await active;
      });
    }
  },
} satisfies Plugin;
