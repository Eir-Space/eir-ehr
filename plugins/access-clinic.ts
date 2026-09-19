import {
  assert,
  type Access,
  type Actor,
  type Permission,
  type Plugin,
  type TeamMember,
} from '../packages/contracts.ts';

export default {
  id: 'eir.access.clinic',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['access'],
  requires: ['store', 'workforce'],
  setup(ctx) {
    const store = ctx.get('store'),
      workforce = ctx.get('workforce');
    const decision = async (actor: Actor, action: Permission, patientId?: string) => {
      try {
        const assignment = await workforce.current(actor);
        if (!assignment.data.permissions.includes(action)) return false;
        if (!patientId) return true;
        const patient = await store.get(actor.tenant, patientId);
        if (
          patient?.kind !== 'patient' ||
          patient.data.careUnitId !== actor.unitId ||
          (await store.isBlocked(actor.tenant, patientId))
        )
          return false;
        if (
          patient.data.protectedIdentity &&
          !assignment.data.permissions.includes('patient.protected')
        )
          return false;
        const grant = await store.getGrant(actor.tenant, patientId, actor.id);
        if (
          grant?.role === 'clinician' &&
          grant.expires > new Date().toISOString() &&
          (await store.list(actor.tenant, patientId, 'careRelationship')).some(
            (r) =>
              r.data.target === actor.id &&
              r.data.assignmentId === assignment.id &&
              r.data.expires > new Date().toISOString(),
          )
        )
          return true;
        // Exceptional access is read-only, unit-scoped and never overrides a restriction.
        return (
          action === 'chart.read' &&
          (await store.list(actor.tenant, patientId, 'emergencyAccess')).some(
            (r) =>
              r.data.assignmentId === assignment.id && r.data.expires > new Date().toISOString(),
          )
        );
      } catch {
        return false;
      }
    };
    const access: Access = {
      async context(actor, patientId) {
        const row = await workforce.current(actor);
        const permissions: Permission[] = [];
        for (const permission of row.data.permissions)
          if (!patientId || (await decision(actor, permission, patientId)))
            permissions.push(permission);
        return {
          permissions,
          unitId: row.data.unitId,
          name: row.data.name,
        };
      },
      async permit(actor, action, patientId) {
        const allowed = await decision(actor, action, patientId);
        await store.audit(
          actor,
          `permission.${action}`,
          patientId,
          undefined,
          allowed ? 'success' : 'denied',
        );
        assert(allowed, 403, 'Permission or care relationship is missing for the selected unit');
      },
      async allowed(actor, patientId, write = false) {
        return decision(actor, write ? 'record.write' : 'chart.read', patientId);
      },
      async check(actor, patientId, write = false) {
        await access.permit(actor, write ? 'record.write' : 'chart.read', patientId);
      },
      async members(actor) {
        await workforce.current(actor);
        const assignments = await store.list(actor.tenant, undefined, 'staffAssignment');
        const members: TeamMember[] = [];
        for (const r of assignments) {
          if (r.data.role !== 'clinician' || r.data.unitId !== actor.unitId) continue;
          try {
            await workforce.current(workforce.actor(r));
          } catch {
            continue;
          }
          members.push({
            id: r.data.actorId,
            tenant: r.tenant,
            name: r.data.name,
            profession: 'Vårdpersonal',
          });
        }
        return members.sort((a, b) =>
          a.id === actor.id ? -1 : b.id === actor.id ? 1 : a.name.localeCompare(b.name),
        );
      },
      async eligible(actor, targetId, patientId, action) {
        await workforce.current(actor);
        for (const row of await store.list(actor.tenant, undefined, 'staffAssignment'))
          if (
            row.data.actorId === targetId &&
            row.data.unitId === actor.unitId &&
            (await decision(workforce.actor(row), action, patientId))
          )
            return true;
        return false;
      },
      async grant(actor, patientId, target, role, expires, reason) {
        await access.permit(actor, 'access.manage', patientId);
        await store.transaction(async () => {
          await access.permit(actor, 'access.manage', patientId);
          assert(
            role === 'clinician' && target !== actor.id,
            403,
            'Verified staff assignment required; self-grants and proxy delegation are not supported',
          );
          assert(
            typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 200,
            422,
            'Reason for care relationship required',
          );
          const expiration = new Date(expires).toISOString();
          const targetAssignment = (
            await store.list(actor.tenant, undefined, 'staffAssignment')
          ).find(
            (r) =>
              r.data.actorId === target &&
              r.data.role === 'clinician' &&
              r.data.unitId === actor.unitId,
          );
          assert(targetAssignment, 403, 'No staff assignment in this unit');
          await workforce.current(workforce.actor(targetAssignment));
          assert(
            expiration > new Date().toISOString() &&
              expiration <= targetAssignment.data.validUntil &&
              Date.parse(expiration) <= Date.now() + 30 * 86400000,
            422,
            'Care relationship must expire within assignment validity and 30 days',
          );
          await store.grant(actor.tenant, patientId, target, role, expiration);
          await store.audit(actor, 'access.grant', patientId, target);
          await store.insert(actor, 'careRelationship', patientId, {
            target,
            assignmentId: targetAssignment.id,
            reason: reason.trim(),
            expires: expiration,
          });
        });
      },
      async block() {
        assert(
          false,
          403,
          'Patient restriction management requires a verified country-specific patient service',
        );
      },
    };
    ctx.provide('access', access);
  },
} satisfies Plugin;
