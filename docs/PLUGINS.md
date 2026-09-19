# Plugin Authoring

The default composition is `eir.config.json`. A profile chooses exactly one provider per service. TypeScript contracts live in `packages/contracts.ts`; `npm run plugins` prints the resolved graph without opening the development database.

## Replace A Provider

Replace `./plugins/ai-extractive.ts` with the working local model adapter:

```json
{
  "module": "./plugins/ai-ollama.ts",
  "config": { "endpoint": "http://127.0.0.1:11434", "model": "your-installed-model" }
}
```

Choose a model already installed in your Ollama instance that supports structured output. Keep `ai-review.ts` active. It owns evidence validation and the review state machine regardless of provider. The adapter rejects non-loopback endpoints and redirects; it does not silently send data to an external provider. Browser tests run with the extractive adapter; live model performance is a separate evaluation gate.

`npm run smoke:model -- <installed-model>` exercises the real adapter with synthetic evidence and validates returned references. A live smoke test with `qwen3.5:4b` succeeded during development. This verifies transport/structured output only, not clinical quality.

Replace `./plugins/country-se.ts` with `./plugins/country-eu-local.ts`, with `config: {"code":"DK","locale":"da-DK"}`, to run the same data/workflow contracts with institution-local identifiers. This tests replaceability; it does not install Danish national integrations or Danish legal policy.

## A Complete Plugin Contract

`eir.terminology.icd-se` provides release metadata, diagnosis search and canonical code validation through `Terminology`. It is independently replaceable, including alongside another country pack. See [terminology setup and source rights](TERMINOLOGY.md). The clinical plugin requires a terminology provider and never trusts a browser-supplied diagnosis label.

A module exports a default `Plugin`. It declares version 2 of the runtime API and its required/provided services. Its `setup` obtains dependencies through `ctx.get`, installs implementations with `ctx.provide`, and registers cleanup with `ctx.onDispose`. Every acquired connection, timer, listener and process must have cleanup registered as soon as it exists. Cleanup may be asynchronous; callers must await `runtime.stop()`. Returning a disposer is also supported when initialization cannot fail after acquisition.

Read `plugins/ai-extractive.ts` for a small complete implementation, `plugins/clinical.ts` for stateful workflow behavior, and `plugins/storage-sqlite.ts` for transactional infrastructure. These are real modules used by the application, not template stubs. The `Services` interface can be extended with TypeScript declaration merging by out-of-tree plugins. Service keys are validated names, not a fixed allowlist. New service consumers must declare their dependencies.

Module paths are resolved relative to the selected configuration file. An operator can point at an installed package's entry file or a local checkout. No browser endpoint installs code, reads arbitrary module paths, or alters the profile. Pin dependencies and review both source and transitive dependencies before enabling them. Restart to apply changes; plugin hot replacement during live clinical writes is not supported.

## Replace The Chart

`apps/web/renderers/timeline.js` and `table.js` export `render(target, records)`. They receive the same authorized immutable JSON snapshots from the shell. They do not receive a database, bearer token or a clinical signing capability as function arguments. They remain trusted same-origin code, not a security sandbox.

Add a renderer module under `apps/web/renderers/<id>.js`, add the ID to `chartRenderers`, and set `defaultRenderer` if desired. IDs permit lowercase letters, digits and hyphens, preventing path traversal. The shell loads the selected ES module. A renderer may import a separately installed/bundled UI library. Do not mutate clinical records in a renderer; implement commands in a workflow plugin and use the authorized API.

The shell itself can also be replaced: the JSON APIs are independent of its DOM/layout. A third-party shell must handle identity persistence securely, display patient identity and record status, preserve optimistic concurrency, and keep model review separate from signing. Full independent shell packaging and manifest installation are future distribution work; replacing the source directory works today.

## Compatibility And Trust

Eir Samverkan separates `coordinationDirectory`, `coordination`, `sipPlans`, `coordinationPayment`, `coordinationDocuments` and `coordinationNotifications`. Contracts live in `packages/coordination.ts`; it reuses `modules`, `workforce`, `access`, `store` and `notificationTransport`. Replace providers through the deployment profile, retain private `sam*` visibility boundaries and test revoked consent, recipient audiences, transactional messages and revision-bound SIP confirmation. API discovery and UI hide absent SIP/document providers. See [SAMVERKAN.md](SAMVERKAN.md) for the dependency graph and deployment limitations.

Optional deterioration monitoring separates the `modules`, `riskEngine` and `deterioration` services. Operators install trusted providers in the profile; authorized staff activate the installed module per care unit with a reason and an expected settings revision. This is not arbitrary code installation or hot replacement. The `risk-vitals.ts` rules engine and `risk-http.ts` external inference adapter implement the same versioned input/output contract. Replacing the predictor leaves authorization, immutable assessments, alert ownership and clinician response in the workflow provider. Custom task providers must prevent generic completion of tasks with `deteriorationAlertId`. See [DETERIORATION.md](DETERIORATION.md) for configuration, data boundaries, tests and clinical deployment gates.

Clinical follow-up uses independent `followUp`, `followUpPolicy` and `notificationTransport` services. The engine requires bounded `Store.searchEntities` with the new validated `statuses` filter; both bundled stores implement it. Review requests without an explicit disposition now leave action open. Replacement policy providers return versioned clinic-specific deadlines; transports must honor stable message IDs and have a timeout shorter than the engine lease. See [FOLLOW-UP.md](FOLLOW-UP.md) for configuration, payloads and upgrade behavior. These modules remain trusted server code.

The integration composition adds `integrations` and `labTransport` services. Its storage requirement is the optional API-2 `Store.searchEntities` capability; both bundled stores implement it, and startup fails if a selected store does not. Machine audit principals use role `integration` and never authenticate as staff. Keep `integration.manage` in a separate administrative assignment. See [INTEGRATIONS.md](INTEGRATIONS.md) for protocol/schema compatibility, transport replacement and queue migration requirements.

The persistence release explicitly moves stateful services to promises and runtime API version 2. Version 1 manifests fail startup. Await all `Store`, `Access`, `Clinical`, `Workforce` (except pure `actor`), `Identity`, `CareTeam`, `Medications`, `Laboratories`, `Fhir`, and `AIReview` operations. Terminology/country lookups and chart-renderer signatures remain unchanged. Replace synchronous array predicates with awaited loops when they call authorization; `filter(async ...)` is never an access check.

`Store.transaction(async () => ...)` callbacks must be database-only and replayable: PostgreSQL may retry the complete callback for a serialization failure or deadlock, with bounded backoff. Stale expected versions remain explicit conflicts and are not retried as newer writes. Nested failures poison the entire transaction. Model inference, network calls and other external effects must remain outside the callback. Domain code rechecks permissions and reference versions inside the committing transaction. See [PERSISTENCE.md](PERSISTENCE.md).

Medication/result profiles add `Medications` and `Laboratories` providers. The default providers are independently replaceable; schemas and API requests are documented in [medication/result contracts](MEDICATIONS-AND-RESULTS.md). Custom `CareTeam` providers need the two transaction-aware linked-task operations, and must prevent generic task completion from bypassing report review. The default shell needs both services; removing a provider requires an alternate shell/profile rather than leaving nonfunctional controls visible.

The care-team release requires a `CareTeam` provider in each clinical profile and an `Access.allowed` predicate consistent with audited `Access.check`. The default profiles include both. See [care-team contracts and compatibility](CARE-TEAM.md) before upgrading custom providers. `apps/web/care-team.js` and `draft-editor.js` are separate shell modules; neither bypasses clinical authorization or record-version checks.

The identity/access release requires custom `Access` providers to implement `permit(actor, permission, patientId?)`. Every clinical mutation, export and AI call now uses action-specific authorization; do not implement this as unconditional approval. Strict profiles add independent `workforce` and `accessReview` services and optional effective-context/assignee methods. Custom stores must implement v2 session touch/update, single-use login transactions and cursor-based audit access. These are pre-1.0 contract changes; update and test replacements before upgrading. See [identity/access contracts and security boundaries](IDENTITY-AND-ACCESS.md). Server plugins remain trusted in-process code, not sandboxed extensions.

`apiVersion` gates runtime contracts. Plugin semantic versions are visible in `/api/plugins`. Lockfile changes need review and regression tests. This preview does not promise binary compatibility for every minor release; changes to storage or clinical contracts require a documented migration and updated tests.

All installed server plugins are privileged trusted code. JavaScript dependency injection does not prevent filesystem access or privilege bypass by malicious code. Untrusted vendor extensions must run out of process behind scoped authentication and restricted network egress. Never grant a model arbitrary package installation, shell execution, or policy replacement.

Required tests for a replacement: happy-path contract behavior, wrong-tenant denial, missing/expired grants, record revisions, rollback on failure, start/stop cleanup, and missing dependencies. Model providers additionally need timeouts, output-size limits, invalid-source rejection, stale context, prompt injection and clinician-rated output evaluation. UI replacements need keyboard, mobile, patient-context and error-state verification.
