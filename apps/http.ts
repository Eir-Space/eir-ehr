import Fastify, { type FastifyInstance } from 'fastify';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { Fault } from '../packages/contracts.ts';

export async function baseApp(max = 240, bodyLimit = 128 * 1024, allowedOrigins: string[] = []) {
  const app = Fastify({ logger: false, bodyLimit, requestTimeout: 15000 });
  await app.register(rateLimit, { max, timeWindow: '1 minute' });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}` &&
      !allowedOrigins.includes(req.headers.origin)
    )
      throw new Fault(403, 'Cross-origin request rejected');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(422).send({
        error: 'Invalid input',
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (error instanceof Fault) return reply.code(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: 'Request rejected' });
    return reply.code(500).send({ error: 'Operation failed', requestId: req.id });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

export async function webFiles(app: FastifyInstance, root: string) {
  await app.register(staticFiles, {
    root: resolve(root, 'apps/web'),
    prefix: '/',
    index: ['index.html'],
    list: false,
  });
  app.get('/icons.js', async (_, reply) =>
    reply
      .type('application/javascript')
      .sendFile('lucide.js', resolve(root, 'node_modules/lucide/dist/umd')),
  );
}
