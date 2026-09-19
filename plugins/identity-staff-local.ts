import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { staffSessions } from '../packages/staff-sessions.ts';
export default {
  id: 'eir.identity.staff-local',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['identity'],
  requires: ['store', 'workforce'],
  setup(ctx, config) {
    const settings = z
      .object({ localDevelopmentOnly: z.literal(true) })
      .strict()
      .parse(config);
    void settings;
    const workforce = ctx.get('workforce'),
      store = ctx.get('store');
    const sessions = staffSessions(store, workforce, {
      idleMinutes: 15,
      absoluteHours: 8,
    });
    ctx.provide('identity', {
      ...sessions,
      async issue(actor) {
        return store.transaction(async () => {
          const assignment = await workforce.current(actor);
          return sessions.issue!(
            workforce.actor(assignment, {
              method: 'local',
              issuer: assignment.data.issuer,
              subject: assignment.data.subject,
              authenticatedAt: Math.floor(Date.now() / 1000),
            }),
          );
        });
      },
    });
  },
} satisfies Plugin;
