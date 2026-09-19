import {
  assert,
  type Access,
  type Actor,
  type Permission,
  type Plugin,
} from '../packages/contracts.ts';

export default {
  id: 'eir.access.clinic',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['access'],
  requires: ['store', 'workforce'],
  setup(ctx) {
    const store = ctx.get('store'),
      workforce = ctx.get('workforce');
    const decision = (actor: Actor, action: Permission, patientId?: string) => {
      try {
        const assignment = workforce.current(actor);
        if (!assignment.data.permissions.includes(action)) return false;
        if (!patientId) return true;
        const patient = store.get(actor.tenant, patientId);
        if (
          patient?.kind !== 'patient' ||
          patient.data.careUnitId !== actor.unitId ||
          store.isBlocked(actor.tenant, patientId)
        )
          return false;
        if (
          patient.data.protectedIdentity &&
          !assignment.data.permissions.includes('patient.protected')
        )
          return false;
        const grant = store.getGrant(actor.tenant, patientId, actor.id);
        if (
          grant?.role === 'clinician' &&
          grant.expires > new Date().toISOString() &&
          store
            .list(actor.tenant, patientId, 'careRelationship')
            .some(
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
          store
            .list(actor.tenant, patientId, 'emergencyAccess')
            .some(
              (r) =>
                r.data.assignmentId === assignment.id && r.data.expires > new Date().toISOString(),
            )
        );
      } catch {
        return false;
      }
    };
    const access: Access = {
      context(actor, patientId) {
        const row = workforce.current(actor);
        return {
          permissions: patientId
            ? row.data.permissions.filter((p: Permission) => decision(actor, p, patientId))
            : row.data.permissions,
          unitId: row.data.unitId,
          name: row.data.name,
        };
      },
      permit(actor, action, patientId) {
        const allowed = decision(actor, action, patientId);
        store.audit(
          actor,
          `permission.${action}`,
          patientId,
          undefined,
          allowed ? 'success' : 'denied',
        );
        assert(allowed, 403, 'Permission or care relationship is missing for the selected unit');
      },
      allowed(actor, patientId, write = false) {
        return decision(actor, write ? 'record.write' : 'chart.read', patientId);
      },
      check(actor, patientId, write = false) {
        access.permit(actor, write ? 'record.write' : 'chart.read', patientId);
      },
      members(actor) {
        workforce.current(actor);
        const assignments = store.list(actor.tenant, undefined, 'staffAssignment');
        return assignments
          .filter(
            (r) =>
              r.data.role === 'clinician' &&
              r.data.unitId === actor.unitId &&
              (() => {
                try {
                  workforce.current(workforce.actor(r));
                  return true;
                } catch {
                  return false;
                }
              })(),
          )
          .map((r) => ({
            id: r.data.actorId,
            tenant: r.tenant,
            name: r.data.name,
            profession: 'Vårdpersonal',
          }))
          .sort((a, b) =>
            a.id === actor.id ? -1 : b.id === actor.id ? 1 : a.name.localeCompare(b.name),
          );
      },
      eligible(actor, targetId, patientId, action) {
        workforce.current(actor);
        return store
          .list(actor.tenant, undefined, 'staffAssignment')
          .some(
            (row) =>
              row.data.actorId === targetId &&
              row.data.unitId === actor.unitId &&
              decision(workforce.actor(row), action, patientId),
          );
      },
      grant(actor, patientId, target, role, expires, reason) {
        access.permit(actor, 'access.manage', patientId);
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
        const targetAssignment = store
          .list(actor.tenant, undefined, 'staffAssignment')
          .find(
            (r) =>
              r.data.actorId === target &&
              r.data.role === 'clinician' &&
              r.data.unitId === actor.unitId,
          );
        assert(targetAssignment, 403, 'No staff assignment in this unit');
        workforce.current(workforce.actor(targetAssignment));
        assert(
          expiration > new Date().toISOString() &&
            expiration <= targetAssignment.data.validUntil &&
            Date.parse(expiration) <= Date.now() + 30 * 86400000,
          422,
          'Care relationship must expire within assignment validity and 30 days',
        );
        store.transaction(() => {
          store.grant(actor.tenant, patientId, target, role, expiration);
          store.audit(actor, 'access.grant', patientId, target);
          store.insert(actor, 'careRelationship', patientId, {
            target,
            assignmentId: targetAssignment.id,
            reason: reason.trim(),
            expires: expiration,
          });
        });
      },
      block() {
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
