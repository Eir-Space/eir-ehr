# Persistent Clinic Backend

This milestone supplies a real PostgreSQL provider and a persistent synthetic staging profile. It does not authorize a live patient deployment, replace national-service onboarding, or provide a managed hosting SLA.

## Storage Contract v2

All storage and stateful clinical/identity/access service methods return promises. `Store.transaction(async () => ...)` is an awaited unit of work. A domain mutation, version snapshot and success audit commit together; a failed operation cannot leave a successful partial record behind. Nested transactions join the same unit and a nested failure makes the entire unit rollback-only.

PostgreSQL uses one checked-out client per unit of work and serializable isolation. Expected record versions still control updates; stale edits never silently overwrite newer content. Transaction callbacks must be replayable and database-only: no network calls, notifications, model inference, file writes or external side effects. Model generation happens outside the transaction, with authorization and evidence rechecked before storage. Exhausted database contention is an explicit conflict, not an automatic last-write-wins update.

SQLite remains available for local single-process installations and public visitor workspaces. Its asynchronous adapter serializes callers around the synchronous connection, including across awaits. Signed-note, append-only version and audit guards remain in place. This is not a multi-process SQLite deployment recommendation.

Runtime API version 2 intentionally rejects version 1 plugins. Third-party replacements must update their method signatures, await operations and asynchronous cleanup, and rerun the contract suite. The HTTP payloads and renderer contract are unchanged. SQLite's on-disk schema remains version 2; runtime API versions and database migration versions are separate.

## Provider Isolation

The PostgreSQL plugin is bound to one healthcare provider and one database login. The operator provisions a database-side role-to-provider mapping. RLS uses the authenticated role, not a request header or a caller-set tenant variable. Every provider-data table has forced RLS, including sessions, login transactions, versions and audit metadata. Within-provider care-unit, patient and action authorization still belongs to the access modules.

The application refuses privileged runtime accounts: no superuser, BYPASSRLS, ownership, role membership or database/schema creation rights. The runtime cannot edit tenant mappings, migration metadata, audit heads or existing audit/version rows. A fixed-search-path database trigger appends the audit chain. Database operators and trusted in-process plugins remain inside the trust boundary; this is not protection against a compromised host or a malicious database administrator.

Use distinct runtime credentials per provider. Do not configure multiple providers in one runtime's workforce units. Certificate-verified TLS is required outside explicit loopback-only local development. Keep migration/backup credentials out of the application environment.

## Migrations

Migrations run as a separate operator command, never automatically with application credentials. DDL and the version/checksum ledger commit together under a migration lock. Startup rejects pending, newer or modified migration history, unsafe runtime permissions, disabled RLS and an invalid audit chain.

Create a restricted login using your database administrator, then set the migration URL through your secret management system:

```sh
npm run db:migrate -- --tenant YOUR_PROVIDER_ID --runtime-role YOUR_EXISTING_RUNTIME_ROLE
```

The default operator variable is `EIR_POSTGRES_MIGRATION_URL`. The runtime profile uses a different variable, such as `EIR_DATABASE_URL`. Never place credentials in JSON profiles or commit them. For local loopback staging only, add `--local-development-only` to the migration command.

Replace the storage entry in a reviewed clinic profile with:

```json
{
  "module": "./plugins/storage-postgres.ts",
  "config": {
    "tenant": "YOUR_PROVIDER_ID",
    "connectionStringEnv": "EIR_DATABASE_URL"
  }
}
```

There is no implicit SQLite-to-PostgreSQL transfer. Changing providers points at a different database. Existing clinical data needs an explicitly reviewed migration with patient/reference reconciliation, preserved versions/audit evidence and cutover validation. Do not repoint an installation and assume the records moved.

## Persistent Synthetic Staging

`eir.staging.config.json` and `apps/staging-server.ts` are separate from `eir.demo.config.json` and the public website. The staging tenant is fixed to `eir-synthetic-staging`; it uses local synthetic identities and binds only to loopback. Four fictional patients are seeded atomically on first empty startup. Restart does not reset the clinic, restore revoked assignments or reseed existing records.

`compose.staging.yml` provides a PostgreSQL 18 service on `127.0.0.1:55433`, backed by a named Docker volume. Supply a unique `EIR_STAGING_ADMIN_PASSWORD` outside the repository:

```sh
docker compose -f compose.staging.yml up -d
```

In that database, create the restricted `eir_staging` login and set its password using your administrator's secure provisioning tool. Set `EIR_POSTGRES_MIGRATION_URL` to the administrator URL for database `eir_staging`, and `EIR_STAGING_DATABASE_URL` to the restricted login URL for the same database. Then:

```sh
npm run db:migrate -- --tenant eir-synthetic-staging --runtime-role eir_staging --local-development-only
EIR_SYNTHETIC_STAGING=1 npm run staging
```

Open `http://127.0.0.1:4194` and use the local synthetic session printed by the server. Another `PORT` selects a different loopback port. Keep this profile off public hosting: it has intentionally local identity assurance and persistent shared synthetic records. The public demo remains disposable, and no paid cloud database is provisioned by these commands.

`docker compose -f compose.staging.yml down` stops the database without deleting the named volume. Do not add `--volumes` unless intentionally destroying the staging data. A retained volume is not a backup.

## Recovery And Acceptance

See [RECOVERY.md](RECOVERY.md) for authenticated encrypted logical backups, fresh-target restoration, session invalidation and scheduling. Point-in-time recovery, off-host immutable storage, key custody/rotation, monitoring and clinic-agreed RPO/RTO remain deployment work. A local successful restore drill does not establish production recovery capacity.

`/health` is liveness; `/ready` checks the database and returns 503 without driver details when unavailable. Shut down by draining HTTP work and awaiting storage disposal. Startup verifies the audit chain; it is not externally anchored evidence against a privileged database operator.

The database test suite uses real PostgreSQL connections, not an in-memory SQL emulator. Set `EIR_TEST_POSTGRES_URL` to a disposable administrator database and run `npm run test:postgres`. Tests create their own synthetic databases/roles; never use a clinical database or production credentials. CI runs PostgreSQL 18 alongside the backend and browser suites.

Acceptance evidence should cover concurrent editors and bookings, rollback when audit writes fail, provider isolation through direct SQL, signed-note immutability, session/login boundaries, restart persistence, migration failure and a verified backup restored into an isolated database. Preserve the test and restore output with each release.

The current automated PostgreSQL tests use a loopback development connection. TLS configuration is validated, but a certificate-backed remote handshake, certificate rotation and failure recovery still need environment-specific acceptance tests.

## Technical References

- [PostgreSQL row security and role bypass rules](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [node-postgres transaction client requirements](https://node-postgres.com/features/transactions)
- [PostgreSQL continuous archiving and point-in-time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html)
