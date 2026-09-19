import { backupErrorMessage, backupKey, restorePostgresBackup } from '../packages/backup.ts';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
let key: Buffer | undefined;
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--input' ||
    !args[1] ||
    args[2] !== '--confirm-fresh-database' ||
    !args[3] ||
    !process.env.EIR_RESTORE_DATABASE_URL
  )
    throw new Error('Invalid arguments');
  key = backupKey(process.env.EIR_BACKUP_KEY);
  await restorePostgresBackup({
    inputPath: args[1],
    confirmFreshDatabase: args[3],
    databaseUrl: process.env.EIR_RESTORE_DATABASE_URL,
    sourceDatabaseUrl: process.env.EIR_BACKUP_DATABASE_URL,
    runtimeDatabaseUrl: process.env.EIR_DATABASE_URL,
    encryptionKey: key,
    pgBin: process.env.PG_BIN,
    temporaryDirectory: process.env.EIR_RESTORE_TMPDIR,
    signal: abort.signal,
  });
  console.log(
    'Restore completed and authentication rows purged. Target remains fenced (connection limit 0); validate before application boot.',
  );
} catch (error) {
  console.error(backupErrorMessage(error));
  console.error(
    'Usage: tsx scripts/postgres-restore.ts --input FILE --confirm-fresh-database NAME; set EIR_RESTORE_DATABASE_URL and EIR_BACKUP_KEY.',
  );
  process.exitCode = 1;
} finally {
  key?.fill(0);
}
