import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  postgresFixture,
  postgresTestOptions,
  identifier,
  dropTestDatabase,
} from './postgres-helpers.ts';
import { Runtime } from '../packages/runtime.ts';
import type { Plugin } from '../packages/contracts.ts';
import postgres from '../plugins/storage-postgres.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { createPostgresBackup, restorePostgresBackup } from '../packages/backup.ts';
import { root } from './helpers.ts';

test(
  'postgres: encrypted recovery restores the real EHR, its clinical workflow and RLS without reviving sessions',
  {
    ...postgresTestOptions,
    timeout: 120000,
  },
  async (t) => {
    const f = await postgresFixture();
    const recoveryName = 'eir_recovery_' + randomBytes(8).toString('hex');
    const directory = await mkdtemp(join(tmpdir(), 'eir-real-recovery-'));
    const restoredEnv = 'EIR_RECOVERY_' + randomBytes(8).toString('hex');
    const runtimes: Runtime[] = [];
    t.after(async () => {
      for (const runtime of runtimes) await runtime.stop();
      await dropTestDatabase(f.root, recoveryName);
      await f.cleanup();
      delete process.env[restoredEnv];
      await rm(directory, { recursive: true, force: true });
    });
    const composition = JSON.parse(await readFile(join(root, 'eir.demo.config.json'), 'utf8'));
    const start = async (config = f.configA) => {
      const entries = [];
      for (const entry of composition.plugins) {
        const plugin: Plugin = entry.module.endsWith('storage-sqlite.ts')
          ? postgres
          : (await import(pathToFileURL(join(root, entry.module)).href)).default;
        entries.push({
          plugin,
          config:
            plugin.id === 'eir.storage.postgres'
              ? config
              : plugin.id === 'eir.workforce'
                ? demoWorkforce(config.tenant)
                : entry.config,
        });
      }
      const runtime = await new Runtime().start(entries);
      runtimes.push(runtime);
      return runtime;
    };
    const runtime = await start();
    const workforce = runtime.get('workforce');
    const doctor = workforce.actor(
      (await workforce.forIdentity('https://local.eir.invalid', 'emma')).find(
        (r) => r.data.role === 'clinician',
      )!,
    );
    const clinical = runtime.get('clinical'),
      store = runtime.get('store');
    const patient = await clinical.register(doctor, {
      name: 'Synthetic Recovery Patient',
      birthDate: '1980-01-01',
      identifier: { type: 'local', value: 'RECOVERY-001' },
    });
    const encounter = await clinical.create(doctor, patient.id, 'encounter', {
      reason: 'Recovery verification',
    });
    const draft = await clinical.create(doctor, patient.id, 'note', {
      encounterId: encounter.id,
      text: 'Synthetic signed record for recovery.',
    });
    const signed = await clinical.transition(doctor, draft.id, 'sign', draft.version, {});
    const order = await runtime.get('laboratories').order(doctor, patient.id, {
      clientId: randomUUID(),
      encounterId: encounter.id,
      test: 'Synthetic analysis',
      question: 'Recovery case',
      specimen: 'Synthetic sample',
      assigneeId: doctor.id,
      due: '2027-01-01',
      priority: 'routine',
    });
    const token = await runtime.get('identity').issue!(doctor);
    await store.saveLogin('recovery-login', { nonce: 'synthetic' }, '2099-01-01T00:00:00.000Z');
    const beforeRecords = await store.list(doctor.tenant);
    const beforeHistory = await clinical.history(doctor, signed.id);
    const beforeAudit = await store.verifyAudit();
    const archive = join(directory, 'clinic.eirbak'),
      key = randomBytes(32);
    const sourceUrl = process.env[f.adminEnv]!;
    await createPostgresBackup({
      databaseUrl: sourceUrl,
      outputPath: archive,
      encryptionKey: key,
      pgBin: process.env.PG_BIN,
    });
    await f.root.query(`CREATE DATABASE ${identifier(recoveryName)} TEMPLATE template0`);
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = '/' + recoveryName;
    await restorePostgresBackup({
      databaseUrl: targetUrl.toString(),
      sourceDatabaseUrl: sourceUrl,
      runtimeDatabaseUrl: process.env[f.configA.connectionStringEnv],
      inputPath: archive,
      confirmFreshDatabase: recoveryName,
      encryptionKey: key,
      temporaryDirectory: directory,
      pgBin: process.env.PG_BIN,
    });
    assert.equal(
      (await f.root.query('SELECT datconnlimit FROM pg_database WHERE datname=$1', [recoveryName]))
        .rows[0].datconnlimit,
      0,
    );
    const restoredUrl = new URL(process.env[f.configA.connectionStringEnv]!);
    restoredUrl.pathname = '/' + recoveryName;
    process.env[restoredEnv] = restoredUrl.toString();
    const restoredConfig = { ...f.configA, connectionStringEnv: restoredEnv };
    await assert.rejects(start(restoredConfig), /unavailable/);
    // Only the isolated test operator deliberately unfences the restored database.
    await f.root.query(`ALTER DATABASE ${identifier(recoveryName)} CONNECTION LIMIT -1`);
    const restored = await start(restoredConfig);
    const restoredStore = restored.get('store');
    assert.deepEqual(await restoredStore.list(doctor.tenant), beforeRecords);
    assert.deepEqual(await restoredStore.verifyAudit(), beforeAudit);
    assert.deepEqual(await restoredStore.history(doctor.tenant, signed.id), beforeHistory);
    await assert.rejects(
      restored.get('identity').authenticate(token),
      (e: any) => e.status === 401,
    );
    assert.equal(await restoredStore.consumeLogin('recovery-login'), undefined);
    const chart = await restored.get('clinical').chart(doctor, patient.id);
    assert.deepEqual(
      chart.find((r) => r.id === signed.id),
      signed,
    );
    assert.deepEqual(
      chart.find((r) => r.id === order.id),
      order,
    );
    assert.ok(
      (await restored.get('careTeam').workspace(doctor, '2027-01-01')).tasks.some(
        (r) => r.data.linkedOrderId === order.id,
      ),
    );
    await assert.rejects(
      restored
        .get('clinical')
        .transition(doctor, signed.id, 'save', signed.version, { text: 'Forbidden overwrite' }),
      (e: any) => e.status === 409,
    );
    const amendment = await restored
      .get('clinical')
      .transition(doctor, signed.id, 'amend', signed.version, {
        text: 'Synthetic amendment after restore',
        reason: 'Recovery verification',
      });
    assert.equal(amendment.data.amends, signed.id);
    assert.equal((await restoredStore.verifyAudit()).ok, true);
    key.fill(0);
  },
);
