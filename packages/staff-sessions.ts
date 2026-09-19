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
  // Return failures from the unit of work so revocation and its audit commit before rejection.
  const authenticateSession = async (token: string): Promise<Actor | Fault> => {
    assert(/^[A-Za-z0-9_-]{43}$/.test(token), 401, 'Authentication required');
    const hash = tokenHash(token);
    const session = await store.session(hash);
    if (
      !session ||
      Date.parse(session.expires) <= Date.now() ||
      Date.parse(session.lastSeen) + options.idleMinutes * 60000 <= Date.now()
    ) {
      await store.revokeSession(hash);
      return new Fault(401, 'Session expired');
    }
    try {
      await workforce.current(session.actor);
    } catch {
      await store.revokeSession(hash);
      await store.audit(
        session.actor,
        'session.assignment-revoked',
        undefined,
        undefined,
        'denied',
      );
      return new Fault(401, 'Staff assignment has expired or been revoked');
    }
    await store.updateSession(hash, session.actor);
    return session.actor;
  };
  const identity: Identity = {
    async issue(actor) {
      return store.transaction(async () => {
        await workforce.current(actor);
        const token = randomBytes(32).toString('base64url');
        await store.saveSession(
          tokenHash(token),
          actor,
          new Date(Date.now() + options.absoluteHours * 3600000).toISOString(),
        );
        await store.audit(actor, 'session.started');
        return token;
      });
    },
    async authenticate(token) {
      const result = await store.transaction(async () => authenticateSession(token));
      if (result instanceof Fault) throw result;
      return result;
    },
    async select(token, assignmentId) {
      const result = await store.transaction(async () => {
        const actor = await authenticateSession(token);
        if (actor instanceof Fault) return actor;
        const assignment = (await workforce.assignments(actor)).find((a) => a.id === assignmentId);
        assert(assignment, 403, 'Assignment is unavailable');
        const selected = workforce.actor(assignment, actor.authentication);
        await store.updateSession(tokenHash(token), selected);
        await store.audit(selected, 'session.assignment-selected');
        return selected;
      });
      if (result instanceof Fault) throw result;
      return result;
    },
    async revoke(token) {
      await store.transaction(async () => {
        const session = await store.session(tokenHash(token));
        if (session) await store.audit(session.actor, 'session.ended');
        await store.revokeSession(tokenHash(token));
      });
    },
  };
  return identity;
}
