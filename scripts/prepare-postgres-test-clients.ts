import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const { values } = parseArgs({
  options: {
    container: { type: 'string' },
    output: { type: 'string' },
    docker: { type: 'string', default: 'docker' },
  },
});
const url = new URL(process.env.EIR_TEST_POSTGRES_URL ?? '');
if (
  !values.container ||
  !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(values.container) ||
  !values.output ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
)
  throw new Error(
    'Supply --container, --output and a loopback EIR_TEST_POSTGRES_URL for disposable tests only.',
  );
const output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 0o700 });
for (const binary of ['pg_dump', 'pg_restore']) {
  // These wrappers forward bytes to actual PostgreSQL clients, never emulate a dump.
  const source = `#!${process.execPath}
const { spawn } = require('node:child_process');
if (process.env.PGHOST !== ${JSON.stringify(url.hostname.replace(/^\[|\]$/g, ''))} ||
    (process.env.PGPORT || '5432') !== ${JSON.stringify(url.port || '5432')}) process.exit(2);
const names = ['PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGAPPNAME'];
const envArgs = names.filter(name => process.env[name] !== undefined).flatMap(name => ['--env', name]);
const child = spawn(${JSON.stringify(values.docker)}, ['exec', '-i', ...envArgs,
  '--env', 'PGHOST=127.0.0.1', '--env', 'PGPORT=5432', ${JSON.stringify(values.container)},
  ${JSON.stringify(binary)}, ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
`;
  await writeFile(join(output, binary), source, { flag: 'wx', mode: 0o700 });
}
console.log('Real PostgreSQL test-client wrappers prepared.');
