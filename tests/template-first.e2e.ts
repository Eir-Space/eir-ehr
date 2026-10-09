import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../apps/app.ts';
import { fromConfig } from '../packages/runtime.ts';
import { doctor, root } from './helpers.ts';
import { memory } from './memory-content.ts';

test('template-driven vital form saves one canonical blood-pressure record', async (t) => {
  memory.reset();
  const dir = await mkdtemp(join(tmpdir(), 'eir-template-first-e2e-'));
  const profile = join(dir, 'profile.yaml');
  await writeFile(
    profile,
    `extends: [${JSON.stringify(root + 'eir.config.json')}]
profile: template-first-e2e
patches:
  - insert: { id: content-memory, module: ${JSON.stringify(root + 'tests/memory-content.ts')} }
    before: clinical
  - insert: { id: clinical-models, module: ${JSON.stringify(root + 'plugins/clinical-model-openehr.ts')} }
    before: clinical
  - insert: { id: clinical-repository, module: ${JSON.stringify(root + 'plugins/clinical-repository.ts')}, config: { source: memory, kinds: [observation] } }
    before: clinical
  - configure: clinical
    config: { canonicalKinds: [observation] }
`,
  );
  const { runtime } = await fromConfig(profile, {
    'eir.storage.sqlite': { path: ':memory:' },
    'eir.care-team': {
      members: [
        { id: doctor.id, tenant: doctor.tenant, name: 'Emma Sjöberg', profession: 'Läkare' },
      ],
    },
  });
  const clinical = runtime.get('clinical');
  const patient = await clinical.register(doctor, {
    name: 'Syntetisk Patient',
    birthDate: '1985-03-12',
    identifier: { type: 'local', value: `E2E-${randomUUID().toUpperCase()}` },
  });
  await clinical.create(doctor, patient.id, 'encounter', { reason: 'Blodtryckskontroll' });

  const app = await createApp(runtime, root);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await runtime.stop();
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByLabel('Sessionsnyckel').fill(await runtime.get('identity').issue!(doctor));
  await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
  await page.getByRole('heading', { name: 'Syntetisk Patient' }).waitFor();
  await page.getByRole('button', { name: 'Registrera', exact: true }).click();

  const dialog = page.getByRole('dialog');
  const measurement = dialog.getByLabel('Mätning', { exact: true });
  await expect(measurement.locator('option')).toHaveCount(5);
  await measurement.selectOption('85354-9');
  await dialog.getByLabel('Systoliskt', { exact: true }).fill('125');
  await dialog.getByLabel('Diastoliskt', { exact: true }).fill('80');
  await dialog.getByRole('button', { name: 'Spara', exact: true }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('125/80', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByText('Blodtryck: 125/80 mm[Hg]', { exact: true })).toBeVisible();
  await expect(page.getByText(/undefined/)).toHaveCount(0);
  assert.equal(memory.records.size, 1);
  const stored = [...memory.records.values()][0].versions.at(-1)!;
  assert.equal(stored.data.code, '85354-9');
  assert.deepEqual(
    stored.data.components.map((component: any) => [component.code, component.value]),
    [
      ['8480-6', 125],
      ['8462-4', 80],
    ],
  );
  assert.deepEqual(errors, []);
});
