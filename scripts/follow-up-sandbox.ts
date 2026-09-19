// Synthetic, loopback-only developer harness using real HTTP and SQLite services.
import { randomUUID } from 'node:crypto';
import { followUpFixture } from '../tests/follow-up-helpers.ts';
import { sampleReport } from '../tests/integration-helpers.ts';

process.umask(0o077);
const port = Number(process.env.EIR_FOLLOW_UP_PORT ?? 4197);
const f = await followUpFixture(false, port, true, (tenant) => ({
  'eir.follow-up': {
    worker: true,
    pollMs: 1000,
    retryMs: 1000,
    maxAttempts: 3,
    workspaceUrl: `http://127.0.0.1:${port}/`,
    routes: ['demo-clinician', 'demo-colleague', 'demo-nurse'].map((actorId) => ({
      tenant,
      unitId: 'demo-primary-care',
      actorId,
      recipient: `local-${actorId}`,
    })),
  },
}));
try {
  const runtime = f.runtimes[0];
  await f.create();
  const { order } = await f.create(new Date(Date.now() + 3600000).toISOString());
  const at = new Date().toISOString();
  await runtime.get('laboratories').receive(f.doctor, order.id, order.version, {
    ...sampleReport(),
    collectedAt: at,
    reportedAt: at,
    source: 'Lokalt testlaboratorium',
    messageId: randomUUID(),
  });
  await runtime.get('careTeam').createTask(f.doctor, f.patient.id, {
    title: 'Planerad telefonuppföljning',
    due: at.slice(0, 10),
    dueAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await runtime
    .get('access')
    .grant(
      f.doctor,
      f.patient.id,
      f.colleague.id,
      'clinician',
      new Date(Date.now() + 86400000).toISOString(),
      'Synthetic covering care relationship',
    );
  await runtime.get('followUp').runOnce();
  console.log(`Follow-up sandbox: ${f.urls[0]}`);
  console.log(`Local clinician session: ${await runtime.get('identity').issue!(f.doctor)}`);
  console.log(
    'Notifications go only to the in-process loopback test gateway. Records reset on restart.',
  );
} catch (error) {
  await f.cleanup();
  throw error;
}
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await f.cleanup();
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
