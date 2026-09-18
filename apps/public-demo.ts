import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { assert, Fault } from '../packages/contracts.ts';
import { fromConfig, type Runtime } from '../packages/runtime.ts';
import { createApp } from './app.ts';
import { baseApp, webFiles } from './http.ts';
import { seedDemo } from './seed.ts';

type Workspace = {
  app: FastifyInstance;
  runtime: Runtime;
  expires: number;
  requests: number;
  writes: number;
  bytes: number;
};
export type DemoLimits = {
  now?: () => number;
  ttl?: number;
  capacity?: number;
  requests?: number;
  writes?: number;
  bytes?: number;
  allowedOrigins?: string[];
};
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createPublicDemo(root: string, limits: DemoLimits = {}) {
  const now = limits.now ?? Date.now;
  const ttl = limits.ttl ?? 30 * 60000;
  const capacity = limits.capacity ?? 20;
  const workspaces = new Map<string, Workspace>();
  let pending = 0;
  const app = await baseApp(600, 32 * 1024, limits.allowedOrigins);
  const retire = async (key: string, workspace: Workspace) => {
    workspaces.delete(key);
    await workspace.app.close();
    workspace.runtime.stop();
  };
  const prune = async () => {
    for (const [key, workspace] of workspaces) {
      if (workspace.expires <= now()) await retire(key, workspace);
    }
  };
  const timer = setInterval(() => {
    void prune().catch(() => console.error('Demo workspace cleanup failed'));
  }, 60000).unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const [key, workspace] of workspaces) await retire(key, workspace);
  });
  app.get('/deployment.json', async () => ({ mode: 'public-demo', ttlMinutes: ttl / 60000 }));
  app.post(
    '/demo/start',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      z.object({ syntheticOnly: z.literal(true) })
        .strict()
        .parse(req.body);
      await prune();
      assert(
        workspaces.size + pending < capacity,
        503,
        'The demo is busy. Please try again later or run it locally.',
      );
      pending++;
      let runtime: Runtime | undefined;
      let inner: FastifyInstance | undefined;
      try {
        // This separate profile never reads the local persistent clinical database.
        const loaded = await fromConfig(resolve(root, 'eir.demo.config.json'));
        runtime = loaded.runtime;
        const actor = { id: 'demo-clinician', tenant: randomUUID(), role: 'clinician' as const };
        seedDemo(runtime, actor);
        const token = runtime.get('identity').issue!(actor);
        inner = await createApp(
          runtime,
          root,
          loaded.config.chartRenderers,
          loaded.config.defaultRenderer,
        );
        await inner.ready();
        const expires = now() + ttl;
        workspaces.set(digest(token), {
          app: inner,
          runtime,
          expires,
          requests: 0,
          writes: 0,
          bytes: 0,
        });
        return reply.code(201).send({ token, expiresAt: new Date(expires).toISOString() });
      } catch (error) {
        await inner?.close();
        runtime?.stop();
        throw error;
      } finally {
        pending--;
      }
    },
  );
  app.all('/api/*', async (req, reply) => {
    const auth = req.headers.authorization;
    assert(auth, 401, 'Start a new demo session');
    assert(auth.startsWith('Bearer ') && auth.length < 256, 401, 'Start a new demo session');
    const key = digest(auth.slice(7));
    const workspace = workspaces.get(key);
    assert(workspace, 401, 'Start a new demo session');
    if (workspace.expires <= now()) {
      await retire(key, workspace);
      throw new Fault(401, 'This temporary demo has expired. Start a new session.');
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/logout') {
      await retire(key, workspace);
      return { ok: true };
    }
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    workspace.requests++;
    workspace.bytes += Buffer.byteLength(payload ?? '');
    if (write) workspace.writes++;
    assert(
      workspace.requests <= (limits.requests ?? 400) &&
        workspace.writes <= (limits.writes ?? 60) &&
        workspace.bytes <= (limits.bytes ?? 256 * 1024),
      429,
      'Demo allowance reached. Start a new session or run it locally.',
    );
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/patients') {
      assert(
        (req.body as { identifier?: { type?: string } })?.identifier?.type === 'local',
        422,
        'Use a made-up local ID in the public demo, never a real national identifier.',
      );
    }
    const response = await workspace.app.inject({
      method: req.method as 'GET' | 'POST' | 'HEAD' | 'OPTIONS',
      url: req.url,
      headers: { authorization: auth, ...(payload ? { 'content-type': 'application/json' } : {}) },
      payload,
    });
    return reply
      .code(response.statusCode)
      .type(String(response.headers['content-type'] ?? 'application/json'))
      .send(response.body);
  });
  await webFiles(app, root);
  return app;
}
