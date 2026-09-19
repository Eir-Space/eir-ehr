# Encrypted PostgreSQL Recovery

These tools implement encrypted, consistent **logical** backups and an isolated
restore drill. They do not implement point-in-time recovery (PITR), automatic
failover, clinical certification, or a complete production disaster-recovery service.

## Operator Prerequisites

- Node 22.13 or newer, this project's dependencies, and matching PostgreSQL
  `pg_dump` / `pg_restore` clients. For PostgreSQL 18 use PostgreSQL 18 clients;
  an older client installed by an OS image is not sufficient. Binaries come from
  `PATH`, or `PG_BIN` names their directory. Never point `PG_BIN` at untrusted code.
- Keep runtime credentials separate from migration/backup credentials. Runtime
  roles must remain restricted tenant logins. The backup login needs complete
  read access, including every tenant under FORCE RLS; use the migration owner
  with its operator policies, or a separately governed backup operator. Never
  silently substitute the runtime URL for the backup URL.
- A different, isolated recovery instance is strongly preferred. This restore
  implementation requires a recovery **superuser** so it can set the target's
  connection limit to zero and still restore. Managed services without a true
  recovery superuser need a separately reviewed isolation/restore procedure;
  do not remove the fence merely to make the command work.
- Provision the same owning roles and restricted runtime role names on the
  recovery cluster before restore. Keep their passwords in the secret manager,
  not the dump. In particular preserve the owner of `eir.append_audit`, its
  SECURITY DEFINER properties, the `operator_access` policies, `eir.tenant_roles`,
  and `eir.audit_heads`. Changing owners can break or weaken tenant enforcement.
- Create the target database from `template0`, with no application schema,
  extensions, tables, or other clients. Do not boot the application or run its
  migrations first. Permit only recovery operators at the network/auth boundary.
- Protect backup directories (0700), encrypted storage, and the recovery scratch
  filesystem. Restore temporarily writes plaintext to a private 0700 directory
  and 0600 file. Set `EIR_RESTORE_TMPDIR` to an adequately sized, encrypted local
  filesystem; do not use a shared or snapshotted unencrypted scratch volume.

## Configuration

Secrets are environment variables, not CLI arguments:

| Variable                      | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `EIR_BACKUP_DATABASE_URL`     | Explicit source URL using the backup/operator role                                   |
| `EIR_RESTORE_DATABASE_URL`    | Explicit, separate recovery target URL using the recovery superuser                  |
| `EIR_DATABASE_URL`            | Optional runtime URL, checked to reject that target; never used as a backup fallback |
| `EIR_BACKUP_KEY`              | Canonical base64 of exactly 32 cryptographically random bytes                        |
| `PG_BIN`                      | Optional directory containing `pg_dump` and `pg_restore`                             |
| `EIR_RESTORE_TMPDIR`          | Optional encrypted recovery scratch directory                                        |
| `EIR_BACKUP_DIRECTORY`        | Required archive directory for the scheduled loop                                    |
| `EIR_BACKUP_INTERVAL_MINUTES` | Required loop delay, integer 1 through 35791                                         |

Use a secret manager to generate, inject, escrow, and rotate `EIR_BACKUP_KEY`.
For example, the key bytes can be produced by
`randomBytes(32).toString('base64')` from Node's `node:crypto`. Do not put a literal
key in shell history, source control, CI output, or this document. Keep key
escrow separate from archive storage and test recovering a retained archive with
its retained key. There is no key identifier in the file: the operator must keep
the archive-to-key-version inventory without patient identifiers.

URLs must explicitly name host, user, and database. Remote hosts require
`sslmode=verify-full`; use the appropriate trusted `sslrootcert` when needed.
Only `sslmode`, `sslrootcert`, `sslcert`, and `sslkey` URL parameters are accepted.
`sslmode=disable`, including the normalized default, is allowed only for
`localhost`, `127.0.0.1`, or `[::1]`. Both Node preflight and libpq use the same
validated configuration. No remote `require`, `prefer`, or plaintext fallback.

## One Backup

With the source URL and key injected into the process environment:

```sh
npx tsx scripts/postgres-backup.ts --output /protected/backups/recovery-2026-09-19.eirbak
```

The parent directory must exist. `pg_dump --format=custom` provides one consistent
logical snapshot while application writes continue. Output streams directly into
AES-256-GCM encryption; no plaintext dump is created during backup. Schema,
data, sequences, ownership, RLS policies, object ACLs, and functions are included.
The tools do not use schema/table filters, `--no-owner`, or `--no-acl`.

The archive format is `EIRPGBAK` (8 bytes), version 1 (1 byte), algorithm 1
(1 byte, AES-256-GCM), random nonce (12 bytes), ciphertext, authentication tag
(16 bytes). The entire 22-byte header is GCM additional authenticated data.
There is no unencrypted patient metadata. Fresh nonces are generated per archive.
AES-GCM's per-message limit applies; these tools are intended for logical archives
below 64 GiB of unencrypted custom-format dump data, not arbitrarily large clusters.

The archive is written privately, fsynced, and published by an exclusive hard
link on the same filesystem. Existing paths, including symlinks, are never
overwritten. Files have mode 0600. Failed/cancelled runs remove their staging
directory and do not publish an incomplete archive. SIGINT/SIGTERM trigger
cleanup; SIGKILL, machine loss, or filesystem failure can leave private staging
files. Inventory and remove abandoned `.eir-backup-*` / `eir-restore-*`
directories only after confirming there is no live operation. Unlinking is not
secure erasure, which is why scratch storage must itself be encrypted.

Client stderr is consumed without logging it; even a warning makes the operation
fail. CLI messages never include SQL, row values, tokens, URLs, keys, or raw
driver errors. Underlying database audit/logging policies must also avoid
sensitive statement logging. Privileged host administrators can inspect process
environments; run these tools under a dedicated trusted operating-system account.

## Scheduled Backups

Inject the source/key plus `EIR_BACKUP_DIRECTORY` and
`EIR_BACKUP_INTERVAL_MINUTES`, then supervise:

```sh
npx tsx scripts/postgres-backup-loop.ts
```

The loop starts immediately, awaits the complete backup, then waits the configured
interval. It never overlaps its own runs. Names contain UTC time and random UUIDs.
Failures emit a generic failure event and retry after the interval. Shutdown
cancels the active child/stream and stops the timer. The loop does **not delete
any old backup**, even when disk space is low. Run one supervised loop per source;
independent processes are not mutually locked. Test coverage verifies scheduling,
non-overlap, failure reporting, and cancellation.

Alternatively run the one-shot CLI from an external scheduler with an operator
chosen cadence and non-overlap lock. Operators must configure supervision,
failure and freshness alerts, off-host encrypted replication, capacity monitoring,
retention, immutable copies where appropriate, access reviews, and periodic drills.
Do not delete the last verified backup to make room for an unverified replacement.
Retention expiry and key destruction require a separately governed policy.

Define the required RPO and RTO for the actual deployment. As an **example only**,
an hourly logical backup schedule is not a guarantee of a one-hour RPO: the loop
waits after completion, snapshots predate completed uploads, and failed runs
increase data loss exposure. Measure the age of the latest successfully restored
snapshot, not merely the most recent filename. RTO includes provisioning roles
and an isolated target, key retrieval, archive download, authentication/decryption,
restore, identity invalidation, evidence checks, and controlled reopening. No
particular RPO/RTO is asserted here.

PITR still requires managed base backups and WAL archiving/retention, monitoring,
and tested recovery-to-time procedures. This milestone does not supply those.

## Restore Procedure

1. Declare a recovery window and isolate the target. Provision matching roles,
   extensions' server packages, tablespace locations, and an empty database, for
   example `CREATE DATABASE eir_recovery_20260919 TEMPLATE template0`. Database
   globals (roles, passwords, tablespaces) are not in a single-database dump.
   Configure database-level ownership, ACLs and settings explicitly; this tool
   intentionally never uses `--create` and does not restore source database-level
   settings/CONNECT ACLs into the target.
2. Set `EIR_RESTORE_DATABASE_URL` and the archive's `EIR_BACKUP_KEY`. Retain
   `EIR_BACKUP_DATABASE_URL` and the actual runtime URL in `EIR_DATABASE_URL` as
   additional wrong-target guards. Host aliases cannot prove different servers;
   verify the destination independently. Confirm the actual database name:

   ```sh
   npx tsx scripts/postgres-restore.ts --input /protected/backups/recovery-2026-09-19.eirbak --confirm-fresh-database eir_recovery_20260919
   ```

3. Authentication must complete before any database connection or restore write.
   Wrong key, tampering, truncation, unknown version, and appended data fail
   closed. `pg_restore --list` checks archive compatibility. The target check
   rejects nonempty databases, template databases, `postgres`, other connected
   sessions and another recovery process. No target is dropped or cleaned.
4. The script sets `CONNECTION LIMIT 0`, rechecks emptiness/other connections, and
   runs `pg_restore --single-transaction --exit-on-error`. It never disables
   triggers or strips ownership/ACLs. It then transactionally deletes every row
   from the single discovered `sessions` and `login_transactions` tables, in all
   tenants, without modifying clinical/audit evidence. Current tables are
   `eir.sessions` and `eir.login_transactions`. Missing/ambiguous authentication
   tables are a failure, not a successful recovery. Keep the target offline;
   reconcile the schema and purge those tables manually before boot if needed.
5. A target fenced during recovery stays at connection limit zero on success,
   failure, or cancellation. Ordinary runtime connections cannot use it; a
   privileged superuser still can, so network/operator isolation remains essential.
   Restore failure normally rolls back pg_restore's transaction. A successful
   restore followed by failed purge leaves restored data quarantined; never boot
   the app or retry into this now-populated target. Investigate and provision a
   new empty database for another attempt.
6. Verify migration checksums, table/function ownership, ACLs, RLS and FORCE RLS,
   operator/tenant policies and role-to-tenant mapping. Verify signed-note content
   and immutability, orders, assignments, full version history, audit hashes/head
   continuity and sequence positions. Check both authentication tables are empty.
   Preserve the untouched original archive and record drill evidence separately.
7. Stop old application processes, invalidate any external session/login caches,
   review restored workforce assignments and access revocations against events
   after the snapshot, and require fresh identity-provider login. Restore can
   resurrect an assignment revoked after the snapshot; old session invalidation
   alone does not fix that. Reconcile before opening access.
8. Apply intended target database CONNECT privileges, then deliberately reopen
   with an operator command such as
   `ALTER DATABASE eir_recovery_20260919 CONNECTION LIMIT -1`. Only then point the
   application at the verified target using its restricted runtime credentials.
   Do not give the application the recovery superuser's URL.

Only restore trusted archives. Encryption authenticates possession of the key;
it does not make SQL from a compromised source operator safe to execute.

## Automated Drill And Integration

```sh
node --import tsx --test tests/backup.test.ts
```

Without a database URL, generic crypto/safety/scheduler tests run and the real
PostgreSQL drill is explicitly skipped. Set `EIR_TEST_POSTGRES_URL` (or
`EIR_BACKUP_TEST_ADMIN_URL`) to a **disposable administrative test server** and
`PG_BIN` to PostgreSQL 18 clients to run the real custom-format dump/restore.
The test creates unique databases and roles and drops them in cleanup; it never
uses the URL's existing database as a restore target. It checks synthetic signed
note/order/assignment evidence, audit hash rows, ACLs, auth-state purging,
wrong-key zero-write behavior, nonempty and active-target rejection, and the
remaining recovery fence. This generic fixture is not evidence of clinical
workflow validation.

The separate [application recovery test](../tests/postgres-recovery.test.ts)
creates records through the real EHR services, then verifies a restored signed
note, laboratory order, staff assignment, audit chain and authorized clinical
operation. It also checks that restored sessions cannot authenticate. Run it
alongside the provider and clinical tests with `npm run test:postgres`. These
automated synthetic checks do not replace a deployment-specific recovery drill
or clinical acceptance testing.

For Docker CI, use executable `PG_BIN/pg_dump` and `PG_BIN/pg_restore` wrappers
which call the running **PostgreSQL 18** service container's real clients. Forward
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, `PGCONNECT_TIMEOUT` and
`PGAPPNAME` via `docker exec -e NAME`; use port 5432/loopback _inside that
disposable container_. Preserve stdin with `docker exec -i` for pg_restore. The
wrapper must not print credentials or mock dump contents. Alternatively install
the official PostgreSQL 18 client packages in CI and set their bin directory.

Main integration APIs in `packages/backup.ts`:

- `backupKey(environmentValue)` returns the validated 32-byte Buffer.
- `createPostgresBackup({ databaseUrl, outputPath, encryptionKey, pgBin?, signal? })`.
- `restorePostgresBackup({ databaseUrl, inputPath, encryptionKey, confirmFreshDatabase,
sourceDatabaseUrl?, runtimeDatabaseUrl?, pgBin?, temporaryDirectory?, signal? })`.
- `runBackupSchedule(asyncBackup, { intervalMs, signal, onResult?, wait? })` is the
  serial scheduler; `wait` is an injectable clock for deterministic tests. No deletion.

References: [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[PostgreSQL 18 pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html),
[Node authenticated encryption](https://nodejs.org/api/crypto.html).
