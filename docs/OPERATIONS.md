# Operations And Trust Boundaries

## Current Deployment

This release is for synthetic development data. The local server binds to `127.0.0.1`. Profiles select SQLite or PostgreSQL storage and local or OIDC identity. The public demo uses independent disposable SQLite workspaces; persistent PostgreSQL staging is separate. See [PERSISTENCE.md](PERSISTENCE.md) and [IDENTITY-AND-ACCESS.md](IDENTITY-AND-ACCESS.md). Encrypted logical backup/recovery is implemented, but managed encryption at rest, real professional identity onboarding, national connections, the full Swedish rights model, high availability and external immutable audit storage remain deployment work. A public proxy does not make this a clinical deployment.

SQLite transactions use WAL, full synchronous writes, foreign-key checks, a busy timeout, parameterized queries, append-only version/audit guards and an immutable signed-note trigger. Clinical creation/revision and successful write audit commit atomically. Authorization decisions are appended before data is returned. The audit chain is checked on startup. A privileged database operator can still replace/truncate/recompute the file and chain; external signed checkpoints and WORM archives remain necessary for stronger tamper evidence.

Session secrets are random and only token hashes are stored. Local development bearer tokens stay in browser memory; the OIDC profile uses HttpOnly cookies, inactivity expiry and bounded absolute lifetimes. Revocation is implemented, and restored sessions/login transactions are purged before the recovery fence can be released. The server does not log request bodies, authorization headers, identifiers or records. Infrastructure authentication monitoring remains an operational layer to deploy.

## Backup And Restore Drill

PostgreSQL has separate encrypted backup, non-overlapping scheduling and guarded fresh-database restore commands. The real-EHR drill verifies preserved records, signed-note immutability, assignments, orders, audit chains and invalidated authentication state. See [RECOVERY.md](RECOVERY.md). Logical backups are not PITR; remote retention, key custody, monitoring and agreed recovery targets remain explicit operator responsibilities.

Public mode is a separate entry point and plugin profile, described in [HOSTING.md](HOSTING.md). It creates one in-memory runtime/database per visitor and never loads the local persistent database. Limits, origin checks, an explicit demo-mode start payload and expiry are enforced server-side. The public start page carries a concise demo notice, not a legal consent workflow. Expiry is checked on every API access; memory cleanup runs when CPU is available or on the next workspace creation. Request-based Cloud Run may suspend idle timers. Expired records remain inaccessible even before memory cleanup. This mode is for temporary synthetic demonstrations only.

Run `npm run backup -- .data/ehr.sqlite /secure/path/backup.sqlite`. This uses SQLite's online backup API, not an unsafe copy of the main file while WAL writes are in flight. The destination must not exist. Protect backup permissions and encrypt at the storage boundary; the script does not implement encryption.

For a local restore drill: stop the application, preserve the current database and its WAL/SHM files as a unit in a separate recovery directory, restore the backup to a clean configured path, and start with that path in the storage plugin configuration. Verify patient/record counts, last committed notes, audit-chain verification and an authorized chart read. Do not overwrite a running database. Production recovery must use agreed RPO/RTO, separate keys and restore exercises with signed evidence.

## Threats And Enforced Controls

| Threat                                       | Current control                                                                             | Remaining work                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Forged role/tenant headers                   | Authentication resolves server-side actor; client role headers ignored                      | Strong eID and verified professional attributes                            |
| Wrong-patient or wrong-tenant writes         | Tenant query scoping, PostgreSQL role-bound RLS, encounter ownership and active-care checks | Complete protected-identity lifecycle and country-specific rights policy   |
| Lost update or altered signed note           | Expected versions, immutable note triggers, amendments, real PostgreSQL concurrency tests   | Production-scale load/soak tests and deployed failover exercises           |
| Missing access audit                         | Audit before disclosure; write audit in same transaction                                    | External anchoring, review queue and archival retention                    |
| Model fabricated source                      | Exact record/version quotes checked; proposals reviewed                                     | Clinical correctness evaluation; quotations alone cannot prove correctness |
| Changed permissions/context during inference | Recheck access after inference; compare evidence again on acceptance                        | Cancellable jobs and cross-process inference orchestration                 |
| Dependency/plugin compromise                 | Operator-selected source, lockfile, dependency audit                                        | Signed distribution, SBOM, isolated untrusted extension runtime            |
| Browser data disclosure                      | Escaping, CSP, no-store, no embedded bearer, no third-party assets                          | Dedicated security review, CSP regression and assistive-technology tests   |

The current patient restriction is intentionally coarse: it blocks assigned clinician/proxy access while preserving self-access. It is not an implementation of Sweden's unit/provider-specific record blocks, emergency overrides, age-dependent proxy rights or all patient rights. No emergency override is silently granted.

## Release Evidence

Required baseline: TypeScript, backend contract/security tests, the browser workflow, dependency audit, migration review and changelog. Every authorization or record-lifecycle change needs regression coverage. Model changes need a separately versioned clinical evaluation result. National adapters need their own service conformance and operational acceptance. Use the milestone gates in PLAN.md before changing the stated deployment status.
