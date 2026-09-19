import { createHash, randomBytes } from 'node:crypto';
import {
  assert,
  Fault,
  type Actor,
  type Identity,
  type Store,
  type Workforce,
} from './contracts.ts';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function staffSessions(
  store: Store,
  workforce: Workforce,
  options: { idleMinutes: number; absoluteHours: number },
) {
  const identity: Identity = {
    issue(actor) {
      workforce.current(actor);
      const token = randomBytes(32).toString('base64url');
      store.saveSession(
        tokenHash(token),
        actor,
        new Date(Date.now() + options.absoluteHours * 3600000).toISOString(),
      );
      store.audit(actor, 'session.started');
      return token;
    },
    async authenticate(token) {
      assert(/^[A-Za-z0-9_-]{43}$/.test(token), 401, 'Authentication required');
      const session = store.session(tokenHash(token));
      if (
        !session ||
        Date.parse(session.expires) <= Date.now() ||
        Date.parse(session.lastSeen) + options.idleMinutes * 60000 <= Date.now()
      ) {
        store.revokeSession(tokenHash(token));
        throw new Fault(401, 'Session expired');
      }
      try {
        workforce.current(session.actor);
      } catch {
        store.revokeSession(tokenHash(token));
        store.audit(session.actor, 'session.assignment-revoked', undefined, undefined, 'denied');
        throw new Fault(401, 'Staff assignment has expired or been revoked');
      }
      store.updateSession(tokenHash(token), session.actor);
      return session.actor;
    },
    async select(token, assignmentId) {
      const actor = await identity.authenticate(token);
      const assignment = workforce.assignments(actor).find((a) => a.id === assignmentId);
      assert(assignment, 403, 'Assignment is unavailable');
      const selected = workforce.actor(assignment, actor.authentication);
      store.updateSession(tokenHash(token), selected);
      store.audit(selected, 'session.assignment-selected');
      return selected;
    },
    revoke(token) {
      const session = store.session(tokenHash(token));
      if (session) store.audit(session.actor, 'session.ended');
      store.revokeSession(tokenHash(token));
    },
  };
  return identity;
}
