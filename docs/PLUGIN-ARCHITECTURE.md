# Plugin Architecture: everything swappable

Status: slices 1 to 7 plus the first template-first clinical authority slice are implemented (declarative profiles, model router, content seam, projection, verified reads, AI evidence, model gate and canonical openEHR vital signs). Later clinical kinds remain proposed. Reference: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (seams, layered profiles, patch rows, `--dump-config`). Eir keeps its own small typed runtime; it does not adopt Cordis.

## Principle

A **seam** has three roles: a service definition (the TypeScript contract in `packages/contracts.ts`), a provider (a plugin), and a consumer (another plugin or a model-facing tool). Anything a deployment might change, such as a model, terminology, country pack, identity, storage, transport or renderer, is a seam. Clinical safety logic (record integrity, authorization, audit, evidence validation, review state machine) is never swapped by a provider; it wraps providers.

## Implemented (slice 1)

| Piece            | File                                                        | What it gives                                                                                                                                     |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin manifest  | `packages/plugin-manifest.ts`, `plugins/<name>.plugin.yaml` | Declared network egress, data classes, isolation, and ML `intendedUse`. Must match the code or startup fails.                                     |
| Layered profiles | `packages/profile.ts`                                       | YAML (or JSON) profiles with `extends`, rows with stable ids, and patches: `replace`, `remove`, `disable`, `configure`, `insert` before or after. |
| Policy           | `policy:` in a profile                                      | Fails startup if a plugin declares more egress, a denied data class, a disallowed isolation mode, or a language model without evidence.           |
| Dump             | `EIR_CONFIG=<profile> npm run plugins -- --dump`            | Prints the resolved rows, which layer produced each, and manifest status, without starting any plugin.                                            |

Existing JSON profiles load unchanged. `eir.local-model.profile.yaml` shows swapping the AI provider with a five-line overlay.

Manifests exist for the two AI providers only. A policy with `requireManifest: true` will reject every plugin that has none, so add manifests before enabling it.

**Not enforced.** Manifests and policy are declarations checked at startup. An in-process plugin still runs with application privileges and can ignore its manifest. Real enforcement needs slice 4.

## Implemented (slice 2): many-provider seams and the model router

A service has one provider. A **contribution** seam lets many plugins register named values under one name (`aiModel` today). `plugins/model-ollama.ts` and `plugins/model-extractive.ts` each register a named candidate; two Ollama models can coexist under different keys. `plugins/ai-router.ts` provides the single `aiProvider` that `ai-review` already consumes, so no consumer changed. It tries the configured `chain` in order and falls back on error or timeout.

Safety properties, all tested in `tests/ai-router.test.ts`:

- A model whose declared network reach exceeds `maxNetwork`, or that declares none, is never called. Fallback cannot silently send clinical text somewhere the operator did not allow.
- Failure messages carry only the error type, because a model error can echo clinical text.
- Which model answered is recorded on the proposal (`model`, and `provider` as `router:<chain>`), and the extractive provider labels itself as not a language model.
- Registrations are removed on teardown; undeclared or duplicate keys fail startup.

`ai-review` still owns citation validation, stale-context rejection and the clinician review state machine, whichever model answers.

Known limit: the router resolves the chain at call time, so a typo in `chain` fails the first request rather than startup.

## Run locally

```sh
npm run dev:local                 # synthetic demo data, loopback only, router traces to stderr
npm run plugins:dump              # resolved rows, layers and manifest status, nothing started
```

`eir.local.profile.yaml` extends the dev profile and sets the chain `[ollama-local, extractive]`. If Ollama is not running, the router falls back to the extractive provider and the app still works. Edit `model` to one you have installed. `EIR_CONFIG=<file> npm run plugins:dump` prints any profile. Verified here: a real `qwen3.5:4b` proposal through `POST /api/patients/:id/ai` took about 11 seconds.

## Content seam (slice 3)

`packages/content.ts` defines `ContentStore`: versioned clinical facts with identity, time, optimistic concurrency, tenant isolation, and immutable signed notes. Providers register under the `contentStore` contribution and must pass one shared conformance suite, `tests/content-contract.ts` (8 cases: round-trip of every kind, version bump and history, stale and concurrent revision, tenant and patient isolation, unknown ids, signed-note immutability, unsupported kinds).

| Provider         | File                                                | Backend                                  | Conformance                           |
| ---------------- | --------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| JSON (reference) | `plugins/content-json.ts`                           | the configured `store`                   | 8 of 8                                |
| openEHR          | `plugins/content-openehr.ts`, `packages/openehr.ts` | EHRbase 2.36.0 (Apache-2.0), tested here | 8 of 8, plus an AQL-by-archetype test |

### How the openEHR provider maps Eir to openEHR

- One EHR per (tenant, patient), keyed by the EHR subject. The tenant is the subject namespace, and a composition is only returned if its EHR belongs to the caller's tenant.
- Each Eir record is one composition. Eir's `version` is the openEHR version number, so `revise` is a native `PUT` with `If-Match`, and a concurrent writer gets a 412 that becomes Eir's 409.
- Clinical content goes to archetyped paths: vitals to the IDCR vital signs observations (UCUM `Cel` is written as `°C`, SpO2 as a proportion), diagnoses to the problem list with the ICD-10-SE code kept as a coded value, notes to the clinical synopsis.
- Eir workflow fields (author, status, encounter link, signing) travel as JSON in the composition's `feeder_audit.original_content`. On read, the archetyped paths are canonical: the envelope only preserves representation (for example the timestamp notation) while the values agree, so an edit made in another openEHR system wins.
- Verified against the live server: data written through Eir is returned by plain AQL by archetype (for example `OBSERVATION o[openEHR-EHR-OBSERVATION.pulse.v1]` and `EVALUATION p[openEHR-EHR-EVALUATION.problem_diagnosis.v1]`) with no Eir involved.

### Run it locally

```sh
npm run openehr:up        # EHRbase 2.36.0 + Postgres on 127.0.0.1:8090, isolated from any other EHRbase
npm run openehr:setup     # uploads templates/openehr/*.opt (idempotent)
npm run test:openehr      # conformance suite + AQL test against it
npm run openehr:down
```

`docker/compose.openehr.yml` uses disposable credentials, binds to loopback only, and publishes no database port. `npm run dev:local` registers both content stores.

### Current authority modes and known limits

- **Projection mode remains available.** `eir.local.profile.yaml` keeps SQL authoritative and feeds openEHR afterwards. It is useful for migration tests and for clinical kinds that have not moved.
- **Template-first mode is implemented for vital signs.** `eir.openehr.profile.yaml` removes the projector for observations, loads the pinned model registry and routes observation commands directly to openEHR. Chart, history, typed query, deterioration, AI evidence and FHIR export resolve those records from the repository.
- **Unmappable data is refused, not stored lossily.** The active vital-sign template has no body weight, so weight observations fail with 422. Systolic and diastolic pressure are captured together and stored in one composition.
- **The migration is deliberately partial.** Notes, conditions, allergies, medications and encounter workflow are still SQL-authoritative. Their existing openEHR mappings prove adapter behavior; they are not yet model-led capture paths.
- **Workflow state is not queryable.** Note and problem `status`, signing and encounter link live only in the envelope. Promoting them to archetyped paths needs a local template.
- **Coded diagnosis is not template-enforced.** The template's problem name is plain text; EHRbase accepted and returned the coded value, but the template does not require a code.
- **Lookup by id probes 64 version UIDs** because EHRbase AQL has no prefix match on `uid`. Results are cached per process; a record with more than 64 versions cannot be found cold.
- **Reads cost several requests per record** (composition plus revision history), so `list` is built for synthetic scale only.
- **EHRbase's own commit audit names the service account.** The clinician is recorded as composer and in the envelope, and Eir's audit chain stays separate and non-atomic with it.
- **Template licensing is unverified** (see `templates/openehr/README.md`).
- `systemId` defaults to `local.ehrbase.org`; change it if the server is configured otherwise.

### Template-first authority

The implemented decision is [ADR-002](ADR-002-TEMPLATE-FIRST-CLINICAL-RECORD.md). SQL is not treated as a universal clinical source merely because it remains the operational database. Authority is selected per record kind, capture is derived from the active clinical model, and direct repository writes use an idempotent, recoverable operation protocol. Deterministic mappings are code; an LLM is never trusted to invent a conversion.

## Audit and transaction boundary: the projection (slice 4)

**Problem.** `clinical` commits a record, its version snapshot and its hash-chained audit row in one SQL transaction, and transaction callbacks must be database-only and replayable. EHRbase cannot join that transaction, so routing a write to it directly would break atomic audit.

**Decision for projection profiles.** The SQL store stays authoritative. The content store is a derived, queryable representation fed afterwards by `plugins/projection.ts` (logic in `packages/projection.ts`). There is one writer path and then replication, not a dual write. A content-store outage never blocks or rolls back a clinical write. This remains the legacy/migration mode and is not the observation authority model in `eir.openehr.profile.yaml`.

**How it works.**

- Each record gets a `contentLink` row in the ledger (hidden from charts) before the content store is touched. It carries an idempotency token and the last synced version.
- The record's version history is replayed into the target in order, so the target version equals the ledger version. After writing, the target's data is compared with the ledger; a difference is recorded as an error, not hidden.
- Every link change is a hash-chained audit row by actor `projection`, so every disclosure of clinical content to the target is on the audit trail.
- Failures are recorded with a fixed safe reason (never error text, which can echo clinical text) and retried with exponential backoff up to 5 minutes. Data the target cannot represent (for example body weight) is marked `unmapped`, retried only if the record changes, and never blocks other records.
- `reconcile` classifies each record as `ok`, `unlinked`, `behind`, `ahead`, `diverged`, `missing`, `unmapped`, `error`, `pending` or `duplicate-link`, and reports counts and record ids only.
- A target must support idempotent insert (`findByOrigin`) or the projector refuses it, because otherwise a crash could duplicate a clinical record.

**Failure matrix, each covered by `tests/projection.test.ts`.**

| Failure                                                          | Result                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Crash after the content was written, before the link was updated | Retry finds the record by its token; no duplicate                     |
| Crash part-way through a multi-version history                   | Retry resumes from the target's own version                           |
| Target down                                                      | Link records `error`; backoff; recovers by itself                     |
| Target cannot represent the data                                 | `unmapped`, recorded once, others unaffected                          |
| Target edited behind Eir's back                                  | `diverged`, `ahead` or `missing` in reconcile; never auto-overwritten |
| Record changed during a run                                      | Treated as transient and retried                                      |

**Run it.**

```sh
npm run openehr:up && npm run openehr:setup
EIR_CONFIG=eir.local.profile.yaml npm run projection:run         # one pass
EIR_CONFIG=eir.local.profile.yaml npm run projection:reconcile   # exit code 2 if anything is not ok
EIR_CONFIG=eir.local.profile.yaml npm run projection:loop        # repeat every 15 s
```

Verified end to end in `tests/projection-openehr.test.ts`: a real clinical workflow (observation, unmappable weight, diagnosis, note saved and signed) is projected into EHRbase, queried back by archetype with plain AQL, and reconciles clean. Run against the demo data, four records projected and reconciled `ok`.

**Limits.**

- Run one projector per target. Two concurrent projectors could create two links for one record; reconcile reports `duplicate-link`, but nothing prevents it yet.
- The lag between a ledger write and its projection is the run interval. Nothing is real time.
- The projection is replication, not migration. A record deleted or erased in the ledger is not propagated; there is no deletion endpoint yet, so retention and erasure need their own design.
- Tested on the SQLite ledger only. The PostgreSQL ledger uses the same store interface but was not exercised with the projection.
- `contentLink` rows add several audit rows per record (created, linked, synced). That is intended evidence, and it also grows the audit chain.
- Content is replicated as identified clinical data, so the target needs the same protection as the ledger.

## Read path: typed, ledger-verified queries (slice 5)

`plugins/clinical-query.ts` (logic in `packages/clinical-query.ts`) serves clinical reads from the content store, so agents and analytics get a typed query surface instead of the ledger's fixed endpoints. It exists for AI use, so the design assumes the consumer cannot judge a partial answer unaided.

**Surface.** `clinicalQuery.vitals(actor, patientId, {code, from?, to?, limit?})` and `clinicalQuery.problems(actor, patientId, {status?})`, also at `GET /api/patients/:id/query/vitals` and `/query/problems`, documented in `/api/openapi.json`. Providers implement them natively (openEHR AQL) or derive them from `list` (`packages/content-query.ts`), and the same conformance case checks every provider.

**What makes an answer safe to hand to an AI.**

- **Callers pick a query, never write one.** The openEHR provider builds AQL only from a fixed table of archetype paths (taken from the template's web-template metadata) and bound parameters. Input is validated first (LOINC-shaped code, ISO times, bounded limit).
- **Authorization on the ledger, then audit.** Clinicians only. The care-relationship check runs in a ledger transaction before anything is read from the content store, and a refused caller causes no content-store read. A successful query is a hash-chained audit row (`query.vitals`, `query.problems`).
- **Authority is respected.** A projected row is served only when its link, version and values agree with the SQL-authoritative record. A canonical row is first resolved from the repository; SQL contributes its Eir identity and workflow link, not a competing clinical value. Records corrected as entered-in-error are not part of the question.
- **Every answer says how complete it is.** `coverage` counts ledger records as `served`, `notProjected`, `unmapped`, `stale` (copy behind the ledger), `diverged` (copy disagrees, or was changed outside Eir) or `missing`. `complete` is true only when every matching ledger record was served. `foreign` counts content-store rows no ledger record explains, which are never served. `truncated` flags the 500-row cap.
- **Provenance per row.** `ref` is `entityId@version`, the same reference form AI evidence already uses, so a cited point can be traced to a ledger version.
- **Unmappable is an answer, not an error.** Asking for body weight returns no points and `unmapped: 1`.

Verified in `tests/clinical-query.test.ts` (memory target, including the real HTTP route), `tests/clinical-query-openehr.test.ts` (EHRbase) and `tests/template-first-clinical.test.ts`. In projection mode, an edit made behind SQL is withheld and counted as `diverged`. In canonical mode, the same repository-side revision is returned as current while the stale SQL mirror is ignored.

**Limits.**

- **AI evidence** uses this service for earlier vital readings only; see the next section.
- **FHIR is still a projection.** The exporter consumes the authorized clinical chart. In canonical mode that chart has already resolved openEHR observations; FHIR is never a second clinical authority.
- **Two query kinds only** (vital series, problems). Notes are not queryable, and `status` filtering uses the ledger because status is not an archetyped field.
- **Clinicians only.** Patient and proxy access to queries needs a release policy.
- **Fetch then filter.** The provider returns up to 500 rows per patient and code, and the service filters by time window. Population-scale queries need a different surface.
- **Freshness depends on authority mode.** Projection mode has interval lag and reports `notProjected`. Canonical mode reads the repository directly and fails closed if it is unavailable.
- **A vacuous answer is `complete`.** A patient with no matching ledger record gets `complete: true` with zero points; read `coverage.ledger`.

## AI evidence from verified history (slice 6)

`ai-review` can add earlier readings from other encounters to a proposal's evidence, so a draft can cite a trend instead of only today's values. It is off unless a profile sets `history` on the `ai-review` row (`config: { history: { perCode: 3 } }`, optional `codes` and `lookbackDays`), and it needs the `clinicalQuery` service.

**Rules, chosen to fit the stale-context check.** Canonical chart resolution happens before the SQL transaction. Permission, encounter and proposal mutations are then rechecked transactionally, and acceptance compares the proposal with a newly resolved chart.

1. **Selection and content follow authority.** The content store decides which earlier readings are eligible through the query service. Projected records are verified against SQL; canonical records are resolved from the repository. Evidence text is built from the same authorized chart the clinician sees.
2. **History items are pinned.** A pinned item stays valid while its Eir identity/version is unchanged, it is uncorrected and its resolved evidence text is identical. Correcting or revising canonical content after the proposal makes accept fail with 409. A reading made later in another encounter does not invalidate it.
3. **Encounter evidence is unchanged.** Any change to the open encounter's evidence still invalidates the proposal exactly as before. Existing proposals and profiles behave identically.
4. **Best effort.** History is gathered outside any transaction after authorization. A content-store outage never blocks a proposal; it is recorded.
5. **The proposal says what it knew.** `historyRefs` lists the pinned items, and `historyContext` records, per vital code, whether the query worked and how many records were served against how many exist, plus `complete`. Counts only, no clinical text.
6. **Bounded.** At most `perCode` items per code, from the lookback window, and the existing 60 000-character evidence limit still applies.

**Runtime change.** Plugins can declare `optionalRequires`. If a plugin in the profile provides the service it starts first and `ctx.has` is true; otherwise the plugin still starts and `ctx.has` is false. Reading an undeclared dependency still throws.

**Verified.** `tests/ai-history.test.ts` and `tests/runtime-optional.test.ts`: pinned history is cited and accepted; a correction invalidates the proposal; diverged or unprojected readings are excluded and flagged; an outage degrades to ledger-only evidence; history stays off without configuration. A live run used the local `qwen3.5:4b` model with real EHRbase: three earlier pulse readings (58, 61, 64) were selected via AQL, verified, cited, and the proposal was accepted into a draft note.

**What the live run also showed, which the checks cannot catch.** The model described the pulse as falling from 61 to 58, when the readings rose from 58 to 64 over three days, and wrote some incoherent Swedish and an assumed pronoun. Every citation was valid, because citation checks establish that a source exists and the quote is in it, not that the summary is correct. This is the documented limit, now seen with longitudinal data. Clinician review remains essential, and a clinical evaluation set (including trend direction) is needed before any clinical use. History is listed newest first; whether chronological order reduces such errors is untested.

**Limits.**

- Vital signs only. Problems are already in the ledger evidence, and notes are not queryable.
- Canonical history requires a second repository read at acceptance. An outage blocks acceptance rather than accepting evidence that cannot be revalidated.
- The query service is clinician-only, so a non-clinician with `ai.use` gets no history (recorded as unavailable).
- Each proposal makes one query per configured code, so latency grows with the number of codes.

## Clinical evaluation and the model gate (slice 7)

A language model can only be enabled for drafting notes if it has passed an evaluation for that exact model, on the current suite, recently. This replaces trusting a model because it seems fine in a demo: the live run in slice 6 produced one draft that called a rise a fall, and the evaluation exists to make such failures measurable.

**What runs.** `npm run eval -- --model <ollama model>|extractive [--repeat n] [--only ids] [--out file]` runs 7 synthetic Swedish cases (`evals/cases/*.yaml`) through the real proposal pipeline: record, projection, verified history, evidence, the model, citation validation. The model is wired in directly, never through the router, so a fallback cannot hide a failing model behind the extractive provider. It writes a report (`evals/reports/`) and exits 1 unless every case passed on every repeat.

**What it checks** (`packages/eval-checks.ts`, deterministic, no model judge):

| Check                           | Catches                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `trend-contradiction`           | A rising series called falling (or the reverse), or a flat one called a change                       |
| `number-not-in-evidence`        | A value with a unit that is not in the evidence                                                      |
| `history-claim-without-history` | Comparison language when no earlier reading was available, including when the content store was down |
| `unsupported-pronoun`           | A pronoun the record does not contain                                                                |
| `treatment-advice`              | Recommendation or treatment wording the record does not contain                                      |
| `missing-citation`              | A required record (for example today's reading) not cited                                            |
| rejected                        | An invalid citation, a provider error or a timeout counts as a failure of the model                  |

Cases cover rising, falling and stable pulse, a first visit, a content-store outage, systolic pressure with real values, and a coded diagnosis with no advice. Safety checks (trend, numbers, history, pronoun, advice) and a completeness check (`missing-citation`) are different things; a model can fail the second while being safe.

**The gate.** A profile can set `policy: { requireEvaluation: { useCase: draft-note, maxAgeDays: 90 } }` and list `evaluations: [{ row: <row id>, report: <path> }]`. At startup every language-model plugin row must have a report that:

- passed, with no failed run, and covers every current case;
- is for the same family and model as the row (`evaluationFamily` in the plugin manifest, and `config.model`);
- matches the current suite hash (cases, checks, runner and `ai-review`), so changing any of them invalidates old reports;
- is no older than `maxAgeDays` and not dated in the future.

Anything else refuses to start with the reason. Plugins that use no language model (the extractive provider) need no report.

**Results here.**

- Extractive baseline: 7 of 7. It copies evidence, so this shows the checks do not flag grounded text.
- Local `qwen3.5:4b` through real EHRbase: **failed**, 5 of 7 on the full run. It did not cite the current reading in two cases. A repeat of the two trend cases four times each failed 4 of 8 runs: three missing citations and one provider failure, probably the 30 second request timeout. **No reversed trend appeared in 15 trend runs**, although one occurred earlier in a live demo, so that failure is real but rare and shows why repeats matter. A profile that requires evaluation refuses this model with `evaluation did not pass (2 of 7 runs failed)`.
- The scripted-model tests (`tests/eval.test.ts`) prove each check fires on a draft built to trigger it, and `tests/eval-gate.test.ts` proves each way a report can be invalid is refused.

**Limits. Passing is not clinical validation.**

- The checks are heuristics over a small Swedish lexicon. They detect known failure modes, not arbitrary wrong statements. A draft can pass and still be clinically wrong or misleading, and the trend check only looks at sentences that name the vital.
- Seven cases and one use case (`draft-note`) is a start. The cases are synthetic, short, and were written alongside the checks, so they are not an independent benchmark. A clinical evaluation needs cases written and reviewed by clinicians, including negative cases from real near-misses.
- Prompt injection is not covered. A reliable automatic check was not possible because a draft may legitimately quote the note.
- A report is a plain JSON file. The gate is a process control: anyone who can edit the file can forge it. Review, CI, or signing the report would close this; none is done.
- Language models are nondeterministic. Use `--repeat` of at least 3 for any report you intend to rely on; the default of 1 is for development.
- The gate keys on `config.model` and the manifest family, so it does not see a model that is swapped behind the same name on the server.
- Plugins with no manifest are not gated, so combine with `requireManifest`.
- The 30 second request timeout in the Ollama plugin makes slow hardware fail the evaluation; that is a real operating condition, not noise.

## Proposed next slices

1. **Typed hooks.** Serial and parallel events such as `ai/pre-call`, `ai/post-call`, `record/pre-commit`, `export/pre-send`. Hooks may reject or annotate, never write clinical state. This is how audit, redaction, rate limits and evaluation sampling attach without editing the core.
2. **Declarative skills.** A skill is a plugin with no code: YAML plus prompt and tool allowlist plus an evaluation set, loaded by the agent surface. It declares inputs and the permissions it needs, and cannot activate unless its evaluation report meets the profile's gate.
3. **Out-of-process plugins.** A plugin protocol over HTTP or MCP with a scoped token, explicit patient scope and controlled egress, so untrusted third-party code is isolated for real. In-process stays for reviewed code only.
4. **Content seam.** See the next section.
5. **Model registry.** Each ML plugin links a model card, version, evaluation results and intended use; the router refuses a model that has no passing evaluation for the requested use case.

## Example

```yaml
profile: clinic-se-local-model
extends: [./eir.clinic.config.example.json]
policy:
  maxNetwork: loopback
  denyDataClasses: []
  requireEvidenceForLanguageModels: true
patches:
  - replace: ai-extractive
    with:
      module: ./plugins/ai-ollama.ts
      config: { model: your-installed-model }
```

With `requireEvidenceForLanguageModels: true` this profile is refused until `plugins/ai-ollama.plugin.yaml` lists evaluation evidence.

## Fitting openEHR and other standards

The aim is an open system that works in any health system, so no standard is the core. Each standard is a **provider of a seam**, and the core owns only the contracts and the safety logic around them.

| Seam          | Contract owns                                           | Providers (examples)                                                                                   |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Content store | Versioned clinical facts with identity, time and author | Current JSON entity store; openEHR (for example EHRbase) behind an adapter; a FHIR-server-backed store |
| Content model | Typed, coded definition of what a fact is               | Zod schemas today; openEHR archetypes and templates; FHIR profiles                                     |
| Query         | Bounded, authorized read of facts                       | Fixed REST endpoints today; AQL where the content store is openEHR                                     |
| Terminology   | Code validation and lookup                              | ICD-10-SE today; SNOMED CT, LOINC, ATC, ICD-11 servers                                                 |
| Exchange      | Export and import at the boundary                       | FHIR R4 projection today; IPS and EHDS formats; openEHR export                                         |
| Identity      | Who is acting and under what assurance                  | Local, OIDC, national eIDs                                                                             |
| Country pack  | Identifiers, locale, legal defaults                     | Sweden, EU-local                                                                                       |

How openEHR fits, concretely:

- **One source of truth per data type.** A deployment picks one content store per data type. There is no dual write. Moving a data type between stores is a migration, not a sync.
- **The repository contract is Eir's, not openEHR's.** The clinical service exposes commands and authorized views. Its repository seam exposes versioned create, revise, get, list and history operations; the core owns authorization, workflow and Eir audit. The openEHR adapter maps repository operations onto compositions and contributions without leaking AQL into command handlers.
- **Content models are data, selected by profile.** A profile names the content model for each record kind. Using an openEHR template for vitals while problems stay on the JSON schema is a profile choice, so adoption can be gradual.
- **Contract tests make "swappable" true.** Each seam ships a provider conformance suite (wrong-tenant denial, expired grants, revisions, rollback, teardown, round-trip of every supported kind). A provider is accepted by passing it, not by claiming compatibility. This is the part that lets other countries and vendors plug in without trusting each other.
- **Open licensing and no required service.** Core and reference providers stay Apache-2.0 with no mandatory paid or hosted component. A national deployment can replace any provider without a fork.

Open questions, not decided here:

- Which reviewed Swedish templates should govern conditions, allergies, medications and clinical notes, and how each existing record is migrated without losing context.
- Whether the openEHR adapter should run in-process or as a separate service for production isolation.
- EHRbase operational fit and the separate licenses and governance of the chosen clinical models still require due diligence.

## Slice 8: FHIR R4 and the International Patient Summary

`fhir-r4` (`plugins/fhir-r4.ts`) exposes the record as FHIR R4. `fhir-ips` builds an IPS 2.0.0 document
(`packages/ips.ts`) from authority-aware clinical queries, so projected rows must match SQL and canonical rows
must resolve from their repository. Empty
sections are marked `unavailable` and never presented as "no known allergies". Diagnoses are mapped to
ICD-10-SE through a reversible code-system map (`packages/code-systems.ts`), and the envelope extension is
defined in `fhir/StructureDefinition-eir-envelope.json`. `content-fhir` stores records in a HAPI server
(`docker/compose.fhir.yml`, `npm run fhir:up`) and passes the same shared content tests as JSON and openEHR.
`npm run fhir:validate` checks the IPS bundle with the official HL7 validator in Docker (0 errors in our tests;
terminology checking is not enabled). Set `EIR_TEST_FHIR_URL` and `EIR_TEST_FHIR_VALIDATE` to run these tests.

## Explainer films

`video/` renders English and Swedish films about the project from HTML scenes, local speech and generated
music. See [video/README.md](../video/README.md). The films are published on the site's guide page.
