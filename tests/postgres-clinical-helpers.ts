import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Actor, Entity, Plugin } from '../packages/contracts.ts';
import { Runtime } from '../packages/runtime.ts';
import { createApp } from '../apps/app.ts';
import { demoWorkforce } from '../apps/demo-workforce.ts';
import postgres from '../plugins/storage-postgres.ts';
import { postgresFixture } from './postgres-helpers.ts';

type Session = 'doctor' | 'colleague';
type HttpResult<T> = { status: number; body: T };

export function expectStatus<T>(result: HttpResult<T>, status = 200): T {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

export async function postgresClinicalFixture() {
  const database = await postgresFixture();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const runtimes: Runtime[] = [];
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  const urls: string[] = [];
  const actors: Record<Session, Actor>[] = [];
  const tokens: Record<Session, string>[] = [];
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const app of apps) {
      try {
        await app.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const runtime of runtimes) {
      try {
        await runtime.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await database.cleanup();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'PostgreSQL clinical fixture cleanup failed');
  };
  const http = async <T = Entity>(
    replica: 0 | 1,
    session: Session,
    path: string,
    data?: unknown,
  ): Promise<HttpResult<T>> => {
    const response = await fetch(urls[replica] + '/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${tokens[replica][session]}`,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  try {
    const config = JSON.parse(
      await readFile(new URL('../eir.demo.config.json', import.meta.url), 'utf8'),
    ) as {
      plugins: { module: string; config?: Record<string, unknown> }[];
    };
    for (let replica = 0; replica < 2; replica++) {
      const entries: { plugin: Plugin; config?: Record<string, unknown> }[] = [];
      for (const entry of config.plugins) {
        if (entry.module === './plugins/storage-sqlite.ts') {
          entries.push({ plugin: postgres, config: { ...database.configA } });
        } else {
          const plugin: Plugin = (await import(new URL('../' + entry.module, import.meta.url).href))
            .default;
          entries.push({
            plugin,
            config:
              plugin.id === 'eir.workforce' ? demoWorkforce(database.configA.tenant) : entry.config,
          });
        }
      }
      const runtime = await new Runtime().start(entries);
      runtimes.push(runtime);
      assert(runtime.active.some((entry) => entry.id === postgres.id));
      assert(!runtime.active.some((entry) => entry.id === 'eir.storage.sqlite'));
      const workforce = runtime.get('workforce');
      const find = async (subject: string) => {
        const assignment = (await workforce.forIdentity('https://local.eir.invalid', subject)).find(
          (row) => row.data.role === 'clinician',
        );
        assert(assignment);
        return workforce.actor(assignment);
      };
      const doctor = await find('emma'),
        colleague = await find('linnea');
      actors.push({ doctor, colleague });
      tokens.push({
        doctor: await runtime.get('identity').issue!(doctor),
        colleague: await runtime.get('identity').issue!(colleague),
      });
      const app = await createApp(runtime, root);
      apps.push(app);
      urls.push(await app.listen({ host: '127.0.0.1', port: 0 }));
    }
    assert.notEqual(runtimes[0].get('store'), runtimes[1].get('store'));
    assert.notEqual(tokens[0].doctor, tokens[1].doctor);
    const patient = expectStatus(
      await http(0, 'doctor', '/patients', {
        name: 'Synthetic PostgreSQL patient',
        birthDate: '1980-01-01',
        identifier: { type: 'local', value: 'PG-CLINICAL-001' },
      }),
      201,
    );
    const encounter = expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/records/encounter`, {
        reason: 'Synthetic follow-up',
      }),
      201,
    );
    expectStatus(
      await http(0, 'doctor', `/patients/${patient.id}/access`, {
        actorId: actors[1].colleague.id,
        role: 'clinician',
        expires: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Shared synthetic care responsibility',
      }),
    );
    return { ...database, cleanup, runtimes, urls, actors, http, patient, encounter };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function failClinicalAudit(
  admin: Awaited<ReturnType<typeof postgresFixture>>['admin'],
  action: 'task.created' | 'task.lab-result' | 'task.lab-review' | 'appointment.completed',
) {
  await admin.query(`CREATE OR REPLACE FUNCTION eir.fail_clinical_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.body::jsonb->>'action' = TG_ARGV[0] THEN
        RAISE EXCEPTION 'synthetic-clinical-failure-must-not-leak';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER zz_clinical_audit_failure BEFORE INSERT ON eir.audit
    FOR EACH ROW EXECUTE FUNCTION eir.fail_clinical_audit('${action}');`);
}
