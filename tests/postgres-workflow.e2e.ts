import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { postgresClinicalFixture, expectStatus } from './postgres-clinical-helpers.ts';
import { postgresTestOptions } from './postgres-helpers.ts';
import { root } from './helpers.ts';

test(
  'two PostgreSQL-backed browser sessions preserve the losing draft and recover explicitly',
  postgresTestOptions,
  async (t) => {
    const f = await postgresClinicalFixture();
    const browser = await chromium.launch();
    t.after(async () => {
      await browser.close();
      await f.cleanup();
    });
    const note = expectStatus(
      await f.http(0, 'doctor', `/patients/${f.patient.id}/records/note`, {
        encounterId: f.encounter.id,
        text: 'Ursprunglig journaltext',
      }),
      201,
    );
    const pages = [];
    const errors: string[] = [];
    for (const index of [0, 1]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
      page.on('pageerror', (error) => errors.push(error.message));
      const token = await f.runtimes[index].get('identity').issue!(f.actors[index].doctor);
      await page.goto(f.urls[index]);
      await page.getByLabel('Sessionsnyckel').fill(token);
      await page.getByRole('button', { name: 'Öppna arbetsyta' }).click();
      await page.getByRole('heading', { name: 'Synthetic PostgreSQL patient' }).waitFor();
      await page.getByRole('button', { name: 'Anteckningar', exact: true }).click();
      await page.getByRole('button', { name: 'Redigera', exact: true }).click();
      await expect(page.getByLabel('Journaltext', { exact: true })).toHaveValue(
        'Ursprunglig journaltext',
      );
      pages.push(page);
    }
    await pages[0]
      .getByLabel('Journaltext', { exact: true })
      .fill('Sparad text från första sessionen');
    await expect(pages[0].locator('.draft-status')).toContainText('Sparat');
    await pages[1]
      .getByLabel('Journaltext', { exact: true })
      .fill('Bevarad osparad text från andra sessionen');
    await expect(pages[1].locator('.draft-conflict')).toBeVisible();
    await expect(pages[1].getByLabel('Journaltext', { exact: true })).toHaveValue(
      'Bevarad osparad text från andra sessionen',
    );
    await expect(pages[1].locator('.draft-conflict p')).toHaveText(
      'Sparad text från första sessionen',
    );
    assert.equal(
      (await f.runtimes[0].get('store').get(f.actors[0].doctor.tenant, note.id))!.data.text,
      'Sparad text från första sessionen',
    );
    await pages[1].screenshot({
      path: root + 'test-results/postgres-conflict-desktop.png',
      fullPage: true,
    });
    await pages[1].setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await pages[1].evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await pages[1].screenshot({
      path: root + 'test-results/postgres-conflict-mobile.png',
      fullPage: true,
    });
    pages[1].once('dialog', (dialog) => dialog.accept());
    await pages[1].getByRole('button', { name: 'Läs in sparad version' }).click();
    await expect(pages[1].getByLabel('Journaltext', { exact: true })).toHaveValue(
      'Sparad text från första sessionen',
    );
    await pages[1]
      .getByLabel('Journaltext', { exact: true })
      .fill('Sammanställd och sparad journaltext');
    await expect(pages[1].locator('.draft-status')).toContainText('Sparat');
    assert.equal(
      (await f.runtimes[0].get('store').get(f.actors[0].doctor.tenant, note.id))!.data.text,
      'Sammanställd och sparad journaltext',
    );
    assert.equal((await f.runtimes[0].get('store').verifyAudit()).ok, true);
    assert.deepEqual(errors, []);
  },
);
