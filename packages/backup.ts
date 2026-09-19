import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// v1: magic(8), version(1), algorithm(1), nonce(12), ciphertext, GCM tag(16).
// The complete fixed-size header is authenticated as additional data.
const MAGIC = Buffer.from('EIRPGBAK');
const HEADER_BYTES = 22;
const TAG_BYTES = 16;

export class BackupError extends Error {}

export function backupKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new BackupError('EIR_BACKUP_KEY must be canonical base64 encoding of 32 random bytes.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new BackupError('EIR_BACKUP_KEY must be canonical base64 encoding of 32 random bytes.');
  return key;
}

function checkKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new BackupError('The encryption key must contain exactly 32 bytes.');
}

function safeError(error: unknown, message: string): BackupError {
  return error instanceof BackupError ? error : new BackupError(message);
}

export function backupErrorMessage(error: unknown): string {
  return safeError(error, 'Backup operation failed; sensitive diagnostics have been suppressed.')
    .message;
}

async function privateDirectory(parent: string, prefix: string) {
  const directory = await mkdtemp(join(parent, prefix));
  try {
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new BackupError('The output already exists; refusing to overwrite it.');
}

// FileHandle writes avoid a stream taking ownership of the descriptor before fsync.
function fileSink(file: FileHandle) {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new BackupError('Backup file write failed.');
          offset += bytesWritten;
        }
      })().then(
        () => callback(),
        () => callback(new BackupError('Backup file write failed.')),
      );
    },
  });
}

async function writeEncrypted(
  source: Readable,
  file: FileHandle,
  key: Buffer,
  signal?: AbortSignal,
) {
  const header = Buffer.concat([MAGIC, Buffer.from([1, 1]), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(10), {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(header);
  await file.writeFile(header);
  await pipeline(source, cipher, fileSink(file), { signal });
  await file.writeFile(cipher.getAuthTag());
  await file.sync();
}

async function publishEncrypted(outputPath: string, write: (file: FileHandle) => Promise<void>) {
  const output = resolve(outputPath);
  await absent(output);
  const staging = await privateDirectory(dirname(output), '.eir-backup-');
  try {
    const temporary = join(staging, 'archive');
    const file = await open(temporary, 'wx', 0o600);
    try {
      await write(file);
    } finally {
      await file.close();
    }
    // link(), unlike rename(), cannot replace an existing path, including a symlink.
    await link(temporary, output);
    const parent = await open(dirname(output), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function encryptBackup(
  source: Readable,
  outputPath: string,
  key: Buffer,
  signal?: AbortSignal,
) {
  try {
    checkKey(key);
    await publishEncrypted(outputPath, (file) => writeEncrypted(source, file, key, signal));
  } catch (error) {
    source.destroy();
    throw safeError(error, 'Encrypted backup failed; no incomplete archive was published.');
  }
}

async function readExactly(file: FileHandle, bytes: number, position: number) {
  const buffer = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const result = await file.read(buffer, offset, bytes - offset, position + offset);
    if (!result.bytesRead) throw new BackupError('Backup authentication failed.');
    offset += result.bytesRead;
  }
  return buffer;
}

/** The callback cannot run until GCM final() has authenticated the entire archive. */
export async function withVerifiedBackup<T>(
  inputPath: string,
  key: Buffer,
  consume: (verifiedPath: string) => Promise<T>,
  options: { temporaryDirectory?: string; signal?: AbortSignal } = {},
): Promise<T> {
  checkKey(key);
  let directory: string | undefined;
  let input: FileHandle | undefined;
  try {
    input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await input.stat();
    if (!info.isFile() || info.size <= HEADER_BYTES + TAG_BYTES)
      throw new BackupError('Backup authentication failed.');
    const header = await readExactly(input, HEADER_BYTES, 0);
    if (!header.subarray(0, 8).equals(MAGIC) || header[8] !== 1 || header[9] !== 1)
      throw new BackupError('Unsupported or damaged backup header.');
    const tag = await readExactly(input, TAG_BYTES, info.size - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(10), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    directory = await privateDirectory(options.temporaryDirectory ?? tmpdir(), 'eir-restore-');
    const plaintext = join(directory, 'verified.dump');
    const output = await open(plaintext, 'wx', 0o600);
    try {
      await pipeline(
        input.createReadStream({
          start: HEADER_BYTES,
          end: info.size - TAG_BYTES - 1,
          autoClose: false,
        }),
        decipher,
        fileSink(output),
        { signal: options.signal },
      );
      await output.sync();
    } catch {
      throw new BackupError('Backup authentication failed.');
    } finally {
      await output.close();
    }
    options.signal?.throwIfAborted();
    return await consume(plaintext);
  } catch (error) {
    throw safeError(
      error,
      'Backup verification or recovery failed; sensitive diagnostics have been suppressed.',
    );
  } finally {
    await input?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function connection(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !database ||
      !user ||
      url.hash
    )
      throw new Error();
    if (/[\x00-\x20/=]/.test(database) || /[\x00-\x1f]/.test(user)) throw new Error();
    for (const [name, value] of url.searchParams) {
      if (!['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(name)) throw new Error();
      if (name === 'sslmode' && !['disable', 'verify-full'].includes(value)) throw new Error();
      if (url.searchParams.getAll(name).length !== 1) throw new Error();
    }
    const hostname = url.hostname.toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (!loopback && url.searchParams.get('sslmode') !== 'verify-full')
      throw new BackupError('Remote PostgreSQL connections require sslmode=verify-full.');
    if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'disable');
    return {
      database,
      url: url.toString(),
      identity: `${hostname}:${url.port || '5432'}/${database}`,
    };
  } catch {
    throw new BackupError(
      'Use an explicit PostgreSQL URL with host, user and database. Remote hosts require sslmode=verify-full; disable is allowed only on loopback.',
    );
  }
}

function childEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  // Do not inherit the encryption key, runtime URL, PGOPTIONS or other app secrets.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'LANG', 'LC_ALL'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const url = new URL(connection(databaseUrl).url);
  env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  env.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
  env.PGPORT = url.port || '5432';
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  for (const [name, value] of url.searchParams) env['PG' + name.toUpperCase()] = value;
  env.PGCONNECT_TIMEOUT = '15';
  env.PGAPPNAME = 'eir-backup-recovery';
  return env;
}

function pgProcess(
  binary: 'pg_dump' | 'pg_restore',
  args: string[],
  databaseUrl: string,
  pgBin?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = spawn(pgBin ? join(pgBin, binary) : binary, args, {
    env: childEnvironment(databaseUrl),
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
  });
  let diagnostics = false;
  let failed = false;
  // Even a successful pg_dump can warn about incomplete contents. Fail closed,
  // but never emit stderr, which can contain row data, identifiers or credentials.
  child.stderr.on('data', () => {
    diagnostics = true;
  });
  const completed = new Promise<void>((resolve, reject) => {
    // Wait for close even after AbortError: the child may still be alive.
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      if (failed) reject(new BackupError(`${binary} could not run or was cancelled.`));
      else if (code === 0 && !diagnostics) resolve();
      else
        reject(new BackupError(`${binary} failed or reported warnings; diagnostics suppressed.`));
    });
  });
  // Consumers may still be setting up their stream when spawn fails.
  void completed.catch(() => {});
  return { child, completed };
}

async function stopChild(child: ChildProcess, completed: Promise<void>) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  try {
    await completed.catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

export type PostgresBackupOptions = {
  databaseUrl: string;
  outputPath: string;
  encryptionKey: Buffer;
  pgBin?: string;
  signal?: AbortSignal;
};

export async function createPostgresBackup(options: PostgresBackupOptions) {
  try {
    checkKey(options.encryptionKey);
    connection(options.databaseUrl);
    await publishEncrypted(options.outputPath, async (file) => {
      const { child, completed } = pgProcess(
        'pg_dump',
        ['--format=custom', '--no-password', '--lock-wait-timeout=30s'],
        options.databaseUrl,
        options.pgBin,
        options.signal,
      );
      child.stdin.end();
      const writing = writeEncrypted(child.stdout, file, options.encryptionKey, options.signal);
      try {
        await Promise.all([writing, completed]);
      } finally {
        await stopChild(child, completed);
        await writing.catch(() => {});
      }
    });
  } catch (error) {
    throw safeError(error, 'PostgreSQL backup failed; no incomplete archive was published.');
  }
}

async function restoreProcess(
  path: string,
  args: string[],
  options: PostgresRestoreOptions,
  listing = false,
) {
  const { child, completed } = pgProcess(
    'pg_restore',
    args,
    options.databaseUrl,
    options.pgBin,
    options.signal,
  );
  child.stdout.resume();
  const pumping = pipeline(createReadStream(path), child.stdin, { signal: options.signal }).catch(
    (error: NodeJS.ErrnoException) => {
      // --list need not consume table data; still require a successful child exit.
      if (listing && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code ?? '')) return;
      throw error;
    },
  );
  try {
    await Promise.all([pumping, completed]);
  } finally {
    await stopChild(child, completed);
    await pumping.catch(() => {});
  }
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export type PostgresRestoreOptions = {
  databaseUrl: string;
  inputPath: string;
  encryptionKey: Buffer;
  confirmFreshDatabase: string;
  sourceDatabaseUrl?: string;
  runtimeDatabaseUrl?: string;
  temporaryDirectory?: string;
  pgBin?: string;
  signal?: AbortSignal;
};

export async function restorePostgresBackup(options: PostgresRestoreOptions) {
  const target = connection(options.databaseUrl);
  if (
    options.confirmFreshDatabase !== target.database ||
    ['postgres', 'template0', 'template1'].includes(target.database)
  )
    throw new BackupError('Explicit confirmation must match a dedicated fresh recovery database.');
  for (const other of [options.sourceDatabaseUrl, options.runtimeDatabaseUrl])
    if (other && connection(other).identity === target.identity)
      throw new BackupError(
        'The restore target must differ from the source and runtime databases.',
      );
  await withVerifiedBackup(
    options.inputPath,
    options.encryptionKey,
    async (path) => {
      // No database connection, SQL or pg_restore --dbname before authentication.
      await restoreProcess(path, ['--list', '--no-password'], options, true);
      const client = new pg.Client({
        connectionString: target.url,
        connectionTimeoutMillis: 15000,
        query_timeout: 30000,
      });
      client.on('error', () => {});
      try {
        await client.connect();
        const {
          rows: [state],
        } = await client.query(`
        SELECT current_database() AS name, d.datistemplate AS template,
          r.rolsuper AS superuser, pg_try_advisory_lock(1952805425, 1650549611) AS locked
        FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
        WHERE d.datname = current_database()`);
        if (!state || state.name !== target.database || state.template || !state.locked)
          throw new BackupError(
            'Recovery target identity or exclusive recovery lock check failed.',
          );
        if (!state.superuser)
          throw new BackupError(
            'Recovery requires an isolated target and a recovery superuser to fence ordinary connections.',
          );
        await assertEmptyIdleTarget(client);
        options.signal?.throwIfAborted();
        // Remains zero on success AND failure. Only recovery superusers can connect.
        // Operators must finish validation before deliberately reopening the target.
        await client.query(`ALTER DATABASE ${identifier(target.database)} CONNECTION LIMIT 0`);
        await assertEmptyIdleTarget(client);
        await restoreProcess(
          path,
          [
            '--format=custom',
            '--no-password',
            '--exit-on-error',
            '--single-transaction',
            '--dbname=' + target.database,
          ],
          options,
        );
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(`
          SELECT n.nspname AS schema, c.relname AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_'
            AND n.nspname <> 'information_schema'
            AND c.relname IN ('sessions','login_transactions')`);
          if (
            rows.filter((row) => row.name === 'sessions').length !== 1 ||
            rows.filter((row) => row.name === 'login_transactions').length !== 1
          )
            throw new BackupError(
              'Restored authentication tables do not match the recovery contract; keep the target offline and purge manually.',
            );
          for (const row of rows)
            await client.query(`DELETE FROM ${identifier(row.schema)}.${identifier(row.name)}`);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      } catch (error) {
        throw safeError(
          error,
          'Restore failed; keep the recovery target isolated and inspect it before any application boot.',
        );
      } finally {
        await client.end().catch(() => {});
      }
    },
    options,
  );
}

async function assertEmptyIdleTarget(client: pg.Client) {
  const {
    rows: [state],
  } = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()) AS active,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_')
      OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database=current_database())
      OR EXISTS (SELECT 1 FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='public'::regnamespace)
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
      OR EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql')
      OR EXISTS (SELECT 1 FROM pg_largeobject_metadata)
      OR EXISTS (SELECT 1 FROM pg_event_trigger)
      OR EXISTS (SELECT 1 FROM pg_publication)
      OR EXISTS (SELECT 1 FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database())) AS populated`);
  if (state.active || state.populated)
    throw new BackupError('Recovery target must be empty and have no other active connections.');
}

/** Run immediately, then wait after each completion; never overlap or delete archives. */
export async function runBackupSchedule(
  backup: () => Promise<void>,
  options: {
    intervalMs: number;
    signal: AbortSignal;
    onResult?: (result: 'success' | 'failure') => void;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
) {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > 2147483647
  )
    throw new BackupError('Backup interval is outside the supported timer range.');
  const wait =
    options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  while (!options.signal.aborted) {
    try {
      await backup();
      options.onResult?.('success');
    } catch {
      if (!options.signal.aborted) options.onResult?.('failure');
    }
    if (!options.signal.aborted) {
      try {
        await wait(options.intervalMs, options.signal);
      } catch (error) {
        if (!options.signal.aborted) throw safeError(error, 'Backup scheduler failed.');
      }
    }
  }
}
