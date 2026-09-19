import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import {
  backupErrorMessage,
  backupKey,
  createPostgresBackup,
  encryptBackup,
  restorePostgresBackup,
  runBackupSchedule,
  withVerifiedBackup,
} from '../packages/backup.ts';

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'eir-backup-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('backup key requires exactly 32 bytes of canonical base64', () => {
  const key = randomBytes(32);
  assert.deepEqual(backupKey(key.toString('base64')), key);
  for (const value of [
    undefined,
    '',
    key.toString('hex'),
    key.toString('base64url'),
    randomBytes(31).toString('base64'),
    key.toString('base64') + '\n',
    'A'.repeat(42) + 'B=',
  ])
    assert.throws(() => backupKey(value), /canonical base64/);
});

test('streaming encryption round trip, random nonce, authenticated callback and private cleanup', async (t) => {
  const directory = await temporary(t);
  const key = randomBytes(32);
  const data = randomBytes(4 * 1024 * 1024);
  const files = [join(directory, 'one'), join(directory, 'two')];
  for (const file of files) {
    await encryptBackup(
      Readable.from(
        (function* () {
          for (let at = 0; at < data.length; at += 4096) yield data.subarray(at, at + 4096);
        })(),
      ),
      file,
      key,
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    let plaintext = '';
    await withVerifiedBackup(
      file,
      key,
      async (path) => {
        plaintext = path;
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
        assert.deepEqual(await readFile(path), data);
      },
      { temporaryDirectory: directory },
    );
    await assert.rejects(stat(plaintext), { code: 'ENOENT' });
  }
  assert.notDeepEqual(await readFile(files[0]), await readFile(files[1]));
  assert.deepEqual((await readdir(directory)).sort(), ['one', 'two']);
});

test('wrong key, modified header/nonce/ciphertext/tag, truncation and appended data never reach consumer', async (t) => {
  const directory = await temporary(t);
  const key = randomBytes(32);
  const original = join(directory, 'original');
  await encryptBackup(
    Readable.from([Buffer.from('synthetic confidential payload')]),
    original,
    key,
  );
  const bytes = await readFile(original);
  let calls = 0;
  const consume = async () => {
    calls++;
  };
  await assert.rejects(
    withVerifiedBackup(original, randomBytes(32), consume, { temporaryDirectory: directory }),
    /authentication/,
  );
  const variants: Buffer[] = [];
  for (const index of [0, 8, 9, 10, 21, 22, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[index] ^= 1;
    variants.push(changed);
  }
  for (const length of [0, 8, 22, 38, bytes.length - 1, bytes.length - 16])
    variants.push(bytes.subarray(0, length));
  variants.push(Buffer.concat([bytes, Buffer.from([0])]));
  for (const variant of variants) {
    const file = join(directory, 'bad');
    await writeFile(file, variant, { mode: 0o600 });
    await assert.rejects(
      withVerifiedBackup(file, key, consume, { temporaryDirectory: directory }),
      /authentication|header/,
    );
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('eir-restore-')));
  }
  assert.equal(calls, 0);
});

test('output is exclusive even for symlinks and racing writers', async (t) => {
  const directory = await temporary(t);
  const file = join(directory, 'archive');
  const key = randomBytes(32);
  const results = await Promise.allSettled(
    ['one', 'two'].map((value) => encryptBackup(Readable.from([value]), file, key)),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const before = await readFile(file);
  await assert.rejects(encryptBackup(Readable.from(['replacement']), file, key), /exists/);
  assert.deepEqual(await readFile(file), before);
  const alias = join(directory, 'alias');
  await symlink(file, alias);
  await assert.rejects(encryptBackup(Readable.from(['replacement']), alias, key), /exists/);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(directory)).sort(), ['alias', 'archive']);
});

test('failed streams, cancellations and failed consumers clean partial files without exposing diagnostics', async (t) => {
  const directory = await temporary(t);
  const key = randomBytes(32);
  const file = join(directory, 'archive');
  const secret = 'SYNTHETIC-PHI-and-token-not-for-logs';
  const broken = Readable.from(
    (async function* () {
      yield Buffer.from('partial');
      throw new Error(secret);
    })(),
  );
  await assert.rejects(
    encryptBackup(broken, file, key),
    (error: Error) => !error.message.includes(secret),
  );
  assert.deepEqual(await readdir(directory), []);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(encryptBackup(Readable.from(['partial']), file, key, abort.signal));
  assert.deepEqual(await readdir(directory), []);
  await encryptBackup(Readable.from(['complete']), file, key);
  await assert.rejects(
    withVerifiedBackup(
      file,
      key,
      async () => {
        throw new Error(secret);
      },
      { temporaryDirectory: directory },
    ),
    /suppressed/,
  );
  assert.deepEqual(await readdir(directory), ['archive']);
  assert.ok(!backupErrorMessage(new Error(secret)).includes(secret));
});

test('restore rejects unsafe confirmation and authenticates before starting any client or connection', async (t) => {
  const directory = await temporary(t);
  const file = join(directory, 'archive');
  const key = randomBytes(32);
  await encryptBackup(Readable.from(['payload']), file, key);
  const options = {
    databaseUrl: 'postgresql://nobody:secret@127.0.0.1:1/fresh_recovery',
    inputPath: file,
    encryptionKey: key,
    confirmFreshDatabase: 'fresh_recovery',
    pgBin: join(directory, 'no-binaries'),
    temporaryDirectory: directory,
  };
  await assert.rejects(
    restorePostgresBackup({ ...options, confirmFreshDatabase: '' }),
    /confirmation/,
  );
  await assert.rejects(
    restorePostgresBackup({ ...options, sourceDatabaseUrl: options.databaseUrl }),
    /differ/,
  );
  await assert.rejects(
    restorePostgresBackup({ ...options, runtimeDatabaseUrl: options.databaseUrl }),
    /differ/,
  );
  await assert.rejects(
    restorePostgresBackup({ ...options, encryptionKey: randomBytes(32) }),
    /authentication/,
  );
  assert.deepEqual(await readdir(directory), ['archive']);
});

test('missing pg_dump fails without publishing a partial encrypted backup', async (t) => {
  const directory = await temporary(t);
  await assert.rejects(
    createPostgresBackup({
      databaseUrl: 'postgresql://nobody:secret@127.0.0.1:1/source',
      encryptionKey: randomBytes(32),
      outputPath: join(directory, 'archive'),
      pgBin: join(directory, 'missing'),
    }),
    /pg_dump/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test('scheduler serializes backups, waits after completion, reports failures and stops on abort', async () => {
  const abort = new AbortController();
  const events: string[] = [];
  let active = 0,
    calls = 0;
  await runBackupSchedule(
    async () => {
      assert.equal(active++, 0);
      events.push('start');
      await new Promise<void>((resolve) => setImmediate(resolve));
      calls++;
      active--;
      events.push('end');
      if (calls === 1) throw new Error('synthetic secret');
    },
    {
      intervalMs: 1234,
      signal: abort.signal,
      onResult: (result) => {
        events.push(result);
      },
      wait: async (milliseconds) => {
        assert.equal(milliseconds, 1234);
        assert.equal(active, 0);
        events.push('wait');
        if (calls === 2) abort.abort();
      },
    },
  );
  assert.deepEqual(events, ['start', 'end', 'failure', 'wait', 'start', 'end', 'success', 'wait']);
  await assert.rejects(
    runBackupSchedule(async () => {}, { intervalMs: NaN, signal: abort.signal }),
    /interval/,
  );
});

test('remote connections require verified TLS before any subprocess or network connection', async (t) => {
  const directory = await temporary(t);
  for (const suffix of ['', '?sslmode=disable', '?sslmode=require', '?sslmode=prefer']) {
    const databaseUrl = 'postgresql://owner:secret@database.example/recovery' + suffix;
    await assert.rejects(
      createPostgresBackup({
        databaseUrl,
        outputPath: join(directory, 'backup'),
        encryptionKey: randomBytes(32),
      }),
      /Remote hosts require sslmode=verify-full/,
    );
    await assert.rejects(
      restorePostgresBackup({
        databaseUrl,
        inputPath: join(directory, 'missing'),
        encryptionKey: randomBytes(32),
        confirmFreshDatabase: 'recovery',
      }),
      /Remote hosts require sslmode=verify-full/,
    );
  }
  assert.deepEqual(await readdir(directory), []);
});

const adminUrl = process.env.EIR_BACKUP_TEST_ADMIN_URL ?? process.env.EIR_TEST_POSTGRES_URL;
test(
  'real PostgreSQL encrypted backup/restore drill preserves evidence and permissions, purges login state, rejects unsafe targets',
  {
    skip:
      !adminUrl &&
      'Set EIR_BACKUP_TEST_ADMIN_URL and PG_BIN (or install PostgreSQL clients) for the real drill.',
    timeout: 120000,
  },
  async (t) => {
    const directory = await temporary(t);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const sourceName = `backup_source_${suffix}`,
      targetName = `backup_target_${suffix}`;
    const readerRole = `backup_reader_${suffix}`;
    const urlFor = (database: string) => {
      const url = new URL(adminUrl!);
      url.pathname = '/' + database;
      return url.toString();
    };
    const source = new pg.Client({ connectionString: urlFor(sourceName) });
    t.after(async () => {
      await source.end();
      await admin.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
      await admin.end();
    });
    await admin.query(`CREATE ROLE "${readerRole}" NOLOGIN`);
    await admin.query(`CREATE DATABASE "${sourceName}" TEMPLATE template0`);
    await admin.query(`CREATE DATABASE "${targetName}" TEMPLATE template0`);
    await source.connect();
    await source.query(`
    CREATE TABLE evidence (id text PRIMARY KEY, kind text NOT NULL, body jsonb NOT NULL);
    CREATE TABLE audit (seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL, previous text NOT NULL, hash text NOT NULL);
    CREATE TABLE sessions (hash text PRIMARY KEY);
    CREATE TABLE login_transactions (hash text PRIMARY KEY);
    GRANT SELECT ON evidence TO "${readerRole}";
    INSERT INTO sessions VALUES ('synthetic-session-hash');
    INSERT INTO login_transactions VALUES ('synthetic-login-hash');
  `);
    const evidence = [
      ['signed-note', 'note', { status: 'signed', text: 'Synthetic signed note', version: 2 }],
      ['order', 'medication-order', { status: 'signed', authoredBy: 'synthetic-doctor' }],
      ['assignment', 'assignment', { practitionerId: 'synthetic-doctor', active: true }],
      // Exceeds pipe buffers so the real --list process exercises early stdin close.
      ['large-synthetic', 'test-payload', { data: randomBytes(1024 * 1024).toString('hex') }],
    ];
    for (const [id, kind, body] of evidence)
      await source.query('INSERT INTO evidence VALUES ($1,$2,$3)', [
        id,
        kind,
        JSON.stringify(body),
      ]);
    let previous = 'GENESIS';
    for (const action of ['note.signed', 'order.signed', 'assignment.created']) {
      const body = JSON.stringify({ action, actor: 'synthetic-doctor' });
      const hash = createHash('sha256')
        .update(previous + body)
        .digest('hex');
      await source.query('INSERT INTO audit(body,previous,hash) VALUES ($1,$2,$3)', [
        body,
        previous,
        hash,
      ]);
      previous = hash;
    }
    const key = randomBytes(32),
      archive = join(directory, 'recovery.eirbak');
    const backupOptions = {
      databaseUrl: urlFor(sourceName),
      outputPath: archive,
      encryptionKey: key,
      pgBin: process.env.PG_BIN,
    };
    await createPostgresBackup(backupOptions);
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
    const restoreOptions = {
      databaseUrl: urlFor(targetName),
      inputPath: archive,
      encryptionKey: key,
      confirmFreshDatabase: targetName,
      sourceDatabaseUrl: urlFor(sourceName),
      pgBin: process.env.PG_BIN,
      temporaryDirectory: directory,
    };
    const connectTarget = async () => {
      const client = new pg.Client({ connectionString: urlFor(targetName) });
      await client.connect();
      return client;
    };
    await assert.rejects(
      restorePostgresBackup({ ...restoreOptions, encryptionKey: randomBytes(32) }),
      /authentication/,
    );
    assert.equal(
      (await admin.query('SELECT datconnlimit FROM pg_database WHERE datname=$1', [targetName]))
        .rows[0].datconnlimit,
      -1,
    );
    let target = await connectTarget();
    await target.query('CREATE TABLE must_not_overwrite (id integer)');
    await target.end();
    await assert.rejects(restorePostgresBackup(restoreOptions), /empty/);
    target = await connectTarget();
    await target.query('DROP TABLE must_not_overwrite');
    await assert.rejects(restorePostgresBackup(restoreOptions), /active connections/);
    await target.end();
    await restorePostgresBackup(restoreOptions);
    target = await connectTarget();
    try {
      assert.deepEqual(
        (await target.query('SELECT * FROM evidence ORDER BY id')).rows,
        (await source.query('SELECT * FROM evidence ORDER BY id')).rows,
      );
      assert.deepEqual(
        (await target.query('SELECT * FROM audit ORDER BY seq')).rows,
        (await source.query('SELECT * FROM audit ORDER BY seq')).rows,
      );
      assert.equal((await target.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
      assert.equal(
        (await target.query('SELECT count(*)::int AS n FROM login_transactions')).rows[0].n,
        0,
      );
      assert.equal(
        (
          await target.query('SELECT has_table_privilege($1, $2, $3) AS allowed', [
            readerRole,
            'evidence',
            'SELECT',
          ])
        ).rows[0].allowed,
        true,
      );
      assert.equal(
        (await admin.query('SELECT datconnlimit FROM pg_database WHERE datname=$1', [targetName]))
          .rows[0].datconnlimit,
        0,
      );
    } finally {
      await target.end();
    }
    await assert.rejects(restorePostgresBackup(restoreOptions), /empty/);
    assert.deepEqual(await readdir(directory), ['recovery.eirbak']);
  },
);
