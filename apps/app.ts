import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Fault, assert, type Actor } from '../packages/contracts.ts';
import type { Runtime } from '../packages/runtime.ts';
import { vitals } from '../plugins/clinical.ts';
import { openApi } from '../packages/openapi.ts';
import { baseApp, webFiles } from './http.ts';

const uuid = z.uuid();
const version = z.number().int().positive();
export async function createApp(
  runtime: Runtime,
  root: string,
  rendererIds = ['timeline', 'table'],
  defaultRenderer = rendererIds[0],
) {
  const app = await baseApp();
  const clinical = runtime.get('clinical'),
    identity = runtime.get('identity'),
    store = runtime.get('store');
  const actors = new WeakMap<FastifyRequest, Actor>();
  const actor = (request: FastifyRequest) => {
    const a = actors.get(request);
    assert(a, 401, 'Authentication required');
    return a;
  };
  app.get('/deployment.json', async () => ({ mode: 'local' }));
  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request) => {
        const auth = request.headers.authorization;
        if (!auth?.startsWith('Bearer ')) throw new Fault(401, 'Authentication required');
        actors.set(request, await identity.authenticate(auth.slice(7)));
      });
      api.get('/session', async (req) => ({
        actor: actor(req),
        country: runtime.get('country').code,
        locale: runtime.get('country').locale,
        vitals,
        renderers: rendererIds,
        defaultRenderer,
      }));
      api.post('/logout', async (req) => {
        identity.revoke?.(req.headers.authorization!.slice(7));
        return { ok: true };
      });
      api.get('/plugins', async () => runtime.active);
      api.get('/openapi.json', async () => openApi());
      api.get('/patients', async (req) => clinical.patients(actor(req)));
      api.post('/patients', async (req, reply) =>
        reply.code(201).send(clinical.register(actor(req), req.body)),
      );
      api.get('/patients/:id/chart', async (req) =>
        clinical.chart(actor(req), uuid.parse((req.params as any).id)),
      );
      api.post('/patients/:id/records/:kind', async (req, reply) =>
        reply
          .code(201)
          .send(
            clinical.create(
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
        return clinical.transition(
          actor(req),
          uuid.parse((req.params as any).id),
          (req.params as any).action,
          body.version,
          body.data,
        );
      });
      api.get('/records/:id/history', async (req) =>
        clinical.history(actor(req), uuid.parse((req.params as any).id)),
      );
      api.get('/patients/:id/changes', async (req) => {
        const a = actor(req),
          patientId = uuid.parse((req.params as any).id);
        runtime.get('access').check(a, patientId);
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse((req.query as any).after ?? 0);
        const rows = store.changes(a.tenant, patientId, after);
        const entries = rows.filter(
          ({ record }) =>
            a.role === 'clinician' ||
            (record.kind !== 'proposal' &&
              (record.kind !== 'note' || record.data.status === 'signed')),
        );
        return { entries, nextCursor: rows.length ? Number(rows.at(-1)!.cursor) : after };
      });
      api.get('/patients/:id/export/fhir', async (req, reply) => {
        reply.type('application/fhir+json');
        return runtime.get('fhir').bundle(actor(req), uuid.parse((req.params as any).id));
      });
      api.post('/patients/:id/ai', async (req) => {
        const body = z.object({ encounterId: uuid }).strict().parse(req.body);
        return runtime
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
        return runtime
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
          })
          .strict()
          .parse(req.body);
        runtime
          .get('access')
          .grant(
            actor(req),
            uuid.parse((req.params as any).id),
            body.actorId,
            body.role,
            body.expires,
          );
        return { ok: true };
      });
      api.post('/patients/:id/restriction', async (req) => {
        const { blocked } = z.object({ blocked: z.boolean() }).strict().parse(req.body);
        runtime.get('access').block(actor(req), uuid.parse((req.params as any).id), blocked);
        return { ok: true };
      });
      api.get('/audit', async (req) => {
        const a = actor(req);
        assert(
          a.role === 'auditor' || a.role === 'patient',
          403,
          'Auditor or patient role required',
        );
        store.audit(a, 'audit.read', a.patientId);
        return {
          verification: store.verifyAudit(),
          entries: store.auditEntries(
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
