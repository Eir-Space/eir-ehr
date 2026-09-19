import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Fault, assert, type Actor } from '../packages/contracts.ts';
import type { Runtime } from '../packages/runtime.ts';
import { vitals } from '../plugins/clinical.ts';
import { openApi } from '../packages/openapi.ts';
import { baseApp, webFiles } from './http.ts';
import { visibleRecord } from '../packages/visibility.ts';
import cookie from '@fastify/cookie';
const uuid = z.uuid();
const version = z.number().int().positive();
export async function createApp(
  runtime: Runtime,
  root: string,
  rendererIds = ['timeline', 'table'],
  defaultRenderer = rendererIds[0],
) {
  const clinical = runtime.get('clinical'),
    identity = runtime.get('identity'),
    store = runtime.get('store');
  const app = await baseApp(240, 128 * 1024, identity.browser ? [identity.browser.origin] : []);
  await app.register(cookie);
  app.get('/ready', async (_req, reply) => {
    try {
      await store.health();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  const actors = new WeakMap<FastifyRequest, Actor>();
  const actor = (request: FastifyRequest) => {
    const a = actors.get(request);
    assert(a, 401, 'Authentication required');
    return a;
  };
  const browser = identity.browser;
  const secureCookies = !!browser?.origin.startsWith('https:');
  const sessionCookie = secureCookies ? '__Host-eir-session' : 'eir-session';
  const flowCookie = secureCookies ? '__Host-eir-login' : 'eir-login';
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict' as const,
    path: '/',
  };
  const tokenFor = (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    assert(!auth, 401, 'Unsupported authentication scheme');
    return browser ? (req.cookies[sessionCookie] ?? '') : '';
  };
  app.get('/deployment.json', async () => ({
    mode: 'local',
    authentication: browser ? 'oidc' : 'local',
    workforce: runtime.has('workforce'),
  }));
  if (browser) {
    app.get('/auth/login', async (_, reply) => {
      const { url, binding } = await browser.begin();
      return reply
        .setCookie(flowCookie, binding, { ...cookieOptions, sameSite: 'lax', maxAge: 300 })
        .redirect(url);
    });
    app.get('/auth/callback', async (req, reply) => {
      reply.clearCookie(flowCookie, { ...cookieOptions, sameSite: 'lax' });
      const token = await browser.callback(
        new URL(req.url, browser.origin),
        req.cookies[flowCookie] ?? '',
      );
      const previous = req.cookies[sessionCookie];
      if (previous) await identity.revoke?.(previous);
      return reply.setCookie(sessionCookie, token, cookieOptions).redirect('/');
    });
  }
  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request) => {
        if (
          browser &&
          !request.headers.authorization?.startsWith('Bearer ') &&
          !['GET', 'HEAD'].includes(request.method)
        )
          assert(request.headers.origin === browser.origin, 403, 'Same-origin request required');
        actors.set(request, await identity.authenticate(tokenFor(request)));
      });
      api.addHook('onError', async (req, _reply, error) => {
        const a = actors.get(req);
        if (a && error instanceof Fault && error.status === 403)
          await store.audit(a, 'request.denied', undefined, undefined, 'denied');
      });
      api.get('/session', async (req) => ({
        actor: actor(req),
        country: runtime.get('country').code,
        locale: runtime.get('country').locale,
        vitals,
        renderers: rendererIds,
        defaultRenderer,
        authorization: (await runtime.get('access').context?.(actor(req))) ?? null,
        assignments: runtime.has('workforce')
          ? (await runtime.get('workforce').assignments(actor(req))).map((row) => ({
              id: row.id,
              unitId: row.data.unitId,
              role: row.data.role,
              name:
                runtime.get('workforce').units.find((u) => u.id === row.data.unitId)?.name ??
                row.data.unitId,
            }))
          : [],
        careTeam:
          actor(req).role === 'clinician'
            ? {
                members: await runtime.get('careTeam').members(actor(req)),
                timeZone: runtime.get('careTeam').timeZone,
              }
            : null,
      }));
      api.get('/care-team', async (req) => {
        const query = z.object({ day: z.iso.date() }).strict().parse(req.query);
        return await runtime.get('careTeam').workspace(actor(req), query.day);
      });
      api.post('/patients/:id/appointments', async (req, reply) =>
        reply
          .code(201)
          .send(
            await runtime
              .get('careTeam')
              .book(actor(req), uuid.parse((req.params as any).id), req.body),
          ),
      );
      api.post('/appointments/:id/:action', async (req) => {
        const body = z
          .object({ version, data: z.unknown().default({}) })
          .strict()
          .parse(req.body);
        return await runtime
          .get('careTeam')
          .appointment(
            actor(req),
            uuid.parse((req.params as any).id),
            (req.params as any).action,
            body.version,
            body.data,
          );
      });
      api.post('/logout', async (req, reply) => {
        await identity.revoke?.(tokenFor(req));
        if (browser) reply.clearCookie(sessionCookie, cookieOptions);
        return { ok: true };
      });
      if (runtime.has('workforce')) {
        api.post('/session/assignment', async (req) => {
          const { assignmentId } = z.object({ assignmentId: uuid }).strict().parse(req.body);
          assert(identity.select, 409, 'Assignment selection unavailable');
          return await identity.select(tokenFor(req), assignmentId);
        });
        api.get('/workforce', async (req) => await runtime.get('workforce').staff(actor(req)));
        api.post('/workforce', async (req, reply) =>
          reply.code(201).send(await runtime.get('workforce').create(actor(req), req.body)),
        );
        api.post('/workforce/:id', async (req) => {
          const body = z.object({ version, data: z.unknown() }).strict().parse(req.body);
          return await runtime
            .get('workforce')
            .update(actor(req), uuid.parse((req.params as any).id), body.version, body.data);
        });
      }
      if (runtime.has('accessReview')) {
        api.get(
          '/access-review',
          async (req) => await runtime.get('accessReview').list(actor(req), req.query),
        );
        api.post('/access-review', async (req, reply) =>
          reply.code(201).send(await runtime.get('accessReview').review(actor(req), req.body)),
        );
        api.post('/patients/:id/emergency-access', async (req, reply) =>
          reply
            .code(201)
            .send(
              await runtime
                .get('accessReview')
                .emergency(actor(req), uuid.parse((req.params as any).id), req.body),
            ),
        );
        api.post('/patients/:id/protection', async (req) => {
          const body = z.object({ version, data: z.unknown() }).strict().parse(req.body);
          return await runtime
            .get('accessReview')
            .protect(actor(req), uuid.parse((req.params as any).id), body.version, body.data);
        });
      }
      api.get('/plugins', async () => runtime.active);
      api.get('/openapi.json', async () => openApi(runtime.has('workforce'), secureCookies));
      api.get('/terminology/diagnoses', async (req) => {
        const query = z
          .object({
            q: z.string().trim().max(100).default(''),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          })
          .strict()
          .parse(req.query);
        const terminology = runtime.get('terminology');
        return { ...terminology.search(query.q, query.limit), source: terminology.source };
      });
      api.get('/patients', async (req) => await clinical.patients(actor(req)));
      api.post('/patients', async (req, reply) =>
        reply.code(201).send(await clinical.register(actor(req), req.body)),
      );
      api.get(
        '/patients/:id/chart',
        async (req) => await clinical.chart(actor(req), uuid.parse((req.params as any).id)),
      );
      api.get('/patients/:id/permissions', async (req) => {
        const patientId = uuid.parse((req.params as any).id),
          a = actor(req),
          access = runtime.get('access');
        await access.check(a, patientId);
        return access.context?.(a, patientId) ?? null;
      });
      api.get(
        '/patients/:id/medications',
        async (req) =>
          await runtime.get('medications').list(actor(req), uuid.parse((req.params as any).id)),
      );
      api.post('/patients/:id/medications', async (req, reply) =>
        reply
          .code(201)
          .send(
            await runtime
              .get('medications')
              .add(actor(req), uuid.parse((req.params as any).id), req.body),
          ),
      );
      api.post('/patients/:id/medication-reviews', async (req, reply) =>
        reply
          .code(201)
          .send(
            await runtime
              .get('medications')
              .reconcile(actor(req), uuid.parse((req.params as any).id), req.body),
          ),
      );
      api.post('/medications/:id', async (req) => {
        const body = z.object({ version, data: z.unknown() }).strict().parse(req.body);
        return await runtime
          .get('medications')
          .update(actor(req), uuid.parse((req.params as any).id), body.version, body.data);
      });
      api.post('/patients/:id/lab-orders', async (req, reply) =>
        reply
          .code(201)
          .send(
            await runtime
              .get('laboratories')
              .order(actor(req), uuid.parse((req.params as any).id), req.body),
          ),
      );
      for (const action of ['receive', 'review', 'cancel'] as const) {
        api.post(`/lab-orders/:id/${action}`, async (req) => {
          const body = z.object({ version, data: z.unknown() }).strict().parse(req.body);
          return await runtime
            .get('laboratories')
            [action](actor(req), uuid.parse((req.params as any).id), body.version, body.data);
        });
      }
      api.post('/patients/:id/records/:kind', async (req, reply) =>
        reply
          .code(201)
          .send(
            await clinical.create(
              actor(req),
              uuid.parse((req.params as any).id),
              (req.params as any).kind,
              req.body,
            ),
          ),
      );
      api.post('/records/:id/:action', async (req) => {
        const body = z
          .object({ version, data: z.unknown().default({}) })
          .strict()
          .parse(req.body);
        return await clinical.transition(
          actor(req),
          uuid.parse((req.params as any).id),
          (req.params as any).action,
          body.version,
          body.data,
        );
      });
      api.get(
        '/records/:id/history',
        async (req) => await clinical.history(actor(req), uuid.parse((req.params as any).id)),
      );
      api.get('/patients/:id/changes', async (req) =>
        store.transaction(async () => {
          const a = actor(req),
            patientId = uuid.parse((req.params as any).id);
          await runtime.get('access').check(a, patientId);
          const after = z.coerce
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .parse((req.query as any).after ?? 0);
          const rows = await store.changes(a.tenant, patientId, after);
          const entries = rows.filter(({ record }) => visibleRecord(a, record));
          return { entries, nextCursor: rows.length ? Number(rows.at(-1)!.cursor) : after };
        }),
      );
      api.get('/patients/:id/export/fhir', async (req, reply) => {
        reply.type('application/fhir+json');
        return await runtime.get('fhir').bundle(actor(req), uuid.parse((req.params as any).id));
      });
      api.post('/patients/:id/ai', async (req) => {
        const body = z.object({ encounterId: uuid }).strict().parse(req.body);
        return await runtime
          .get('aiReview')
          .propose(actor(req), uuid.parse((req.params as any).id), body.encounterId);
      });
      api.post('/proposals/:id/review', async (req) => {
        const body = z
          .object({
            version,
            decision: z.enum(['accept', 'reject']),
            text: z.string().max(20000).optional(),
          })
          .strict()
          .parse(req.body);
        return await runtime
          .get('aiReview')
          .review(
            actor(req),
            uuid.parse((req.params as any).id),
            body.version,
            body.decision,
            body.text,
          );
      });
      api.post('/patients/:id/access', async (req) => {
        const body = z
          .object({
            actorId: z.string().min(1).max(100),
            role: z.enum(['clinician', 'proxy']),
            expires: z.iso.datetime({ offset: true }),
            reason: z.string().trim().min(1).max(200).optional(),
          })
          .strict()
          .parse(req.body);
        await runtime
          .get('access')
          .grant(
            actor(req),
            uuid.parse((req.params as any).id),
            body.actorId,
            body.role,
            body.expires,
            body.reason,
          );
        return { ok: true };
      });
      api.post('/patients/:id/restriction', async (req) => {
        const { blocked } = z.object({ blocked: z.boolean() }).strict().parse(req.body);
        await runtime.get('access').block(actor(req), uuid.parse((req.params as any).id), blocked);
        return { ok: true };
      });
      api.get('/audit', async (req) => {
        const a = actor(req);
        assert(!runtime.has('workforce'), 403, 'Use the unit-scoped access review service');
        assert(
          a.role === 'auditor' || a.role === 'patient',
          403,
          'Auditor or patient role required',
        );
        await store.audit(a, 'audit.read', a.patientId);
        return {
          verification: await store.verifyAudit(),
          entries: await store.auditEntries(
            a.tenant,
            a.role === 'patient' ? (a.patientId ?? '') : undefined,
          ),
        };
      });
    },
    { prefix: '/api' },
  );
  await webFiles(app, root);
  return app;
}
