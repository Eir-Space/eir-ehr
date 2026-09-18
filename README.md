# Eir EHR

An open, Sweden-first electronic health record built from replaceable plugins. Apache-2.0 throughout the application. No proprietary core or required paid AI service.

**Status: working development EHR, synthetic data only.** The current release implements clinical workflows end to end. It is not a complete production EHR, a certified Swedish national-service client, or an EHDS-conformant product. The [delivery plan](docs/PLAN.md) defines the work and evidence needed to reach a clinical pilot.

## Run

Try the [public demo and collaboration page](https://eir-ehr-demo.web.app) or read the [walkthrough and contribution guide](https://eir-ehr-demo.web.app/guide.html). The custom domain is `ehr.eir.space`. Public mode gives every visitor a fresh synthetic workspace with a 30-minute lifetime. Never enter real health information. See [hosting and DNS](docs/HOSTING.md) for the separate deployment and cost limits.

Node 22.13+ (Node's SQLite API is experimental in Node 22).

```sh
npm ci
EIR_DEMO=1 npm start
```

Open <http://127.0.0.1:4180>. Enter the temporary clinician session printed in the terminal. Sessions expire after eight hours. The token is stored hashed on the server and only in browser memory. No password, token, real patient or database ships in this repository.

Without `EIR_DEMO=1`, startup does not seed patient records. Data persists in `.data/ehr.sqlite`. The server binds only to loopback. `PORT=4181` selects another port. `EIR_CONFIG=/absolute/path/to/profile.json` selects a plugin composition. Local identity is a development plugin, not SITHS.

## Working Modules

| Area                | Implemented behavior                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clinical workspace  | Swedish patient directory, encounters, chart, notes, observations, diagnoses, allergies and follow-up tasks                                                              |
| Record integrity    | Transactions, compare-and-set versions, note signing, immutable signed notes, linked amendments, correction history                                                      |
| Sweden country pack | Personnummer and samordningsnummer checksum/date validation using `personnummer`, explicit 12-digit identifiers, separate birth date, local reserve IDs                  |
| Access              | Hashed local sessions, tenant scoping, expiring care relationships, expiring proxy grants, patient self-access and a coarse patient restriction                          |
| Audit               | Persisted read/write decisions, append-only SQL guards, hash-chain verification on startup                                                                               |
| AI                  | Replaceable extractive or local Ollama provider, bounded input, persisted evidence and exact citations, clinician review, stale-context rejection, draft-only acceptance |
| APIs                | Authenticated JSON clinical API, ordered patient change feed, seven-resource FHIR R4 export projection                                                                   |
| Extensibility       | Dependency-declared services, versioned manifests, startup validation, rollback/disposal, configurable server modules and chart renderers                                |

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
- [Sweden, Estonia, Denmark and EU evidence](docs/SOURCES.md)
- [Operations and security boundaries](docs/OPERATIONS.md)
- [Public demo hosting, cost controls and DNS](docs/HOSTING.md)

The plugin design is informed by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its Cordis-based service composition. Eir implements its own small typed runtime; it does not bundle the harness or claim Cordis compatibility.

FHIR export is an interoperability projection, not a full FHIR server, IPS document, SMART launch server, terminology server, or national implementation-guide certification. Model citation checks establish source existence, not clinical correctness. Signed notes record authenticated application attestation, not qualified electronic signatures.

Contributions: read [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
