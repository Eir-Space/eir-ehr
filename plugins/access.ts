import { Fault, type Plugin } from '../packages/contracts.ts';
export default {
  id: 'eir.access',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['access'],
  requires: ['store'],
  setup(ctx) {
    const store = ctx.get('store');
    const access = {
      allowed(actor: Parameters<typeof store.audit>[0], patientId: string, write = false) {
        const patient = store.get(actor.tenant, patientId);
        const grant = store.getGrant(actor.tenant, patientId, actor.id);
        const blocked = store.isBlocked(actor.tenant, patientId);
        const self = actor.role === 'patient' && actor.patientId === patientId;
        const assigned =
          grant && grant.role === actor.role && String(grant.expires) > new Date().toISOString();
        return Boolean(
          patient?.kind === 'patient' &&
          ((self && !write) ||
            (!blocked &&
              assigned &&
              (actor.role === 'clinician' || (actor.role === 'proxy' && !write)))),
        );
      },
      check(actor: Parameters<typeof store.audit>[0], patientId: string, write = false) {
        const allowed = access.allowed(actor, patientId, write);
        store.audit(
          actor,
          write ? 'access.write' : 'access.read',
          patientId,
          undefined,
          allowed ? 'success' : 'denied',
        );
        if (!allowed)
          throw new Fault(403, 'No active care relationship or permitted patient/proxy access');
      },
      grant(
        actor: Parameters<typeof store.audit>[0],
        patientId: string,
        target: string,
        role: 'clinician' | 'proxy',
        expires: string,
      ) {
        access.check(actor, patientId, true);
        if (actor.role !== 'clinician') throw new Fault(403, 'Clinician role required');
        const expiration = new Date(expires).toISOString();
        if (expiration <= new Date().toISOString())
          throw new Fault(422, 'Grant must expire in the future');
        store.transaction(() => {
          store.grant(actor.tenant, patientId, target, role, expiration);
          store.audit(actor, 'access.grant', patientId, target);
        });
      },
      block(actor: Parameters<typeof store.audit>[0], patientId: string, blocked: boolean) {
        if (
          actor.role !== 'patient' ||
          actor.patientId !== patientId ||
          store.get(actor.tenant, patientId)?.kind !== 'patient'
        )
          throw new Fault(403, 'Patient self-service required');
        store.transaction(() => {
          store.restrict(actor.tenant, patientId, blocked);
          store.audit(actor, blocked ? 'restriction.applied' : 'restriction.removed', patientId);
        });
      },
    };
    ctx.provide('access', access);
  },
} satisfies Plugin;
