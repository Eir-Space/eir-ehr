import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, Fault, type Clinical, type Entity, type Plugin } from '../packages/contracts.ts';
import { taskInput } from '../packages/care-team.ts';
import { visibleRecord } from '../packages/visibility.ts';
import { canonicalOf, canonicalReference } from '../packages/clinical-repository.ts';

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
  '9279-1': { label: 'Andningsfrekvens', unit: '/min', min: 1, max: 100 },
  '59408-5': { label: 'Syremättnad (SpO2)', unit: '%', min: 1, max: 100 },
};
export const inputs: Record<string, z.ZodType> = {
  encounter: z.object({ reason: short }).strict(),
  note: z.object({ encounterId: id, text, clientId: id.optional() }).strict(),
  observation: z.union([
    z
      .object({
        encounterId: id,
        code: z.enum(Object.keys(vitals) as [string, ...string[]]),
        value: z.number().finite(),
        unit: short,
        effectiveAt: z.iso.datetime({ offset: true }),
        clientId: id.optional(),
      })
      .strict(),
    z
      .object({
        encounterId: id,
        code: z.literal('85354-9'),
        systolic: z.number().finite(),
        diastolic: z.number().finite(),
        unit: z.literal('mm[Hg]'),
        effectiveAt: z.iso.datetime({ offset: true }),
        clientId: id.optional(),
      })
      .strict(),
  ]),
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
  optionalRequires: ['clinicalRepository', 'clinicalModels'],
  setup(ctx, config) {
    const options = z
      .object({ canonicalKinds: z.array(z.enum(['observation'])).default([]) })
      .strict()
      .parse(config);
    const store = ctx.get('store'),
      access = ctx.get('access'),
      country = ctx.get('country');
    const terminology = ctx.get('terminology');
    const careTeam = ctx.get('careTeam');
    const canonicalKinds = new Set<string>(options.canonicalKinds);
    if (canonicalKinds.size)
      assert(
        ctx.has('clinicalRepository') && ctx.has('clinicalModels'),
        503,
        'Canonical clinical repository is not configured',
      );
    const repository = () => ctx.get('clinicalRepository');
    const models = () => ctx.get('clinicalModels');
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const canonical = (kind: string) => canonicalKinds.has(kind);
    const operation = async (tenant: string, patientId: string, clientId: string) =>
      (await store.list(tenant, patientId, 'clinicalWrite')).find(
        (row) => row.data.clientId === clientId,
      );
    const safeFailure = (error: unknown) =>
      error instanceof Fault && error.status < 500 ? 'rejected' : 'repository-unavailable';

    const hydrate = async (row: Entity): Promise<Entity> => {
      const ref = canonicalOf(row);
      if (!ref || !canonical(row.kind)) return row;
      assert(
        ref.repository === repository().key,
        503,
        'Canonical repository does not match profile',
      );
      const current = await repository().get(row.tenant, ref.contentId);
      assert(
        current?.patientId === row.patientId && current.kind === row.kind,
        503,
        'Canonical clinical record is unavailable',
      );
      return {
        ...row,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        data: {
          ...current.data,
          _canonical: canonicalReference(repository(), models(), current),
        },
      };
    };

    const createCanonical = async (
      actor: Parameters<Clinical['create']>[0],
      patientId: string,
      kind: string,
      data: Record<string, any>,
    ) => {
      assert(data.clientId, 422, 'Canonical clinical writes require clientId');
      const clientId = String(data.clientId);
      const requestHash = digest({ kind, data });
      const previous = await store.transaction(async () => {
        await access.permit(actor, 'record.write', patientId);
        const encounter = await store.get(actor.tenant, data.encounterId);
        assert(
          encounter?.kind === 'encounter' &&
            encounter.patientId === patientId &&
            encounter.data.status === 'in-progress',
          409,
          'An open encounter for this patient is required',
        );
        const existing = await operation(actor.tenant, patientId, clientId);
        if (existing) {
          assert(existing.data.requestHash === requestHash, 409, 'clientId already used');
          if (existing.data.status === 'completed') {
            const mirror = await store.get(actor.tenant, existing.data.mirrorId);
            assert(mirror, 503, 'Canonical write mirror is missing');
            return mirror;
          }
          if (
            existing.data.status === 'pending' &&
            Date.parse(String(existing.data.leaseUntil)) > Date.now()
          )
            throw new Fault(409, 'Clinical write is already in progress');
          const { reason: _reason, ...operationData } = existing.data;
          const retryData = {
            ...operationData,
            status: 'pending',
            attempts: existing.data.attempts + 1,
            leaseUntil: new Date(Date.now() + repository().operationLeaseMs()).toISOString(),
          };
          await store.revise(
            actor,
            existing,
            existing.version,
            retryData,
            'clinical-write.retried',
          );
          return undefined;
        }
        await store.insert(actor, 'clinicalWrite', patientId, {
          clientId,
          kind,
          encounterId: data.encounterId,
          repository: repository().key,
          requestHash,
          status: 'pending',
          attempts: 1,
          leaseUntil: new Date(Date.now() + repository().operationLeaseMs()).toISOString(),
        });
        return undefined;
      });
      if (previous) return await hydrate(previous);

      let committed: Entity;
      try {
        committed = await repository().create(actor, kind, patientId, data, clientId);
      } catch (error) {
        await store.transaction(async () => {
          const pending = await operation(actor.tenant, patientId, clientId);
          if (pending?.data.status === 'pending')
            await store.revise(
              actor,
              pending,
              pending.version,
              { ...pending.data, status: 'failed', reason: safeFailure(error) },
              'clinical-write.failed',
            );
        });
        throw error;
      }

      try {
        return await store.transaction(async () => {
          const pending = await operation(actor.tenant, patientId, clientId);
          assert(
            pending?.data.requestHash === requestHash,
            409,
            'Clinical write operation changed',
          );
          if (pending.data.status === 'completed') {
            const mirror = await store.get(actor.tenant, pending.data.mirrorId);
            assert(mirror, 503, 'Canonical write mirror is missing');
            return mirror;
          }
          const encounter = await store.get(actor.tenant, data.encounterId);
          assert(
            encounter?.kind === 'encounter' && encounter.data.status === 'in-progress',
            409,
            'Encounter closed before clinical write completed',
          );
          const reference = canonicalReference(repository(), models(), committed);
          const mirror = await store.insert(actor, kind, patientId, {
            ...committed.data,
            _canonical: reference,
          });
          await store.insert(actor, 'contentLink', patientId, {
            entityId: mirror.id,
            kind,
            target: repository().key,
            token: clientId,
            contentId: committed.id,
            status: 'synced',
            syncedVersion: mirror.version,
            attempts: 1,
            syncedAt: new Date().toISOString(),
            authority: 'canonical',
          });
          await store.revise(
            actor,
            pending,
            pending.version,
            {
              ...pending.data,
              status: 'completed',
              contentId: committed.id,
              mirrorId: mirror.id,
              canonicalVersion: committed.version,
              completedAt: new Date().toISOString(),
            },
            'clinical-write.completed',
          );
          await store.audit(actor, `${kind}.canonical-created`, patientId, mirror.id);
          return mirror;
        });
      } catch (error) {
        try {
          await store.transaction(async () => {
            const pending = await operation(actor.tenant, patientId, clientId);
            if (pending?.data.status === 'pending')
              await store.revise(
                actor,
                pending,
                pending.version,
                {
                  ...pending.data,
                  status: 'repository-committed',
                  contentId: committed.id,
                  canonicalVersion: committed.version,
                  leaseUntil: new Date().toISOString(),
                },
                'clinical-write.recovery-ready',
              );
          });
        } catch {
          // The pending lease still allows later recovery when SQL becomes available.
        }
        throw error;
      }
    };
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
        const rows = await store.transaction(async () => {
          await access.check(actor, patientId);
          return (await store.list(actor.tenant, patientId)).filter((e) => visibleRecord(actor, e));
        });
        const hydrated: Entity[] = [];
        for (let index = 0; index < rows.length; index += 8)
          hydrated.push(...(await Promise.all(rows.slice(index, index + 8).map(hydrate))));
        await store.transaction(async () => access.check(actor, patientId));
        return hydrated;
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
          if (parsed.code === '85354-9') {
            assert(
              parsed.unit === 'mm[Hg]' &&
                parsed.systolic >= vitals['8480-6'].min &&
                parsed.systolic <= vitals['8480-6'].max &&
                parsed.diastolic >= vitals['8462-4'].min &&
                parsed.diastolic <= vitals['8462-4'].max &&
                parsed.systolic > parsed.diastolic,
              422,
              'Invalid blood pressure',
            );
            parsed.display = 'Blodtryck';
            parsed.components = [
              {
                code: '8480-6',
                value: parsed.systolic,
                unit: 'mm[Hg]',
                display: vitals['8480-6'].label,
              },
              {
                code: '8462-4',
                value: parsed.diastolic,
                unit: 'mm[Hg]',
                display: vitals['8462-4'].label,
              },
            ];
            delete parsed.systolic;
            delete parsed.diastolic;
          } else {
            const definition = vitals[parsed.code];
            assert(
              parsed.unit === definition.unit &&
                parsed.value >= definition.min &&
                parsed.value <= definition.max,
              422,
              'Invalid observation unit or value',
            );
            parsed.display = definition.label;
          }
          assert(
            Date.parse(parsed.effectiveAt) <= Date.now(),
            422,
            'Observation time cannot be in the future',
          );
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
        const recordData = {
          ...parsed,
          status,
          author: actor.id,
        };
        if (canonical(kind))
          return await createCanonical(
            actor,
            patientId,
            kind,
            models().validate(kind, recordData, actor),
          );
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
          return await store.insert(actor, kind, patientId, recordData);
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
        const reference = canonicalOf(entity);
        if (reference && canonical(entity.kind)) {
          assert(entity.version === version, 409, 'Record changed. Reload before saving.');
          assert(
            entity.kind === 'observation' && action === 'correct',
            422,
            'Unsupported clinical transition',
          );
          const reason = z.object({ reason: short }).strict().parse(input).reason;
          const source = await repository().get(actor.tenant, reference.contentId);
          assert(
            source?.patientId === entity.patientId && source.kind === entity.kind,
            503,
            'Canonical clinical record is unavailable',
          );
          let committed = source;
          if (source.data.status === 'entered-in-error')
            assert(
              source.data.correctionReason === reason,
              409,
              'Record was already corrected with another reason',
            );
          else
            committed = await repository().revise(
              actor,
              source,
              { ...source.data, status: 'entered-in-error', correctionReason: reason },
              `${entity.kind}.${action}`,
            );
          return await store.transaction(async () => {
            const mirror = await store.get(actor.tenant, entityId);
            assert(
              mirror?.version === version && canonicalOf(mirror)?.contentId === committed.id,
              409,
              'Record changed. Reload before saving.',
            );
            const updated = await store.revise(
              actor,
              mirror,
              version,
              {
                ...committed.data,
                _canonical: canonicalReference(repository(), models(), committed),
              },
              `${entity.kind}.${action}`,
            );
            const link = (await store.list(actor.tenant, entity.patientId, 'contentLink')).find(
              (row) => row.data.entityId === entity.id && row.data.target === repository().key,
            );
            if (link)
              await store.revise(
                actor,
                link,
                link.version,
                {
                  ...link.data,
                  syncedVersion: updated.version,
                  canonicalVersion: committed.version,
                  syncedAt: new Date().toISOString(),
                },
                'clinical-write.mirror-synced',
              );
            await store.audit(
              actor,
              `${entity.kind}.canonical-${action}`,
              entity.patientId,
              entity.id,
            );
            return updated;
          });
        }
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
              !(await store.list(actor.tenant, entity.patientId, 'clinicalWrite')).some(
                (write) => write.data.encounterId === entity.id && write.data.status === 'pending',
              ),
              409,
              'A clinical write is still being committed',
            );
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
        const reference = canonicalOf(entity);
        if (reference && canonical(entity.kind)) {
          const history = await repository().history(actor.tenant, reference.contentId);
          await store.transaction(async () => access.check(actor, entity.patientId));
          return history.map((version) => ({
            ...version,
            id: entity.id,
            data: {
              ...version.data,
              _canonical: canonicalReference(repository(), models(), version),
            },
          }));
        }
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
