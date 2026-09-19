// Local developer harness, deliberately sharing the real HTTP/SQLite test fixture.
// Never start this alongside clinical data or bind it to a public interface.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { baseApp } from '../apps/http.ts';
import { assert } from '../packages/contracts.ts';
import { protocol, resultMessage } from '../packages/integrations.ts';
import { integrationFixture } from '../tests/integration-helpers.ts';

process.umask(0o077);
const f = await integrationFixture(
  false,
  { worker: true, pollMs: 500, timeoutMs: 2000, leaseMs: 5000, retryMs: 1000 },
  Number(process.env.EIR_SANDBOX_PORT ?? 4195),
);
const panel = await baseApp(1000);
const send = async (id: string) => {
  const row = await f.labStore.get('test-lab', id);
  assert(row?.kind === 'sandboxResult', 404, 'Result not found');
  const response = await f.receive(row.data.payload);
  const current = (await f.labStore.get('test-lab', id))!;
  return f.labStore.revise(
    f.labActor,
    current,
    current.version,
    {
      ...current.data,
      receipt: response.status === 202 ? response.body : null,
      responseStatus: response.status,
      state: response.status === 202 ? 'received' : 'retry',
    },
    'sandbox.result-sent',
  );
};
panel.get('/', async (_, reply) =>
  reply
    .type('text/html')
    .send(await readFile(new URL('../apps/lab-sandbox/index.html', import.meta.url), 'utf8')),
);
panel.get('/sandbox.js', async (_, reply) =>
  reply
    .type('application/javascript')
    .send(await readFile(new URL('../apps/lab-sandbox/sandbox.js', import.meta.url), 'utf8')),
);
panel.get('/style.css', async (_, reply) =>
  reply
    .type('text/css')
    .send(await readFile(new URL('../apps/lab-sandbox/style.css', import.meta.url), 'utf8')),
);
panel.get('/workspace', async () => {
  const results = await f.labStore.list('test-lab', undefined, 'sandboxResult');
  const items = [];
  for (const r of results) {
    let state = r.data.state,
      code = null;
    if (r.data.receipt) {
      const response = await fetch(
        `${f.urls[0]}/integrations/test-lab/receipts/${r.data.payload.messageId}`,
        { headers: { authorization: `Bearer ${f.inbound}` } },
      );
      if (response.ok) {
        const receipt = (await response.json()) as any;
        state = receipt.state;
        code = receipt.code;
      }
    }
    items.push({
      id: r.id,
      orderId: r.data.payload.orderId,
      messageId: r.data.payload.messageId,
      state,
      code,
      result: r.data.payload.report.results[0],
    });
  }
  return { ehr: f.urls[0], mode: f.behavior.mode, orders: await f.orders(), results: items };
});
panel.post('/mode', async (req) => {
  f.behavior.mode = z
    .object({ mode: z.enum(['accept', 'unavailable', 'lose-ack', 'wrong-ack', 'reject']) })
    .strict()
    .parse(req.body).mode;
  return { ok: true };
});
panel.post('/orders/:id/results', async (req, reply) => {
  const order = (await f.orders()).find((o) => o.orderId === (req.params as any).id);
  assert(order, 404, 'Order not found');
  const parsed = z
    .object({
      name: z.string().min(1).max(200),
      value: z.string().min(1).max(500),
      unit: z.string().max(80),
      reference: z.string().max(200),
      flag: z.enum(['unknown', 'normal', 'high', 'low', 'critical']),
      correctionReason: z.string().max(500),
      supersedesMessageId: z.union([z.uuid(), z.literal('')]),
    })
    .strict()
    .parse(req.body);
  const { correctionReason, supersedesMessageId, ...result } = parsed;
  const at = new Date().toISOString();
  const payload = resultMessage.parse({
    protocol,
    messageId: randomUUID(),
    orderMessageId: order.messageId,
    orderId: order.orderId,
    patientId: order.patientId,
    patientIdentifier: order.patient.identifier,
    supersedesMessageId: supersedesMessageId || null,
    report: {
      collectedAt: at,
      reportedAt: at,
      results: [result],
      ...(correctionReason ? { correctionReason } : {}),
    },
  });
  const row = await f.labStore.insert(f.labActor, 'sandboxResult', null, {
    payload,
    state: 'pending',
  });
  await send(row.id);
  return reply.code(201).send({ id: row.id });
});
panel.post('/results/:id/retry', async (req) => {
  await send(z.uuid().parse((req.params as any).id));
  return { ok: true };
});
try {
  const url = await panel.listen({
    host: '127.0.0.1',
    port: Number(process.env.EIR_LAB_SANDBOX_PORT ?? 4196),
  });
  console.log(`EHR integration sandbox: ${f.urls[0]}`);
  console.log(`Laboratory console: ${url}`);
  console.log(`Local clinician session: ${await f.runtimes[0].get('identity').issue!(f.doctor)}`);
} catch (error) {
  await panel.close();
  await f.cleanup();
  throw error;
}
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await panel.close();
  await f.cleanup();
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
