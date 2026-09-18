import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !existsSync(source) || existsSync(destination))
  throw new Error(
    'Usage: npm run backup -- existing.sqlite new-backup.sqlite (destination must not exist)',
  );
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  console.log(`Consistent SQLite backup written to ${destination}`);
} finally {
  db.close();
}
