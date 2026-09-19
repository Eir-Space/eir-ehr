# Eir EHR

An open, Sweden-first electronic health record built from replaceable plugins. Apache-2.0 throughout the application. No proprietary core or required paid AI service.

**Status: working development EHR, synthetic data only.** The current release implements clinical workflows end to end. It is not a complete production EHR, a certified Swedish national-service client, or an EHDS-conformant product. The [delivery plan](docs/PLAN.md) defines the work and evidence needed to reach a clinical pilot.

## Run

Try the [public demo and collaboration page](https://eir-ehr-demo.web.app) or read the [walkthrough and contribution guide](https://eir-ehr-demo.web.app/guide.html). The custom domain is `ehr.eir.space`. Public mode gives every visitor a fresh synthetic workspace with a 30-minute lifetime. Never enter real health information. See [hosting and DNS](docs/HOSTING.md) for the separate deployment and cost limits.

Node 22.13+ (Node's SQLite API is experimental in Node 22).

```sh
npm ci
npm run terminology:import
EIR_DEMO=1 npm start
```

Open <http://127.0.0.1:4180>. Enter the temporary clinician session printed in the terminal. Sessions expire after eight hours. The token is stored hashed on the server and only in browser memory. No password, token, real patient or database ships in this repository.

Without `EIR_DEMO=1`, startup does not seed patient records. Data persists in `.data/ehr.sqlite`. The server binds only to loopback. `PORT=4181` selects another port. `EIR_CONFIG=/absolute/path/to/profile.json` selects a plugin composition. Local identity is a development plugin, not SITHS.

## Working Modules

The [persistent backend release](docs/PERSISTENCE.md) adds an asynchronous transaction contract, a replaceable PostgreSQL provider, database role-bound provider isolation, guarded migrations, encrypted logical backup/recovery tooling and a separate persistent synthetic staging profile. SQLite and the disposable public demo remain supported. See the [project overview and LinkedIn draft](docs/PROJECT-STATUS.md) for a shareable account of what works and what remains.

The [staff identity and access release](docs/IDENTITY-AND-ACCESS.md) adds OIDC login, unit/assignment/action-level authorization, staff revocation, protected-record exclusion, audit review and temporary read access. The demo uses local identities; real SITHS/HSA connectivity still needs onboarding. The legacy `eir.config.json` remains development-only; consult the clinic profile and migration notes before changing a persistent installation.

The [care-team release](docs/CARE-TEAM.md) adds daily booking/check-in, a shared assigned inbox with explicit handover, encounter-linked appointment completion and server-autosaved drafts with conflict recovery. It keeps the public workspace disposable; persistent draft recovery is available in the local persistent installation.

The [medication and results release](docs/MEDICATIONS-AND-RESULTS.md) adds versioned medication reconciliation and a local order-to-result-to-review loop. Report corrections reopen assigned follow-up; critical results require explicit acknowledgement. Neither module claims external prescribing or laboratory connectivity.

| Area                | Implemented behavior                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clinical workspace  | Swedish patient directory, encounters, chart, notes, observations, diagnoses, allergies and follow-up tasks                                                                          |
| Diagnosis catalogue | Official ICD-10-SE 2026 code/name lookup, canonical label validation and versioned coding; replaceable terminology provider                                                          |
| Record integrity    | Transactions, compare-and-set versions, note signing, immutable signed notes, linked amendments, correction history                                                                  |
| Sweden country pack | Personnummer and samordningsnummer checksum/date validation using `personnummer`, explicit 12-digit identifiers, separate birth date, local reserve IDs                              |
| Access              | Clinic profile: OIDC or local staff sessions, active unit/assignment/action policy, protected identity and expiring care relationships; legacy self/proxy policy is development-only |
| Audit               | Persisted decisions with assignment context, append-only guards, hash verification and unit-scoped manual review with cursor paging                                                  |
| AI                  | Replaceable extractive or local Ollama provider, bounded input, persisted evidence and exact citations, clinician review, stale-context rejection, draft-only acceptance             |
| APIs                | Authenticated JSON clinical API, ordered patient change feed, FHIR R4 projection including medication statements and lab orders/results                                              |
| Extensibility       | Dependency-declared services, versioned manifests, startup validation, rollback/disposal, configurable server modules and chart renderers                                            |

All displayed national-service connections are **not connected**. No fictitious connectivity or eHealth maturity scores are generated. The extractive provider is visibly identified as not using a language model.

## Develop

```sh
npm run check
npm run plugins
npx playwright install chromium
npm run test:e2e
npm run backup -- .data/ehr.sqlite /secure/path/ehr-backup.sqlite
```

`npm run check` runs TypeScript and backend tests. Browser tests use an isolated in-memory database and exercise a clinician workflow at desktop/mobile sizes. They write screenshots to `test-results/`.

## Design And Delivery

- [Architecture and decisions](docs/ARCHITECTURE.md)
- [Sweden-first delivery plan](docs/PLAN.md)
- [Plugin authoring and model replacement](docs/PLUGINS.md)
- [API contract](docs/API.md)
- [Diagnosis catalogue, import and data rights](docs/TERMINOLOGY.md)
- [Sweden, Estonia, Denmark and EU evidence](docs/SOURCES.md)
- [Operations and security boundaries](docs/OPERATIONS.md)
- [Persistent storage and staging](docs/PERSISTENCE.md)
- [Encrypted backup and recovery](docs/RECOVERY.md)
- [Project overview and contribution invitation](docs/PROJECT-STATUS.md)
- [Swedish integration stakeholders and onboarding](docs/SWEDISH-INTEGRATIONS.md)
- [Public demo hosting, cost controls and DNS](docs/HOSTING.md)
- [Social preview and regeneration](docs/SHARING.md)

The plugin design is informed by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its Cordis-based service composition. Eir implements its own small typed runtime; it does not bundle the harness or claim Cordis compatibility.

FHIR export is an interoperability projection, not a full FHIR server, IPS document, SMART launch server, terminology server, or national implementation-guide certification. Model citation checks establish source existence, not clinical correctness. Signed notes record authenticated application attestation, not qualified electronic signatures.

Contributions: read [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
