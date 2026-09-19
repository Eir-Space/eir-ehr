import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, Plugin, Entity } from '../packages/contracts.ts';
import { Runtime } from '../packages/runtime.ts';
import { baseApp } from '../apps/http.ts';
import { createApp } from '../apps/app.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import postgres from '../plugins/storage-postgres.ts';
import { SqliteStore } from '../plugins/storage-sqlite.ts';
import {
  orderMessage,
  payloadHash,
  protocol,
  type OrderMessage,
  type ResultMessage,
} from '../packages/integrations.ts';
import { postgresFixture } from './postgres-helpers.ts';

export const integrationRoot = fileURLToPath(new URL('../', import.meta.url));
export const sampleReport = () => ({
  collectedAt: '2026-01-01T08:00:00.000Z',
  reportedAt: '2026-01-01T09:00:00.000Z',
  results: [
    {
      name: 'P-Test',
      value: '7.1',
      unit: 'mmol/L',
      reference: 'According to test source',
      flag: 'critical' as const,
    },
  ],
});

export async function integrationFixture(
  pg = false,
  settings: Record<string, unknown> = {},
  uiPort = 0,
  overrides: (tenant: string) => Record<string, Record<string, unknown>> = () => ({}),
) {
  const directory = await mkdtemp(join(tmpdir(), 'eir-integration-test-'));
  const database = pg ? await postgresFixture() : undefined;
  const tenant = database?.configA.tenant ?? 'clinic-a';
  const extra = overrides(tenant);
  const outbound = randomBytes(32).toString('base64url'),
    inbound = randomBytes(32).toString('base64url');
  const suffix = randomBytes(5).toString('hex');
  const outboundTokenEnv = `EIR_TEST_LAB_OUT_${suffix}`,
    inboundTokenEnv = `EIR_TEST_LAB_IN_${suffix}`;
  process.env[outboundTokenEnv] = outbound;
  process.env[inboundTokenEnv] = inbound;
  const labStore = new SqliteStore(join(directory, 'lab.sqlite'));
  const labActor: Actor = { id: 'laboratory', tenant: 'test-lab', role: 'integration' };
  const lab = await baseApp(10000);
  let requests = 0;
  const behavior = {
    mode: 'accept' as
      'accept' | 'unavailable' | 'lose-ack' | 'wrong-ack' | 'reject' | 'oversized' | 'redirect',
    delayMs: 0,
    acknowledgementGate: undefined as Promise<void> | undefined,
  };
  lab.post('/orders', async (request, reply) => {
    requests++;
    assert.equal(request.headers.authorization, `Bearer ${outbound}`);
    if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
    if (behavior.mode === 'unavailable')
      return reply.code(503).send({ error: 'private-partner-details' });
    if (behavior.mode === 'redirect') return reply.redirect('/credential-leak');
    const payload = orderMessage.parse(request.body);
    assert.equal(request.headers['idempotency-key'], payload.messageId);
    assert.equal(request.headers['x-eir-payload-sha256'], payloadHash(payload));
    const acknowledgement = await labStore.transaction(async () => {
      const previous = (
        await labStore.searchEntities('test-lab', 'receivedOrder', {
          equals: { messageId: payload.messageId },
          limit: 1,
        })
      )[0];
      if (previous) {
        assert.equal(previous.data.payloadHash, payloadHash(payload));
        return previous.data.acknowledgement;
      }
      const acknowledgement = {
        protocol,
        messageId: payload.messageId,
        orderId: payload.orderId,
        patientId: payload.patientId,
        payloadHash: payloadHash(payload),
        status: behavior.mode === 'reject' ? 'rejected' : 'accepted',
      };
      await labStore.insert(labActor, 'receivedOrder', null, {
        messageId: payload.messageId,
        payload,
        payloadHash: payloadHash(payload),
        acknowledgement,
      });
      return acknowledgement;
    });
    await behavior.acknowledgementGate;
    if (behavior.mode === 'lose-ack') {
      request.raw.socket.destroy();
      return reply;
    }
    if (behavior.mode === 'wrong-ack') return { ...acknowledgement, patientId: randomUUID() };
    if (behavior.mode === 'oversized') return { data: 'x'.repeat(10000) };
    return acknowledgement;
  });
  const labUrl = await lab.listen({ host: '127.0.0.1', port: 0 });
  const connector = {
    id: 'test-lab',
    name: 'Anslutet testlaboratorium',
    tenant,
    unitId: 'demo-primary-care',
    adapter: protocol,
    endpoint: labUrl + '/orders',
    outboundTokenEnv,
    inboundTokenEnv,
    localDevelopmentOnly: true,
  };
  const config = JSON.parse(
    await readFile(new URL('../eir.demo.config.json', import.meta.url), 'utf8'),
  );
  const entries: { plugin: Plugin; config?: Record<string, unknown> }[] = [];
  for (const entry of config.plugins) {
    const plugin: Plugin =
      entry.module === './plugins/storage-sqlite.ts' && database
        ? postgres
        : (await import(new URL('../' + entry.module, import.meta.url).href)).default;
    entries.push({
      plugin,
      config:
        plugin.id === 'eir.storage.postgres'
          ? { ...database!.configA }
          : plugin.id === 'eir.storage.sqlite'
            ? { path: join(directory, 'ehr.sqlite') }
            : plugin.id === 'eir.workforce'
              ? demoWorkforce(tenant)
              : plugin.id === 'eir.integrations'
                ? {
                    connectors: [connector],
                    timeoutMs: 150,
                    leaseMs: 600,
                    retryMs: 10,
                    ...settings,
                  }
                : (extra[plugin.id] ?? entry.config),
    });
  }
  const runtimes: Runtime[] = [],
    apps: Awaited<ReturnType<typeof createApp>>[] = [],
    urls: string[] = [];
  const start = async (i: number) => {
    runtimes[i] = await new Runtime().start(entries);
    apps[i] = await createApp(runtimes[i], integrationRoot);
    urls[i] = await apps[i].listen({ host: '127.0.0.1', port: i === 0 ? uiPort : 0 });
  };
  const cleanup = async () => {
    for (const app of apps) await app.close();
    for (const runtime of runtimes) await runtime.stop();
    await lab.close();
    await labStore.close();
    await database?.cleanup();
    delete process.env[outboundTokenEnv];
    delete process.env[inboundTokenEnv];
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await start(0);
    if (pg) await start(1);
    const workforce = runtimes[0].get('workforce');
    const assignments = await workforce.forIdentity('https://local.eir.invalid', 'emma');
    const doctor = workforce.actor(assignments.find((r) => r.data.role === 'clinician')!);
    const admin = workforce.actor(assignments.find((r) => r.data.role === 'administrator')!);
    const patient = await runtimes[0].get('clinical').register(doctor, {
      name: 'Anna Lindberg',
      birthDate: '1980-01-01',
      identifier: { type: 'local', value: 'INTEGRATION-001' },
    });
    const encounter = await runtimes[0]
      .get('clinical')
      .create(doctor, patient.id, 'encounter', { reason: 'Provtagning' });
    const orderInput = () => ({
      clientId: randomUUID(),
      encounterId: encounter.id,
      connectorId: connector.id,
      test: 'Elektrolytstatus',
      question: 'Behandlingsuppföljning',
      specimen: 'Plasma',
      assigneeId: doctor.id,
      due: '2026-10-01',
      priority: 'routine',
    });
    const result = (order: Entity, changes: Partial<ResultMessage> = {}): ResultMessage => ({
      protocol,
      messageId: randomUUID(),
      orderMessageId: order.id,
      orderId: order.id,
      patientId: patient.id,
      patientIdentifier: {
        system: patient.data.identifier.system,
        value: patient.data.identifier.value,
      },
      supersedesMessageId: null,
      report: sampleReport(),
      ...changes,
    });
    const receive = async (message: ResultMessage, replica = 0, token = inbound) => {
      const response = await fetch(urls[replica] + '/integrations/test-lab/results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(message),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const api = async (actor: Actor, path: string, body?: unknown, replica = 0) => {
      const token = await runtimes[replica].get('identity').issue!(actor);
      const response = await fetch(urls[replica] + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const rows = (kind: string, replica = 0) =>
      runtimes[replica].get('store').list(tenant, undefined, kind);
    return {
      directory,
      database,
      tenant,
      connector,
      outbound,
      inbound,
      runtimes,
      apps,
      urls,
      doctor,
      admin,
      patient,
      encounter,
      behavior,
      labStore,
      labActor,
      orderInput,
      result,
      receive,
      api,
      rows,
      cleanup,
      requests: () => requests,
      restart: async (i = 0) => {
        await apps[i].close();
        await runtimes[i].stop();
        await start(i);
      },
      orders: async () =>
        (await labStore.list('test-lab', undefined, 'receivedOrder')).map(
          (r) => r.data.payload as OrderMessage,
        ),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
