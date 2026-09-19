import { z } from 'zod';
import type { Plugin } from '../packages/contracts.ts';
import { staffSessions } from '../packages/staff-sessions.ts';
export default {
  id: 'eir.identity.staff-local',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['identity'],
  requires: ['store', 'workforce'],
  setup(ctx, config) {
    const settings = z
      .object({ localDevelopmentOnly: z.literal(true) })
      .strict()
      .parse(config);
    void settings;
    const workforce = ctx.get('workforce');
    const sessions = staffSessions(ctx.get('store'), workforce, {
      idleMinutes: 15,
      absoluteHours: 8,
    });
    ctx.provide('identity', {
      ...sessions,
      issue(actor) {
        const assignment = workforce.current(actor);
        return sessions.issue!(
          workforce.actor(assignment, {
            method: 'local',
            issuer: assignment.data.issuer,
            subject: assignment.data.subject,
            authenticatedAt: Math.floor(Date.now() / 1000),
          }),
        );
      },
    });
  },
} satisfies Plugin;
