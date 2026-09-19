import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { bookingInput, taskInput } from '../packages/care-team.ts';
import { reopenLabTask } from '../packages/lab-application.ts';
import {
  assert,
  Fault,
  type Actor,
  type CareTeam,
  type Entity,
  type Plugin,
  type Permission,
} from '../packages/contracts.ts';

const short = z.string().trim().min(1).max(200);
const reason = z.object({ reason: short }).strict();
const empty = z.object({}).strict();
const memberInput = z.object({ id: short, tenant: short, name: short, profession: short }).strict();
const activeBooking = (r: Entity) => ['booked', 'arrived', 'in-progress'].includes(r.data.status);

export default {
  id: 'eir.care-team',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['careTeam'],
  requires: ['store', 'access'],
  setup(ctx, config) {
    const store = ctx.get('store'),
      access = ctx.get('access');
    const settings = z
      .object({
        timeZone: z.string().default('Europe/Stockholm'),
        members: z.array(memberInput).default([]),
      })
      .strict()
      .parse(config);
    Temporal.Now.zonedDateTimeISO(settings.timeZone);
    assert(
      new Set(settings.members.map((m) => `${m.tenant}/${m.id}`)).size === settings.members.length,
      422,
      'Duplicate team member',
    );
    const clinician = (actor: Actor) =>
      assert(actor.role === 'clinician', 403, 'Clinician role required');
    const members = async (actor: Actor) => {
      clinician(actor);
      if (access.members) return await access.members(actor);
      const rows = settings.members.filter((m) => m.tenant === actor.tenant);
      return rows.some((m) => m.id === actor.id)
        ? rows
        : [
            { id: actor.id, tenant: actor.tenant, name: actor.id, profession: 'Vårdpersonal' },
            ...rows,
          ];
    };
    const assignee = async (
      actor: Actor,
      patientId: string,
      id: string,
      permission: Permission = 'task.write',
    ) => {
      assert(
        (await members(actor)).some((m) => m.id === id),
        422,
        'Unknown team member',
      );
      assert(
        access.eligible
          ? await access.eligible(actor, id, patientId, permission)
          : await access.allowed({ ...actor, id }, patientId, true),
        403,
        'The selected team member has no active care relationship',
      );
    };
    const current = async (actor: Actor, id: string, kind: string, version: number) => {
      clinician(actor);
      const row = await store.get(actor.tenant, id);
      assert(row?.kind === kind, 404, 'Record not found');
      await access.permit(
        actor,
        kind === 'appointment' ? 'schedule.write' : 'task.write',
        row.patientId,
      );
      assert(row.version === version, 409, 'Record changed. Reload before saving.');
      return row;
    };
    const slot = async (actor: Actor, patientId: string, input: unknown, except?: string) => {
      const parsed = bookingInput.parse(input);
      await assignee(actor, patientId, parsed.practitionerId, 'record.write');
      let startsAt: string, endsAt: string;
      try {
        const start = Temporal.PlainDateTime.from(parsed.localStart).toZonedDateTime(
          settings.timeZone,
          { disambiguation: 'reject' },
        );
        startsAt = start.toInstant().toString();
        endsAt = start.add({ minutes: parsed.durationMinutes }).toInstant().toString();
      } catch {
        throw new Fault(422, 'Invalid or ambiguous clinic time. Choose another time.');
      }
      assert(
        !(await store.list(actor.tenant, undefined, 'appointment')).some(
          (r) =>
            r.id !== except &&
            activeBooking(r) &&
            (r.patientId === patientId || r.data.practitionerId === parsed.practitionerId) &&
            Date.parse(r.data.startsAt) < Date.parse(endsAt) &&
            Date.parse(r.data.endsAt) > Date.parse(startsAt),
        ),
        409,
        'The patient or clinician already has an overlapping appointment',
      );
      return { ...parsed, startsAt, endsAt, timeZone: settings.timeZone };
    };
    const service: CareTeam = {
      timeZone: settings.timeZone,
      members,
      async workspace(actor, day) {
        clinician(actor);
        z.iso.date().parse(day);
        const start = Temporal.PlainDate.from(day).toZonedDateTime(settings.timeZone);
        const end = start.add({ days: 1 });
        return await store.transaction(async () => {
          const visible = new Set<string>();
          for (const patient of await store.list(actor.tenant, undefined, 'patient')) {
            if (await access.allowed(actor, patient.id)) visible.add(patient.id);
          }
          const appointments = (await store.list(actor.tenant, undefined, 'appointment'))
            .filter(
              (r) =>
                visible.has(r.patientId) &&
                Date.parse(r.data.startsAt) < end.epochMilliseconds &&
                Date.parse(r.data.endsAt) > start.epochMilliseconds,
            )
            .sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt));
          const tasks = (await store.list(actor.tenant, undefined, 'task'))
            .filter((r) => visible.has(r.patientId))
            .sort((a, b) => a.data.due.localeCompare(b.data.due) || a.id.localeCompare(b.id));
          for (const id of new Set([...appointments, ...tasks].map((r) => r.patientId)))
            await access.check(actor, id);
          await store.audit(actor, 'care-team.workspace');
          return { appointments, tasks };
        });
      },
      async book(actor, patientId, input) {
        clinician(actor);
        await access.permit(actor, 'schedule.write', patientId);
        return await store.transaction(async () => {
          await access.permit(actor, 'schedule.write', patientId);
          return await store.insert(actor, 'appointment', patientId, {
            ...(await slot(actor, patientId, input)),
            status: 'booked',
            author: actor.id,
          });
        });
      },
      async appointment(actor, id, action, version, input) {
        await current(actor, id, 'appointment', version);
        return await store.transaction(async () => {
          const row = await current(actor, id, 'appointment', version);
          let data = { ...row.data };
          if (action === 'reschedule') {
            assert(data.status === 'booked', 409, 'Only a booked appointment can be rescheduled');
            data = { ...data, ...(await slot(actor, row.patientId, input, id)) };
          } else if (action === 'cancel' || action === 'no-show') {
            const parsed = reason.parse(input);
            assert(
              ['booked', 'arrived'].includes(data.status),
              409,
              'Appointment already started or closed',
            );
            if (action === 'no-show') {
              assert(
                data.status === 'booked' && Date.parse(data.startsAt) <= Date.now(),
                409,
                'Cannot mark a future or arrived appointment as no-show',
              );
            }
            data = {
              ...data,
              status: action === 'cancel' ? 'cancelled' : 'no-show',
              resolution: parsed.reason,
            };
          } else if (action === 'arrive') {
            empty.parse(input);
            assert(data.status === 'booked', 409, 'Appointment is not booked');
            data = { ...data, status: 'arrived', arrivedAt: new Date().toISOString() };
          } else if (action === 'start') {
            await access.permit(actor, 'record.write', row.patientId);
            empty.parse(input);
            assert(
              ['booked', 'arrived'].includes(data.status),
              409,
              'Appointment already started or closed',
            );
            assert(
              data.practitionerId === actor.id,
              403,
              'Only the booked clinician can start this appointment',
            );
            let encounter = (await store.list(actor.tenant, row.patientId, 'encounter')).find(
              (r) => r.data.status === 'in-progress',
            );
            assert(
              !encounter ||
                !(await store.list(actor.tenant, row.patientId, 'appointment')).some(
                  (r) => r.data.status === 'in-progress' && r.data.encounterId === encounter!.id,
                ),
              409,
              'The current encounter is already linked to another appointment',
            );
            encounter ??= await store.insert(actor, 'encounter', row.patientId, {
              reason: data.reason,
              status: 'in-progress',
              author: actor.id,
            });
            data = {
              ...data,
              status: 'in-progress',
              encounterId: encounter.id,
              startedAt: new Date().toISOString(),
            };
          } else throw new Fault(422, 'Unsupported appointment action');
          return await store.revise(actor, row, version, data, `appointment.${action}`);
        });
      },
      async encounterClosed(actor, encounterId) {
        const encounter = await store.get(actor.tenant, encounterId);
        assert(
          encounter?.kind === 'encounter' && encounter.data.status === 'finished',
          409,
          'Encounter is not finished',
        );
        await access.permit(actor, 'record.write', encounter.patientId);
        for (const row of await store.list(actor.tenant, encounter.patientId, 'appointment')) {
          if (row.data.encounterId === encounterId && row.data.status === 'in-progress') {
            await store.revise(
              actor,
              row,
              row.version,
              { ...row.data, status: 'completed', completedAt: encounter.data.closedAt },
              'appointment.completed',
            );
          }
        }
      },
      async createTask(actor, patientId, input) {
        clinician(actor);
        await access.permit(actor, 'task.write', patientId);
        const parsed = taskInput.parse(input);
        const assigneeId = parsed.assigneeId ?? actor.id;
        return await store.transaction(async () => {
          await access.permit(actor, 'task.write', patientId);
          await assignee(actor, patientId, assigneeId);
          return await store.insert(actor, 'task', patientId, {
            ...parsed,
            assigneeId,
            status: 'requested',
            author: actor.id,
          });
        });
      },
      async createLinkedTask(actor, patientId, input, orderId) {
        clinician(actor);
        await access.permit(actor, 'lab.order', patientId);
        const parsed = taskInput.parse(input);
        const assigneeId = parsed.assigneeId ?? actor.id;
        await assignee(actor, patientId, assigneeId, 'lab.review');
        const order = await store.get(actor.tenant, orderId);
        assert(
          order?.kind === 'labOrder' && order.patientId === patientId,
          409,
          'Invalid linked order',
        );
        assert(
          !(await store.list(actor.tenant, patientId, 'task')).some(
            (r) => r.data.linkedOrderId === orderId,
          ),
          409,
          'Order already has follow-up',
        );
        return await store.insert(actor, 'task', patientId, {
          ...parsed,
          assigneeId,
          linkedOrderId: orderId,
          status: 'requested',
          author: actor.id,
        });
      },
      async syncLinkedTask(actor, order, event, resolution) {
        clinician(actor);
        await access.permit(
          actor,
          event === 'result' ? 'lab.receive' : event === 'review' ? 'lab.review' : 'lab.order',
          order.patientId,
        );
        const saved = await store.get(actor.tenant, order.id);
        assert(saved?.kind === 'labOrder' && saved.version === order.version, 409, 'Order changed');
        if (event === 'result') {
          assert(saved.data.status === 'received', 409, 'Order has no new result');
          return reopenLabTask(store, actor, saved, settings.timeZone);
        }
        const row = (await store.list(actor.tenant, order.patientId, 'task')).find(
          (r) => r.data.linkedOrderId === order.id,
        );
        assert(row, 409, 'Order follow-up is missing');
        let data = { ...row.data };
        {
          assert(
            data.assigneeId === actor.id,
            403,
            'Reassign the follow-up before acting for its owner',
          );
          assert(
            saved.data.status === (event === 'review' ? 'reviewed' : 'cancelled'),
            409,
            'Order state does not match follow-up',
          );
          data = {
            ...data,
            status: event === 'review' ? 'completed' : 'cancelled',
            resolution,
            completedAt: new Date().toISOString(),
            completedBy: actor.id,
          };
          if (event === 'review' && saved.data.actionRequired) {
            data.status = 'requested';
            data.dueAt = saved.data.actionDueAt;
            data.title = `Uppföljning efter provsvar: ${saved.data.test}`.slice(0, 200);
            delete data.completedAt;
            delete data.completedBy;
            delete data.followUp;
          }
        }
        return await store.revise(actor, row, row.version, data, `task.lab-${event}`);
      },
      async task(actor, id, action, version, input) {
        await current(actor, id, 'task', version);
        return await store.transaction(async () => {
          const row = await current(actor, id, 'task', version);
          assert(
            !row.data.linkedOrderId || ['assign', 'start'].includes(action),
            409,
            'Linked lab follow-up must be resolved through the lab order and current report',
          );
          let data = { ...row.data };
          const owner = data.assigneeId ?? data.author;
          if (action === 'assign') {
            const parsed = z.object({ assigneeId: short, reason: short }).strict().parse(input);
            assert(['requested', 'in-progress'].includes(data.status), 409, 'Task is closed');
            await assignee(
              actor,
              row.patientId,
              parsed.assigneeId,
              data.linkedOrderId ? 'lab.review' : 'task.write',
            );
            data = {
              ...data,
              assigneeId: parsed.assigneeId,
              assignmentReason: parsed.reason,
              status: 'requested',
            };
          } else if (action === 'reschedule') {
            const parsed = z.object({ due: z.iso.date(), reason: short }).strict().parse(input);
            assert(['requested', 'in-progress'].includes(data.status), 409, 'Task is closed');
            data = { ...data, due: parsed.due, rescheduleReason: parsed.reason };
            delete data.dueAt;
          } else if (action === 'reopen') {
            const parsed = reason.parse(input);
            assert(['completed', 'cancelled'].includes(data.status), 409, 'Task is already open');
            await assignee(actor, row.patientId, owner);
            data = { ...data, status: 'requested', reopenedReason: parsed.reason };
            delete data.completedAt;
            delete data.completedBy;
            delete data.resolution;
          } else {
            assert(['requested', 'in-progress'].includes(data.status), 409, 'Task is closed');
            assert(owner === actor.id, 403, 'Reassign the task before acting for its owner');
            if (action === 'start') {
              empty.parse(input);
              assert(data.status === 'requested', 409, 'Task is already in progress');
              data = { ...data, status: 'in-progress' };
            } else if (action === 'complete') {
              const parsed = z.object({ resolution: short.optional() }).strict().parse(input);
              data = {
                ...data,
                status: 'completed',
                completedBy: actor.id,
                completedAt: new Date().toISOString(),
                ...parsed,
              };
            } else if (action === 'cancel') {
              const parsed = reason.parse(input);
              data = {
                ...data,
                status: 'cancelled',
                resolution: parsed.reason,
                completedBy: actor.id,
                completedAt: new Date().toISOString(),
              };
            } else throw new Fault(422, 'Unsupported task action');
          }
          return await store.revise(actor, row, version, data, `task.${action}`);
        });
      },
    };
    ctx.provide('careTeam', service);
  },
} satisfies Plugin;
