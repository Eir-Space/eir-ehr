import { z } from 'zod';
import { assert, type Actor, type Entity, type Plugin } from '../packages/contracts.ts';
import {
  ageAt,
  digest,
  riskInput,
  riskOutput,
  type Deterioration,
  type RiskOutput,
} from '../packages/deterioration.ts';
import { entityQuery, type EntityQuery } from '../packages/entity-query.ts';

const now = () => new Date().toISOString();
const reason = z.string().trim().min(5).max(2000);
const pointer = (r: Entity) => ({ createdAt: r.createdAt, id: r.id });
export default {
  id: 'eir.deterioration',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['deterioration'],
  requires: ['store', 'access', 'workforce', 'modules', 'riskEngine'],
  async setup(ctx, config) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      workforce = ctx.get('workforce'),
      modules = ctx.get('modules'),
      engine = ctx.get('riskEngine');
    const settings = z
      .object({
        worker: z.boolean().default(false),
        pollMs: z.number().int().min(1000).max(60000).default(10000),
        reviewMinutes: z.number().int().min(1).max(1440).default(30),
      })
      .strict()
      .parse(config);
    assert(store.searchEntities, 503, 'Monitoring requires bounded entity search');
    const search = store.searchEntities.bind(store);
    const machine = (tenant: string, unitId: string): Actor => ({
      id: 'deterioration-worker',
      role: 'integration',
      tenant,
      unitId,
    });
    const metadata = {
      id: engine.id,
      version: engine.version,
      label: engine.label,
      intendedUse: engine.intendedUse,
    };
    const source = async (actor: Actor, monitor: Pick<Entity, 'patientId' | 'data'>) => {
      await access.permit(actor, 'task.write', monitor.patientId);
      await access.check(actor, monitor.patientId);
      const patient = await store.get(actor.tenant, monitor.patientId);
      const encounter = await store.get(actor.tenant, monitor.data.encounterId);
      assert(
        patient?.kind === 'patient' &&
          !patient.data.protectedIdentity &&
          patient.data.careUnitId === actor.unitId,
        403,
        'Patient is not eligible for monitoring',
      );
      assert(
        encounter?.kind === 'encounter' &&
          encounter.patientId === patient.id &&
          encounter.data.status === 'in-progress',
        409,
        'Monitoring encounter is not open',
      );
      assert(ageAt(patient.data.birthDate, now()) >= 18, 422, 'This module is limited to adults');
      const records: Entity[] = [];
      for (const kind of ['observation', 'labOrder', 'labReport']) {
        let after;
        while (true) {
          const batch: Entity[] = await search(actor.tenant, kind, {
            equals: { encounterId: encounter.id },
            after,
            limit: 100,
          });
          records.push(...batch);
          assert(records.length <= 2000, 409, 'Encounter exceeds the monitoring input limit');
          if (batch.length < 100) break;
          after = pointer(batch.at(-1)!);
        }
      }
      const input = riskInput(patient, encounter.id, records, now());
      return {
        input,
        hash: digest({
          patient: [patient.id, patient.version],
          encounter: [encounter.id, encounter.version],
          records: records.map((r) => [r.id, r.version]).sort(),
        }),
      };
    };
    const read = async (actor: Actor, id: string) => {
      assert(actor.role === 'clinician' && actor.unitId, 403, 'Clinical assignment required');
      const row = await store.get(actor.tenant, id);
      assert(
        row?.kind === 'deteriorationMonitor' && row.data.unitId === actor.unitId,
        404,
        'Monitoring not found',
      );
      await access.permit(actor, 'task.write', row.patientId);
      await access.check(actor, row.patientId);
      return row;
    };
    const checkOwner = async (actor: Actor, monitor: Entity) => {
      const assignment = await store.get(actor.tenant, monitor.data.ownerAssignmentId);
      assert(
        assignment?.kind === 'staffAssignment' &&
          assignment.data.actorId === monitor.data.ownerId &&
          assignment.data.unitId === actor.unitId,
        403,
        'Monitoring owner is unavailable',
      );
      const owner = workforce.actor(assignment);
      await workforce.current(owner);
      await access.permit(owner, 'task.write', monitor.patientId);
      await access.check(owner, monitor.patientId);
    };
    const evaluate = async (actor: Actor, id: string, automatic = false) => {
      const writer = automatic ? machine(actor.tenant, actor.unitId!) : actor;
      const snapshot = await store.transaction(async () => {
        const monitor = await read(actor, id);
        const activation = await modules.state(actor.tenant, actor.unitId!, 'deterioration');
        assert(activation.enabled && monitor.data.active, 409, 'Monitoring is switched off');
        await checkOwner(actor, monitor);
        return { monitor, activation, ...(await source(actor, monitor)) };
      });
      let output: RiskOutput;
      try {
        output = riskOutput.parse(await engine.evaluate(snapshot.input));
        const refs = new Set(
          [...snapshot.input.readings, ...snapshot.input.labs].map((r) => r.ref),
        );
        assert(
          output.findings.every((f) => f.refs.every((ref) => refs.has(ref))) &&
            (output.status === 'alert'
              ? output.findings.length > 0
              : output.findings.length === 0) &&
            (output.status !== 'no-trigger' || output.missing.length === 0),
          502,
          'Invalid risk evidence',
        );
      } catch {
        output = {
          status: 'unavailable',
          findings: [],
          missing: ['Riskmotorn svarade inte med ett giltigt resultat'],
        };
      }
      await store.transaction(async () => {
        const monitor = await read(actor, id);
        const activation = await modules.state(actor.tenant, actor.unitId!, 'deterioration');
        if (
          !activation.enabled ||
          activation.version !== snapshot.activation.version ||
          !monitor.data.active ||
          monitor.version !== snapshot.monitor.version
        )
          return;
        await checkOwner(actor, monitor);
        const current = await source(actor, monitor);
        if (
          current.hash !== snapshot.hash ||
          Date.now() - Date.parse(snapshot.input.evaluatedAt) > 30000
        )
          return;
        const signature = digest({ source: snapshot.hash, engine: metadata, output });
        let assessmentId = monitor.data.assessmentId ?? null;
        if (signature !== monitor.data.signature) {
          const assessment = await store.insert(
            writer,
            'deteriorationAssessment',
            monitor.patientId,
            {
              monitorId: monitor.id,
              unitId: actor.unitId,
              encounterId: monitor.data.encounterId,
              engine: metadata,
              ...output,
              evaluatedAt: snapshot.input.evaluatedAt,
              sourceHash: snapshot.hash,
              readings: snapshot.input.readings,
              labs: snapshot.input.labs,
              ageYears: snapshot.input.ageYears,
              automatic,
              authorizedBy: actor.assignmentId,
            },
          );
          assessmentId = assessment.id;
          const open = (
            await search(actor.tenant, 'deteriorationAlert', {
              equals: { monitorId: monitor.id, open: true },
              limit: 1,
            })
          )[0];
          if (output.status === 'alert' && !open) {
            const alert = await store.insert(writer, 'deteriorationAlert', monitor.patientId, {
              monitorId: monitor.id,
              encounterId: monitor.data.encounterId,
              unitId: actor.unitId,
              open: true,
              status: 'new',
              assessmentId,
            });
            const deadline = new Date(Date.now() + settings.reviewMinutes * 60000).toISOString();
            const task = await store.insert(writer, 'task', monitor.patientId, {
              title: 'Bedöm avvikande vitalparametrar',
              status: 'requested',
              priority: 'urgent',
              due: deadline.slice(0, 10),
              dueAt: deadline,
              encounterId: monitor.data.encounterId,
              assigneeId: monitor.data.ownerId,
              author: monitor.data.ownerId,
              deteriorationAlertId: alert.id,
            });
            await store.revise(
              writer,
              alert,
              alert.version,
              { ...alert.data, taskId: task.id },
              'deterioration.alert-linked',
            );
          } else if (open) {
            // New information invalidates a prior acknowledgement but never silently closes work.
            await store.revise(
              writer,
              open,
              open.version,
              { ...open.data, assessmentId, status: 'new' },
              'deterioration.alert-updated',
            );
          }
        }
        await store.revise(
          writer,
          monitor,
          monitor.version,
          { ...monitor.data, assessmentId, signature, checkedAt: now(), failure: null },
          'deterioration.evaluated',
        );
      });
    };
    const service: Deterioration = {
      async list(actor, input = {}) {
        assert(actor.role === 'clinician' && actor.unitId, 403, 'Clinical assignment required');
        await access.permit(actor, 'task.write');
        const query = z
          .object({ after: z.string().max(1000).optional() })
          .strict()
          .parse(input);
        let after: EntityQuery['after'];
        if (query.after) {
          try {
            after = entityQuery.shape.after
              .unwrap()
              .parse(JSON.parse(Buffer.from(query.after, 'base64url').toString()));
          } catch {
            assert(false, 422, 'Invalid monitoring cursor');
          }
        }
        return store.transaction(async () => {
          await access.permit(actor, 'task.write');
          const rows = await search(actor.tenant, 'deteriorationMonitor', {
            equals: { unitId: actor.unitId! },
            after,
            limit: 50,
          });
          const items = [];
          for (const monitor of rows) {
            if (!(await access.allowed(actor, monitor.patientId))) continue;
            await access.check(actor, monitor.patientId);
            const patient = await store.get(actor.tenant, monitor.patientId);
            const alerts = await search(actor.tenant, 'deteriorationAlert', {
              equals: { monitorId: monitor.id, open: true },
              limit: 50,
            });
            const tasks: Entity[] = [];
            for (const alert of alerts) {
              const task = await store.get(actor.tenant, alert.data.taskId);
              if (task) tasks.push(task);
            }
            const events = await search(actor.tenant, 'deteriorationEvent', {
              equals: { monitorId: monitor.id },
              limit: 100,
            });
            items.push({
              monitor,
              patientName: patient?.data.name ?? '',
              assessment: monitor.data.assessmentId
                ? ((await store.get(actor.tenant, monitor.data.assessmentId)) ?? null)
                : null,
              alerts,
              tasks,
              events,
            });
          }
          await store.audit(actor, 'deterioration.workspace');
          const worker = (
            await search(actor.tenant, 'deteriorationWorker', {
              equals: { unitId: actor.unitId! },
              limit: 1,
            })
          )[0];
          return {
            enabled: (await modules.state(actor.tenant, actor.unitId!, 'deterioration')).enabled,
            engine: metadata,
            worker:
              settings.worker ||
              !!(worker && Date.now() - Date.parse(worker.data.lastCycleAt) < 60000),
            pollMs: settings.pollMs,
            items,
            nextCursor:
              rows.length === 50
                ? Buffer.from(JSON.stringify(pointer(rows.at(-1)!))).toString('base64url')
                : null,
          };
        });
      },
      async enroll(actor, patientId, input) {
        assert(
          actor.role === 'clinician' && actor.unitId && actor.assignmentId,
          403,
          'Clinical assignment required',
        );
        const parsed = z.object({ encounterId: z.uuid(), reason }).strict().parse(input);
        return store.transaction(async () => {
          await access.permit(actor, 'task.write', patientId);
          assert(
            (await modules.state(actor.tenant, actor.unitId!, 'deterioration')).enabled,
            409,
            'Enable the module first',
          );
          const previous = (
            await search(actor.tenant, 'deteriorationMonitor', {
              equals: { encounterId: parsed.encounterId },
              limit: 1,
            })
          )[0];
          assert(!previous?.data.active, 409, 'Encounter is already monitored');
          const data = {
            ...parsed,
            unitId: actor.unitId,
            ownerId: actor.id,
            ownerAssignmentId: actor.assignmentId,
            active: true,
            checkedAt: null,
            assessmentId: null,
            signature: null,
            failure: null,
          };
          await source(actor, { patientId, data });
          if (previous) {
            assert(previous.patientId === patientId, 409, 'Encounter mismatch');
            return store.revise(actor, previous, previous.version, data, 'deterioration.restarted');
          }
          return store.insert(actor, 'deteriorationMonitor', patientId, data);
        });
      },
      async stop(actor, id, input) {
        const data = z
          .object({ version: z.number().int().positive(), reason })
          .strict()
          .parse(input);
        return store.transaction(async () => {
          const monitor = await read(actor, id);
          assert(monitor.data.active, 409, 'Monitoring is already stopped');
          return store.revise(
            actor,
            monitor,
            data.version,
            { ...monitor.data, active: false, stopReason: data.reason, stoppedAt: now() },
            'deterioration.stopped',
          );
        });
      },
      evaluate,
      async respond(actor, id, input) {
        const parsed = z
          .object({
            version: z.number().int().positive(),
            assessmentId: z.uuid(),
            action: z.enum(['acknowledge', 'reassess', 'resolve']),
            note: reason,
            plan: reason.optional(),
          })
          .strict()
          .parse(input);
        return store.transaction(async () => {
          const alert = await store.get(actor.tenant, id);
          assert(alert?.kind === 'deteriorationAlert', 404, 'Alert not found');
          const monitor = await read(actor, alert.data.monitorId);
          assert(
            alert.data.open && alert.data.assessmentId === parsed.assessmentId,
            409,
            'Alert evidence changed. Review it again.',
          );
          const task = await store.get(actor.tenant, alert.data.taskId);
          assert(
            task?.kind === 'task' && task.data.assigneeId === actor.id,
            403,
            'Current task owner required',
          );
          if (
            parsed.action !== 'acknowledge' &&
            monitor.data.active &&
            (await modules.state(actor.tenant, actor.unitId!, 'deterioration')).enabled
          ) {
            const assessment = await store.get(actor.tenant, parsed.assessmentId);
            const current = await source(actor, monitor);
            assert(
              assessment?.data.sourceHash === current.hash &&
                !monitor.data.failure &&
                Date.now() - Date.parse(monitor.data.checkedAt ?? '') < 60000,
              409,
              'Run a current evaluation before documenting the assessment',
            );
          }
          if (parsed.action !== 'acknowledge')
            assert(parsed.plan, 422, 'Document reassessment and a follow-up plan');
          if (parsed.action === 'resolve') {
            assert(
              alert.data.reassessedId === parsed.assessmentId,
              409,
              'Reassess the current evidence before resolving',
            );
            await store.revise(
              actor,
              task,
              task.version,
              {
                ...task.data,
                status: 'completed',
                resolution: parsed.note,
                completedAt: now(),
                completedBy: actor.id,
              },
              'deterioration.task-completed',
            );
          }
          await store.insert(actor, 'deteriorationEvent', alert.patientId, {
            monitorId: alert.data.monitorId,
            alertId: id,
            unitId: actor.unitId,
            assessmentId: parsed.assessmentId,
            action: parsed.action,
            note: parsed.note,
            plan: parsed.plan ?? null,
            author: actor.id,
          });
          return store.revise(
            actor,
            alert,
            parsed.version,
            {
              ...alert.data,
              status:
                parsed.action === 'resolve'
                  ? 'resolved'
                  : parsed.action === 'reassess'
                    ? 'reassessed'
                    : 'acknowledged',
              open: parsed.action !== 'resolve',
              ...(parsed.action === 'reassess' ? { reassessedId: parsed.assessmentId } : {}),
            },
            `deterioration.${parsed.action}`,
          );
        });
      },
      async runOnce() {
        let scanned = 0;
        for (const unit of workforce.units) {
          if (!(await modules.state(unit.tenant, unit.id, 'deterioration')).enabled) continue;
          let worker = (
            await search(unit.tenant, 'deteriorationWorker', {
              equals: { unitId: unit.id },
              limit: 1,
            })
          )[0];
          const rows = await search(unit.tenant, 'deteriorationMonitor', {
            equals: { unitId: unit.id, active: true },
            after: worker?.data.after ?? undefined,
            limit: 50,
          });
          for (const monitor of rows) {
            scanned++;
            try {
              const assignment = await store.get(unit.tenant, monitor.data.ownerAssignmentId);
              assert(
                assignment?.kind === 'staffAssignment',
                403,
                'Monitoring owner is unavailable',
              );
              const actor = workforce.actor(assignment);
              await workforce.current(actor);
              await evaluate(actor, monitor.id, true);
            } catch {
              await store.transaction(async () => {
                const latest = await store.get(unit.tenant, monitor.id);
                if (
                  !latest ||
                  latest.version !== monitor.version ||
                  !(await modules.state(unit.tenant, unit.id, 'deterioration')).enabled
                )
                  return;
                const encounter = await store.get(unit.tenant, latest.data.encounterId);
                const closed =
                  encounter?.kind === 'encounter' && encounter.data.status !== 'in-progress';
                await store.revise(
                  machine(unit.tenant, unit.id),
                  latest,
                  latest.version,
                  {
                    ...latest.data,
                    failure: 'Monitoring could not evaluate the current encounter',
                    checkedAt: now(),
                    ...(closed
                      ? { active: false, stoppedAt: now(), stopReason: 'Encounter closed' }
                      : {}),
                  },
                  'deterioration.unavailable',
                );
              });
            }
          }
          await store.transaction(async () => {
            const current = (
              await search(unit.tenant, 'deteriorationWorker', {
                equals: { unitId: unit.id },
                limit: 1,
              })
            )[0];
            if ((current?.version ?? 0) !== (worker?.version ?? 0)) return;
            const data = {
              unitId: unit.id,
              after: rows.length === 50 ? pointer(rows.at(-1)!) : null,
              lastCycleAt: now(),
            };
            if (current)
              await store.revise(
                machine(unit.tenant, unit.id),
                current,
                current.version,
                data,
                'deterioration.worker-cycle',
              );
            else
              await store.insert(machine(unit.tenant, unit.id), 'deteriorationWorker', null, data);
          });
        }
        return { scanned };
      },
    };
    ctx.provide('deterioration', service);
    if (settings.worker) {
      let stopping = false,
        timer: ReturnType<typeof setTimeout> | undefined,
        active: Promise<unknown> = Promise.resolve();
      const tick = () => {
        active = service
          .runOnce()
          .catch(() => console.error('Deterioration worker failed'))
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
