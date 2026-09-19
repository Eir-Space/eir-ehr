import { backupErrorMessage, backupKey, createPostgresBackup } from '../packages/backup.ts';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
let key: Buffer | undefined;
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== '--output' ||
    !args[1] ||
    !process.env.EIR_BACKUP_DATABASE_URL
  )
    throw new Error('Invalid arguments');
  key = backupKey(process.env.EIR_BACKUP_KEY);
  await createPostgresBackup({
    outputPath: args[1],
    databaseUrl: process.env.EIR_BACKUP_DATABASE_URL,
    encryptionKey: key,
    pgBin: process.env.PG_BIN,
    signal: abort.signal,
  });
  console.log('Encrypted PostgreSQL backup completed.');
} catch (error) {
  console.error(backupErrorMessage(error));
  console.error(
    'Usage: tsx scripts/postgres-backup.ts --output NEW_FILE; set EIR_BACKUP_DATABASE_URL and EIR_BACKUP_KEY.',
  );
  process.exitCode = 1;
} finally {
  key?.fill(0);
}
