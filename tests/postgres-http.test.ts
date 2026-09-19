import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../packages/contracts.ts';
import { Runtime } from '../packages/runtime.ts';
import { createApp } from '../apps/app.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import { postgresFixture, postgresTestOptions } from './postgres-helpers.ts';

test(
  'postgres: two full HTTP runtimes serve parallel chart, medication, session, and workspace requests',
  postgresTestOptions,
  async (t) => {
    const f = await postgresFixture();
    const runtimes: Runtime[] = [];
    const apps: Awaited<ReturnType<typeof createApp>>[] = [];
    t.after(async () => {
      for (const app of apps) await app.close();
      for (const runtime of runtimes) await runtime.stop();
      await f.cleanup();
    });
    const root = fileURLToPath(new URL('../', import.meta.url));
    const config = JSON.parse(
      await readFile(new URL('../eir.demo.config.json', import.meta.url), 'utf8'),
    );
    for (let i = 0; i < 2; i++) {
      const entries: { plugin: Plugin; config?: Record<string, unknown> }[] = [];
      for (const entry of config.plugins) {
        const module =
          entry.module === './plugins/storage-sqlite.ts'
            ? './plugins/storage-postgres.ts'
            : entry.module;
        const plugin = (await import(new URL('../' + module, import.meta.url).href))
          .default as Plugin;
        const settings =
          plugin.id === 'eir.storage.postgres'
            ? f.configA
            : plugin.id === 'eir.workforce'
              ? demoWorkforce(f.configA.tenant)
              : entry.config;
        entries.push({ plugin, config: settings });
      }
      const runtime = await new Runtime().start(entries);
      runtimes.push(runtime);
      apps.push(await createApp(runtime, root));
    }
    const workforce = runtimes[0].get('workforce');
    const assignment = (await workforce.forIdentity('https://local.eir.invalid', 'emma')).find(
      (row) => row.data.role === 'clinician',
    )!;
    const doctor = workforce.actor(assignment);
    const patient = await runtimes[0].get('clinical').register(doctor, {
      name: 'Synthetic PostgreSQL HTTP patient',
      birthDate: '1980-01-01',
      identifier: { type: 'local', value: 'POSTGRES-HTTP-001' },
    });
    await runtimes[0]
      .get('clinical')
      .create(doctor, patient.id, 'encounter', { reason: 'Synthetic integration test' });
    const token = await runtimes[0].get('identity').issue!(doctor);
    const headers = { authorization: `Bearer ${token}` };
    const paths = [
      '/api/session',
      '/api/patients',
      `/api/patients/${patient.id}/chart`,
      `/api/patients/${patient.id}/medications`,
      '/api/care-team?day=2026-09-21',
      `/api/patients/${patient.id}/permissions`,
      `/api/patients/${patient.id}/changes`,
    ];
    for (let wave = 0; wave < 3; wave++) {
      const responses = await Promise.all(
        paths.map((url, i) => apps[i % 2].inject({ url, headers })),
      );
      for (const [i, response] of responses.entries())
        assert.equal(response.statusCode, 200, `${paths[i]} wave ${wave}: ${response.body}`);
    }
    assert.equal((await runtimes[0].get('store').verifyAudit()).ok, true);
    assert.equal((await runtimes[1].get('store').verifyAudit()).ok, true);
  },
);
