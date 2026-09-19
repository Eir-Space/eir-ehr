import { randomBytes, createHash } from 'node:crypto';
import { Fault, type Plugin } from '../packages/contracts.ts';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export default {
  id: 'eir.identity.local',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['identity'],
  requires: ['store'],
  setup(ctx) {
    const store = ctx.get('store');
    ctx.provide('identity', {
      async issue(actor) {
        const token = randomBytes(32).toString('base64url');
        await store.saveSession(
          digest(token),
          actor,
          new Date(Date.now() + 8 * 3600000).toISOString(),
        );
        return token;
      },
      async authenticate(token) {
        if (!token || token.length > 2048) throw new Fault(401, 'Authentication required');
        const session = await store.session(digest(token));
        if (!session || String(session.expires) <= new Date().toISOString())
          throw new Fault(401, 'Session expired or invalid');
        return session.actor;
      },
      async revoke(token) {
        await store.revokeSession(digest(token));
      },
    });
  },
} satisfies Plugin;
