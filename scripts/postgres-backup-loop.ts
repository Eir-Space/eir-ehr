import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  backupErrorMessage,
  backupKey,
  createPostgresBackup,
  runBackupSchedule,
} from '../packages/backup.ts';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
let key: Buffer | undefined;
try {
  const directory = process.env.EIR_BACKUP_DIRECTORY;
  const databaseUrl = process.env.EIR_BACKUP_DATABASE_URL;
  const minutes = Number(process.env.EIR_BACKUP_INTERVAL_MINUTES);
  if (
    process.argv.length !== 2 ||
    !directory ||
    !databaseUrl ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 35791
  )
    throw new Error('Invalid scheduler configuration');
  key = backupKey(process.env.EIR_BACKUP_KEY);
  const encryptionKey = key;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await runBackupSchedule(
    async () => {
      const filename = `postgres-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.eirbak`;
      await createPostgresBackup({
        databaseUrl,
        outputPath: join(directory, filename),
        encryptionKey,
        pgBin: process.env.PG_BIN,
        signal: abort.signal,
      });
    },
    {
      intervalMs: minutes * 60000,
      signal: abort.signal,
      onResult(result) {
        if (result === 'success') console.log('Scheduled encrypted PostgreSQL backup completed.');
        else
          console.error(
            'Scheduled PostgreSQL backup failed; investigate backup freshness. Sensitive diagnostics suppressed.',
          );
      },
    },
  );
} catch (error) {
  console.error(backupErrorMessage(error));
  console.error(
    'Set EIR_BACKUP_DIRECTORY, EIR_BACKUP_INTERVAL_MINUTES, EIR_BACKUP_DATABASE_URL and EIR_BACKUP_KEY.',
  );
  process.exitCode = 1;
} finally {
  key?.fill(0);
}
