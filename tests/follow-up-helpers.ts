import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { baseApp } from '../apps/http.ts';
import { integrationFixture } from './integration-helpers.ts';
import { notificationMessage } from '../packages/follow-up.ts';
import { payloadHash } from '../packages/integrations.ts';

export async function followUpFixture(
  pg = false,
  port = 0,
  embedded = false,
  overrides: (tenant: string) => Record<string, Record<string, unknown>> = () => ({}),
) {
  const gateway = await baseApp(10000),
    token = randomBytes(32).toString('base64url');
  const env = `EIR_TEST_NOTIFY_${randomBytes(5).toString('hex')}`;
  process.env[env] = token;
  const messages = new Map<string, any>(),
    attempts: any[] = [];
  const behavior = { mode: 'accept', gate: undefined as Promise<void> | undefined };
  gateway.post('/notify', async (request, reply) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const message = notificationMessage.parse(request.body);
    assert.equal(request.headers['idempotency-key'], message.messageId);
    assert.equal(request.headers['x-eir-payload-sha256'], payloadHash(message));
    attempts.push(message);
    if (behavior.mode === 'fail')
      return reply.code(503).send({ error: 'private gateway diagnostic' });
    const ack = {
      messageId: message.messageId,
      payloadHash: payloadHash(message),
      status: 'accepted',
    };
    if (messages.has(message.messageId)) assert.deepEqual(messages.get(message.messageId), message);
    messages.set(message.messageId, message);
    await behavior.gate;
    if (behavior.mode === 'lose-ack') {
      request.raw.socket.destroy();
      return reply;
    }
    if (behavior.mode === 'wrong-ack') return { ...ack, payloadHash: 'wrong' };
    if (behavior.mode === 'oversized') return { content: 'x'.repeat(3000) };
    return ack;
  });
  const endpoint = await gateway.listen({ port: 0, host: '127.0.0.1' });
  let f: Awaited<ReturnType<typeof integrationFixture>>;
  try {
    f = await integrationFixture(pg, {}, port, (tenant) => ({
      'eir.notifications.http': {
        endpoint: endpoint + '/notify',
        tokenEnv: env,
        localDevelopmentOnly: true,
        timeoutMs: 2000,
      },
      'eir.follow-up': {
        worker: embedded,
        pollMs: 500,
        retryMs: 10,
        maxAttempts: 2,
        routes: ['demo-clinician', 'demo-colleague', 'demo-nurse'].map((actorId) => ({
          tenant,
          unitId: 'demo-primary-care',
          actorId,
          recipient: `opaque-${actorId}`,
        })),
      },
      ...overrides(tenant),
    }));
  } catch (e) {
    await gateway.close();
    delete process.env[env];
    throw e;
  }
  const create = async (expectedAt = new Date(Date.now() - 60000).toISOString()) => {
    const { connectorId, ...input } = f.orderInput();
    const order = await f.runtimes[0]
      .get('laboratories')
      .order(f.doctor, f.patient.id, { ...input, expectedAt });
    const task = (await f.rows('task')).find((r) => r.data.linkedOrderId === order.id)!;
    return { order, task };
  };
  const colleague = f.runtimes[0]
    .get('workforce')
    .actor(
      (await f.runtimes[0].get('workforce').forIdentity('https://local.eir.invalid', 'linnea'))[0],
    );
  return {
    ...f,
    colleague,
    create,
    behavior,
    messages,
    attempts,
    notificationEndpoint: endpoint,
    cleanup: async () => {
      await f.cleanup();
      await gateway.close();
      delete process.env[env];
    },
  };
}
