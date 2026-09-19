import { z } from 'zod';
import { assert, Fault, type Clinical, type Entity, type Plugin } from '../packages/contracts.ts';
import { taskInput } from '../packages/care-team.ts';
import { visibleRecord } from '../packages/visibility.ts';

const text = z.string().trim().min(1).max(20000);
const short = z.string().trim().min(1).max(200);
const id = z.uuid();
const code = z
  .object({
    system: z.url(),
    code: short,
    display: z.string().trim().min(1).max(1000),
    version: short.optional(),
  })
  .strict();
export const patientInput = z
  .object({
    name: short,
    birthDate: z.iso.date(),
    identifier: z.object({ type: short, value: short }).strict(),
  })
  .strict();
export const vitals: Record<string, { label: string; unit: string; min: number; max: number }> = {
  '8867-4': { label: 'Puls', unit: '/min', min: 1, max: 350 },
  '8310-5': { label: 'Kroppstemperatur', unit: 'Cel', min: 20, max: 50 },
  '8480-6': { label: 'Systoliskt blodtryck', unit: 'mm[Hg]', min: 20, max: 350 },
  '8462-4': { label: 'Diastoliskt blodtryck', unit: 'mm[Hg]', min: 10, max: 250 },
  '29463-7': { label: 'Kroppsvikt', unit: 'kg', min: 0.1, max: 700 },
};
export const inputs: Record<string, z.ZodType> = {
  encounter: z.object({ reason: short }).strict(),
  note: z.object({ encounterId: id, text, clientId: id.optional() }).strict(),
  observation: z
    .object({
      encounterId: id,
      code: z.enum(Object.keys(vitals) as [string, ...string[]]),
      value: z.number().finite(),
      unit: short,
      effectiveAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  condition: z.object({ code, onset: z.iso.date().optional() }).strict(),
  allergy: z
    .object({
      substance: short,
      reaction: short,
      criticality: z.enum(['low', 'high', 'unable-to-assess']),
    })
    .strict(),
  task: taskInput,
};
export default {
  id: 'eir.clinical',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['clinical'],
  requires: ['store', 'country', 'access', 'terminology', 'careTeam'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      country = ctx.get('country');
    const terminology = ctx.get('terminology');
    const careTeam = ctx.get('careTeam');
    const clinical: Clinical = {
      async patients(actor) {
        return await store.transaction(async () => {
          await store.audit(actor, 'patient.directory');
          const patients: Entity[] = [];
          for (const patient of await store.list(actor.tenant, undefined, 'patient')) {
            if (!(await access.allowed(actor, patient.id))) continue;
            await access.check(actor, patient.id);
            patients.push(patient);
          }
          return patients;
        });
      },
      async register(actor, input) {
        assert(actor.role === 'clinician', 403, 'Clinician role required');
        await access.permit(actor, 'patient.register');
        const parsed = patientInput.parse(input);
        assert(
          parsed.birthDate <= new Date().toISOString().slice(0, 10),
          422,
          'Birth date cannot be in the future',
        );
        const identifier = country.identifier(parsed.identifier);
        try {
          return await store.transaction(async () => {
            await access.permit(actor, 'patient.register');
            const patient = await store.insert(actor, 'patient', null, {
              ...parsed,
              identifier,
              country: country.code,
              ...(access.context ? { careUnitId: (await access.context(actor)).unitId } : {}),
            });
            await store.grant(
              actor.tenant,
              patient.id,
              actor.id,
              'clinician',
              new Date(Date.now() + 86400000 * 30).toISOString(),
            );
            await store.audit(actor, 'care-relationship.created', patient.id);
            if (access.context)
              await store.insert(actor, 'careRelationship', patient.id, {
                target: actor.id,
                assignmentId: actor.assignmentId,
                reason: 'Patient registered for care in the active unit',
                expires: new Date(Date.now() + 86400000 * 30).toISOString(),
              });
            return patient;
          });
        } catch (error: any) {
          if (error.code === '23505' || String(error.message).includes('UNIQUE constraint'))
            throw new Fault(409, 'Identifier already registered in this organisation');
          throw error;
        }
      },
      async chart(actor, patientId) {
        await access.check(actor, patientId);
        return await store.transaction(async () => {
          await access.check(actor, patientId);
          return (await store.list(actor.tenant, patientId)).filter((e) => visibleRecord(actor, e));
        });
      },
      async create(actor, patientId, kind, input) {
        await access.permit(actor, kind === 'task' ? 'task.write' : 'record.write', patientId);
        if (kind === 'task') return await careTeam.createTask(actor, patientId, input);
        assert(inputs[kind], 422, 'Unsupported clinical record type');
        const parsed = inputs[kind].parse(input) as Record<string, any>;
        if (kind === 'condition') {
          assert(
            parsed.code.system === terminology.source.system,
            422,
            'Unsupported diagnosis code system',
          );
          assert(
            !parsed.code.version || parsed.code.version === terminology.source.version,
            409,
            'Diagnosis catalogue version changed',
          );
          const term = terminology.lookup(parsed.code.code);
          assert(term?.selectable, 422, 'Select a valid, specific diagnosis code');
          parsed.code = {
            system: term.system,
            version: term.version,
            code: term.code,
            display: term.display,
          };
        }
        if (kind === 'observation') {
          const definition = vitals[parsed.code];
          assert(
            parsed.unit === definition.unit &&
              parsed.value >= definition.min &&
              parsed.value <= definition.max,
            422,
            'Invalid observation unit or value',
          );
          assert(
            Date.parse(parsed.effectiveAt) <= Date.now(),
            422,
            'Observation time cannot be in the future',
          );
          parsed.display = definition.label;
        }
        const status = (
          {
            encounter: 'in-progress',
            note: 'draft',
            observation: 'final',
            condition: 'active',
            allergy: 'active',
            task: 'requested',
          } as Record<string, string>
        )[kind];
        return await store.transaction(async () => {
          await access.permit(actor, 'record.write', patientId);
          if (parsed.encounterId) {
            const encounter = await store.get(actor.tenant, parsed.encounterId);
            assert(
              encounter?.kind === 'encounter' &&
                encounter.patientId === patientId &&
                encounter.data.status === 'in-progress',
              409,
              'An open encounter for this patient is required',
            );
          }
          if (kind === 'note' && parsed.clientId) {
            const previous = (await store.list(actor.tenant, patientId, 'note')).find(
              (r) => r.data.clientId === parsed.clientId,
            );
            if (previous) {
              assert(
                previous.data.author === actor.id &&
                  previous.data.encounterId === parsed.encounterId &&
                  previous.data.status === 'draft' &&
                  previous.data.text === parsed.text,
                409,
                'Draft already exists with different content. Reload the chart.',
              );
              return previous;
            }
          }
          if (kind === 'encounter')
            assert(
              !(await store.list(actor.tenant, patientId, 'encounter')).some(
                (e) => e.data.status === 'in-progress',
              ),
              409,
              'This patient already has an open encounter',
            );
          return await store.insert(actor, kind, patientId, {
            ...parsed,
            status,
            author: actor.id,
          });
        });
      },
      async transition(actor, entityId, action, version, input) {
        const entity = await store.get(actor.tenant, entityId);
        assert(entity, 404, 'Record not found');
        if (entity.kind === 'task')
          return await careTeam.task(actor, entityId, action, version, input);
        await access.permit(
          actor,
          entity.kind === 'note' && action === 'sign' ? 'note.sign' : 'record.write',
          entity.patientId,
        );
        return await store.transaction(async () => {
          const entity = await store.get(actor.tenant, entityId);
          assert(entity, 404, 'Record not found');
          await access.permit(
            actor,
            entity.kind === 'note' && action === 'sign' ? 'note.sign' : 'record.write',
            entity.patientId,
          );
          assert(entity.version === version, 409, 'Record changed. Reload before saving.');
          let data = { ...entity.data };
          if (entity.kind === 'note') {
            if (action === 'amend') {
              assert(data.status === 'signed', 409, 'Only signed notes can be amended');
              const amendment = z.object({ text, reason: short }).strict().parse(input);
              return await store.insert(actor, 'note', entity.patientId, {
                ...amendment,
                status: 'draft',
                author: actor.id,
                encounterId: data.encounterId,
                amends: entity.id,
              });
            }
            assert(data.status === 'draft', 409, 'Signed notes are immutable; create an amendment');
            if (access.context)
              assert(
                data.author === actor.id,
                403,
                'Only the note author can edit or sign; co-signing is not enabled',
              );
            if (action === 'save') data.text = z.object({ text }).strict().parse(input).text;
            else if (action === 'sign') {
              z.object({}).strict().parse(input);
              data = {
                ...data,
                status: 'signed',
                signedBy: actor.id,
                signedAt: new Date().toISOString(),
                ...(actor.assignmentId
                  ? {
                      signedUnder: {
                        assignmentId: actor.assignmentId,
                        unitId: actor.unitId,
                        authentication: actor.authentication?.method ?? 'local',
                        acr: actor.authentication?.acr ?? null,
                      },
                    }
                  : {}),
              };
            } else throw new Fault(422, 'Unsupported note action');
          } else if (entity.kind === 'encounter' && action === 'close') {
            assert(data.status === 'in-progress', 409, 'Encounter is already closed');
            assert(
              !(await store.list(actor.tenant, entity.patientId, 'note')).some(
                (note) => note.data.encounterId === entity.id && note.data.status === 'draft',
              ),
              409,
              'Sign draft notes before closing the encounter',
            );
            data = { ...data, status: 'finished', closedAt: new Date().toISOString() };
          } else if (
            ['condition', 'allergy', 'observation'].includes(entity.kind) &&
            action === 'correct'
          ) {
            const reason = z.object({ reason: short }).strict().parse(input).reason;
            assert(data.status !== 'entered-in-error', 409, 'Record already corrected');
            data = { ...data, status: 'entered-in-error', correctionReason: reason };
          } else throw new Fault(422, 'Unsupported clinical transition');
          const updated = await store.revise(
            actor,
            entity,
            version,
            data,
            `${entity.kind}.${action}`,
          );
          if (entity.kind === 'encounter' && action === 'close')
            await careTeam.encounterClosed(actor, entity.id);
          return updated;
        });
      },
      async history(actor, entityId) {
        const entity = await store.get(actor.tenant, entityId);
        assert(entity, 404, 'Record not found');
        await access.check(actor, entity.patientId);
        return await store.transaction(async () => {
          const entity = await store.get(actor.tenant, entityId);
          assert(entity, 404, 'Record not found');
          await access.check(actor, entity.patientId);
          return (await store.history(actor.tenant, entityId)).filter((e) =>
            visibleRecord(actor, e),
          );
        });
      },
    };
    ctx.provide('clinical', clinical);
  },
} satisfies Plugin;
