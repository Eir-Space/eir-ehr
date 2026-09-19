import { Fault, type Plugin, type Access } from '../packages/contracts.ts';
export default {
  id: 'eir.access',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['access'],
  requires: ['store'],
  setup(ctx) {
    const store = ctx.get('store');
    const access: Access = {
      async permit(actor, action, patientId) {
        if (patientId)
          return access.check(
            actor,
            patientId,
            action !== 'chart.read' && action !== 'chart.export',
          );
        if (actor.role !== 'clinician') throw new Fault(403, 'Clinician role required');
      },
      async allowed(actor: Parameters<typeof store.audit>[0], patientId: string, write = false) {
        const patient = await store.get(actor.tenant, patientId);
        const grant = await store.getGrant(actor.tenant, patientId, actor.id);
        const blocked = await store.isBlocked(actor.tenant, patientId);
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
      async check(actor: Parameters<typeof store.audit>[0], patientId: string, write = false) {
        const allowed = await access.allowed(actor, patientId, write);
        await store.audit(
          actor,
          write ? 'access.write' : 'access.read',
          patientId,
          undefined,
          allowed ? 'success' : 'denied',
        );
        if (!allowed)
          throw new Fault(403, 'No active care relationship or permitted patient/proxy access');
      },
      async grant(
        actor: Parameters<typeof store.audit>[0],
        patientId: string,
        target: string,
        role: 'clinician' | 'proxy',
        expires: string,
      ) {
        await access.check(actor, patientId, true);
        await store.transaction(async () => {
          await access.check(actor, patientId, true);
          if (actor.role !== 'clinician') throw new Fault(403, 'Clinician role required');
          const expiration = new Date(expires).toISOString();
          if (expiration <= new Date().toISOString())
            throw new Fault(422, 'Grant must expire in the future');
          await store.grant(actor.tenant, patientId, target, role, expiration);
          await store.audit(actor, 'access.grant', patientId, target);
        });
      },
      async block(actor: Parameters<typeof store.audit>[0], patientId: string, blocked: boolean) {
        await store.transaction(async () => {
          if (
            actor.role !== 'patient' ||
            actor.patientId !== patientId ||
            (await store.get(actor.tenant, patientId))?.kind !== 'patient'
          )
            throw new Fault(403, 'Patient self-service required');
          await store.restrict(actor.tenant, patientId, blocked);
          await store.audit(
            actor,
            blocked ? 'restriction.applied' : 'restriction.removed',
            patientId,
          );
        });
      },
    };
    ctx.provide('access', access);
  },
} satisfies Plugin;
