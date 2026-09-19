import { z } from 'zod';
import {
  assert,
  type Actor,
  type Entity,
  type Plugin,
  type Workforce,
} from '../packages/contracts.ts';
import { assignmentInput, assignmentChange, activeAssignment } from '../packages/workforce.ts';

export default {
  id: 'eir.workforce',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['workforce'],
  requires: ['store'],
  async setup(ctx, config) {
    const store = ctx.get('store');
    const settings = z
      .object({
        units: z
          .array(
            z
              .object({ id: z.string().min(1), tenant: z.string().min(1), name: z.string().min(1) })
              .strict(),
          )
          .min(1),
        bootstrap: z.array(assignmentInput).default([]),
      })
      .strict()
      .parse(config);
    assert(
      new Set(settings.units.map((u) => u.id)).size === settings.units.length,
      422,
      'Duplicate unit',
    );
    const rows = (tenant: string) => store.list(tenant, undefined, 'staffAssignment');
    const sameIdentity = (a: Entity, b: Entity) =>
      a.data.issuer === b.data.issuer && a.data.subject === b.data.subject;
    const unit = (id: string) => {
      const u = settings.units.find((u) => u.id === id);
      assert(u, 422, 'Unknown care unit');
      return u;
    };
    const allRows = async () => {
      const all: Entity[] = [];
      for (const tenant of new Set(settings.units.map((u) => u.tenant)))
        all.push(...(await rows(tenant)));
      return all;
    };
    const validateIdentity = async (input: z.infer<typeof assignmentInput>) => {
      const all = await allRows();
      // One identity may have several assignments, never several local staff identities.
      assert(
        !all.some(
          (a) =>
            (a.data.issuer === input.issuer &&
              a.data.subject === input.subject &&
              a.data.actorId !== input.actorId) ||
            (a.data.actorId === input.actorId &&
              (a.data.issuer !== input.issuer || a.data.subject !== input.subject)),
        ),
        409,
        'Identity is already mapped to different staff',
      );
      assert(
        !all.some(
          (a) =>
            a.data.actorId === input.actorId &&
            a.data.unitId === input.unitId &&
            a.data.role === input.role,
        ),
        409,
        'Assignment already exists',
      );
    };
    const workforce: Workforce = {
      units: settings.units,
      async current(actor) {
        const row = actor.assignmentId
          ? await store.get(actor.tenant, actor.assignmentId)
          : undefined;
        assert(
          row?.kind === 'staffAssignment' &&
            activeAssignment(row) &&
            row.data.actorId === actor.id &&
            row.data.role === actor.role &&
            row.data.unitId === actor.unitId,
          403,
          'No active staff assignment',
        );
        if (actor.authentication)
          assert(
            row.data.issuer === actor.authentication.issuer &&
              row.data.subject === actor.authentication.subject,
            403,
            'Identity does not match assignment',
          );
        assert(
          unit(row.data.unitId).tenant === actor.tenant,
          403,
          'Unit belongs to a different provider',
        );
        return row;
      },
      async assignments(actor) {
        const current = await workforce.current(actor);
        return (await rows(actor.tenant)).filter(
          (a) =>
            a.data.actorId === actor.id &&
            sameIdentity(a, current) &&
            activeAssignment(a) &&
            settings.units.some((u) => u.id === a.data.unitId && u.tenant === a.tenant),
        );
      },
      async forIdentity(issuer, subject) {
        return (await allRows()).filter(
          (a) =>
            activeAssignment(a) &&
            a.data.issuer === issuer &&
            a.data.subject === subject &&
            settings.units.some((u) => u.id === a.data.unitId && u.tenant === a.tenant),
        );
      },
      actor(row, authentication) {
        return {
          id: row.data.actorId,
          tenant: row.tenant,
          role: row.data.role,
          assignmentId: row.id,
          unitId: row.data.unitId,
          ...(authentication ? { authentication } : {}),
        };
      },
      async staff(actor) {
        const current = await workforce.current(actor);
        assert(
          current.data.permissions.includes('workforce.manage'),
          403,
          'Workforce administration required',
        );
        await store.audit(actor, 'workforce.directory');
        return (await rows(actor.tenant)).filter((a) => a.data.unitId === actor.unitId);
      },
      async create(actor, input) {
        return store.transaction(async () => {
          await workforce.staff(actor);
          const parsed = assignmentInput.parse(input);
          assert(
            parsed.unitId === actor.unitId && parsed.actorId !== actor.id,
            403,
            'Cannot administer yourself or another unit',
          );
          await validateIdentity(parsed);
          return store.insert(actor, 'staffAssignment', null, parsed);
        });
      },
      async update(actor, id, version, input) {
        return store.transaction(async () => {
          await workforce.staff(actor);
          const row = await store.get(actor.tenant, id);
          assert(
            row?.kind === 'staffAssignment' &&
              row.data.unitId === actor.unitId &&
              row.data.actorId !== actor.id,
            403,
            'Cannot administer yourself or another unit',
          );
          const parsed = assignmentChange.parse(input);
          const { reason, ...changes } = parsed;
          const data = assignmentInput.parse({ ...row.data, ...changes });
          const updated = await store.revise(
            actor,
            row,
            version,
            data,
            'workforce.assignment-changed',
          );
          await store.insert(actor, 'assignmentChange', null, {
            assignmentId: id,
            reason,
            fromVersion: version,
            enabled: data.enabled,
          });
          return updated;
        });
      },
    };
    // Bootstrap once per store; restarts must never restore revoked assignments.
    for (const tenant of new Set(settings.units.map((u) => u.tenant))) {
      await store.transaction(async () => {
        if ((await store.list(tenant, undefined, 'workforceBootstrap')).length) return;
        const admin: Actor = { id: 'workforce-bootstrap', tenant, role: 'administrator' };
        for (const input of settings.bootstrap.filter((a) => unit(a.unitId).tenant === tenant)) {
          await validateIdentity(input);
          await store.insert({ ...admin, unitId: input.unitId }, 'staffAssignment', null, input);
        }
        await store.insert(admin, 'workforceBootstrap', null, { completed: true });
      });
    }
    ctx.provide('workforce', workforce);
  },
} satisfies Plugin;
