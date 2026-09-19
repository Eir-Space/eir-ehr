import { parseArgs } from 'node:util';
import pg from 'pg';
import { migratePostgres, postgresPoolConfig } from '../packages/postgres-migrations.ts';

const { values } = parseArgs({
  options: {
    'connection-string-env': { type: 'string', default: 'EIR_POSTGRES_MIGRATION_URL' },
    tenant: { type: 'string' },
    'runtime-role': { type: 'string' },
    'local-development-only': { type: 'boolean', default: false },
  },
});
if (!!values.tenant !== !!values['runtime-role'])
  throw new Error('--tenant and --runtime-role must be supplied together');
const pool = new pg.Pool(
  postgresPoolConfig({
    connectionStringEnv: values['connection-string-env'],
    localDevelopmentOnly: values['local-development-only'],
  }),
);
pool.on('error', () => {
  process.exitCode = 1;
});
try {
  await migratePostgres(
    pool,
    values.tenant
      ? {
          tenant: values.tenant,
          runtimeRole: values['runtime-role']!,
        }
      : undefined,
  );
  console.log('PostgreSQL migrations and requested tenant provisioning completed.');
} catch {
  // Driver errors can contain URLs, SQL values, or identifying database details.
  console.error(
    'PostgreSQL migration failed. Check operator credentials, role restrictions, and migration integrity.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
