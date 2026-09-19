import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

if (!process.env.EIR_TEST_POSTGRES_URL)
  throw new Error(
    'EIR_TEST_POSTGRES_URL must name an isolated PostgreSQL test database. No tests were run.',
  );
const files = (await readdir('tests')).filter(
  (name) => name.startsWith('postgres') && name.endsWith('.test.ts'),
);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...files.map((name) => 'tests/' + name)],
  { stdio: 'inherit' },
);
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
