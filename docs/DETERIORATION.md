# Optional deterioration monitoring

## Scope and evidence

This is a working monitoring and clinician-response module, not the CHARTwatch model and not an approved clinical decision-support product. It does not predict a numerical probability of death or ICU transfer. The bundled engine applies explicit development-only vital limits and trends. These rules are not NEWS2 and must not be presented as a validated medical score.

The architectural reference is [Verma et al., CMAJ 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11412734/), DOI 10.1503/cmaj.240132. The Toronto general internal medicine study evaluated a model, clinical alerts, a care pathway and implementation support together. It was nonrandomized. The adjusted relative risk of non-palliative death versus the prior period was 0.74 (95% CI 0.55-1.00); the difference-in-differences estimate was 0.79 (0.50-1.24). These are not effectiveness estimates for Eir, Swedish primary care, or the bundled rules. No CHARTwatch weights or source code are included.

## Composition

| Replaceable component                 | Responsibility                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `eir.modules` / `Modules`             | Installed optional capabilities and audited per-unit activation                |
| `eir.risk.vitals` / `RiskEngine`      | Local vital limits and changes over time                                       |
| `eir.risk.http` / `RiskEngine`        | Alternative authenticated HTTP prediction provider                             |
| `eir.deterioration` / `Deterioration` | Enrollment, authorized snapshots, evaluation, alert and reassessment lifecycle |
| Existing task and follow-up services  | Ownership, handover, deadlines and configured durable notifications            |

Exactly one risk engine is selected through the runtime configuration. The UI activates installed capabilities; it does not download code, accept executable URLs or unload authentication, authorization, auditing or storage. Server plugins remain trusted in-process code, not sandboxed extensions. An external model can be isolated behind the HTTP adapter, but this does not itself make its results clinically valid.

`modules.manage` is a separately assignable permission, available to administrative or clinical assignments. Settings apply to the active care unit, not a personal display preference. Changes require a reason and expected revision. Unknown modules cannot be enabled. A deployment-owned `canEnable: false` blocks activation even for administrators. This switch is a technical control, not regulatory approval.

Existing persisted staff assignments do not automatically acquire `modules.manage` on upgrade. An authorized workforce administrator must grant it to an appropriate other assignment through the staff administration workflow. Bootstrap configuration must not be used to reset existing permissions.

The synthetic demo and synthetic staging catalogue allow activation; the clinic example prohibits it. All units start with monitoring off. Switching it off stops new evaluations and prevents in-flight results from committing. An already-sent model request cannot be recalled. Open alerts and their tasks remain available for documented clinician review.

## Clinical workflow

1. An authorized clinician enrolls an adult's current open encounter, with a reason. Enrollment is explicit: enabling the module does not silently enroll an entire patient directory.
2. The worker builds an encounter-scoped snapshot. It verifies the enrolled owner's active assignment and patient access before inference and again before committing. Restricted or protected records are excluded.
3. A risk engine returns `alert`, `no-trigger`, `insufficient-data` or `unavailable`, with source references. An alert creates one open alert and an urgent task owned by the enrolling clinician, atomically.
4. Repeated evaluation of unchanged inputs and output does not duplicate alerts or assessments. Changed evidence updates the open alert and requires a new acknowledgement/reassessment. A resolved alert does not reopen for the identical assessment; new evidence can trigger a new alert.
5. Acknowledgement leaves clinical work open. The current task owner records a clinical assessment and follow-up plan. Resolution requires reassessment against the current assessment ID. No medication, monitoring order, ICU transfer or palliative decision is automatically placed.
6. Lower subsequent values, corrected observations, missing data or a model outage never automatically close an existing alert. Generic task completion/cancellation and generic follow-up completion cannot bypass the alert workflow. Task handover remains available through the existing inbox and follow-up workspace.

Monitoring stops after the encounter closes, without discarding unresolved alerts. Stopping and restarting an encounter's monitoring preserves history. A stopped/disabled monitor can still have unresolved clinical work.

## Data and algorithm boundary

- New vital entry supports respiratory rate (LOINC 9279-1, `/min`) and pulse-oximetry saturation (59408-5, `%`), alongside the existing vital types.
- Input contains age in years, encounter-specific measurements and their times, versioned source references, and the current report for each laboratory order. Superseded laboratory reports do not drive the current snapshot. Laboratory results retain their source labels, values, units and flags; they are not silently converted to standard terminology or numeric values.
- The default engine uses pulse, systolic blood pressure, respiratory rate, SpO2 and temperature. It does not interpret laboratory results, oxygen administration, consciousness, diagnoses or medication exposure. It is unsuitable as a complete inpatient early-warning score, including oxygen-target-specific assessments.
- Default freshness is four hours; trend comparisons use a prior valid measurement within six hours of the latest measurement. Missing, stale, future, contradictory simultaneous or invalid-unit measurements are not imputed as normal. Known abnormal readings may still produce an alert while other required inputs are missing.
- Default thresholds, trend cutoffs and the 30-minute task deadline are **development fixtures**, not treatment recommendations. Threshold changes require an explicit rule version change and deployment review.
- `no-trigger` means only that this engine did not trigger a configured rule on its available inputs. It is not a declaration of low risk or safety.
- Input changes during inference discard the result. The committing transaction rechecks enrollment, module activation revision, owner authorization and source versions. Inference stays outside replayable database transactions.
- Assessments retain engine ID/version, evaluated time, source hash, source readings and automatic/manual provenance. Model responses with unknown evidence references or inconsistent status are rejected. Automatic writes use an integration audit principal; they are not recorded as a clinician's decision.

## External model API

Replace `risk-vitals.ts` with `risk-http.ts` in a reviewed deployment composition. Configure an HTTPS endpoint, environment-variable credential, pinned model ID/version, display label and intended-use statement. Plain HTTP is allowed only on explicit loopback development configurations. There is no default external endpoint.

Request:

```json
{
  "modelId": "approved-local-model",
  "modelVersion": "release-id",
  "inputHash": "sha256-of-input-json",
  "input": {
    "protocol": "eir.risk.v1",
    "evaluatedAt": "2026-09-19T12:00:00.000Z",
    "ageYears": 58,
    "readings": [],
    "labs": []
  }
}
```

The response must echo `modelId`, `modelVersion` and `inputHash`, and include `output: { status, findings, missing }`. Each finding has `code`, `text` and one or more input `refs`. The provider is responsible for its preprocessing, calibrated operating threshold and validated clinical population. Eir does not train or certify a model through this interface.

Requests use a bearer credential, verified TLS, a bounded timeout and no redirects. Responses are limited to 64 KiB. Failures become unavailable assessments, not reassuring scores. The snapshot omits direct patient names and identifiers but remains sensitive patient data; source references, times and laboratory text are not anonymization. An external endpoint needs a separately authorized data-processing arrangement. The public demo only uses the local rule engine.

## Operation

Use embedded `worker: true` for a continuously running local process. For a separate worker, disable embedded workers in its composition and run:

```sh
EIR_CONFIG=/absolute/path/to/reviewed-config.json npm run worker:deterioration
```

`--once` runs one bounded cycle. Each cycle visits up to 50 active monitors per unit using a persisted cursor. Input is bounded to 2,000 encounter records; exceeding that bound yields a visible failure. PostgreSQL concurrency and version checks prevent duplicate alert/task commits across replicas, although replicas may perform duplicate inference calls. A worker failure does not silently clear existing work.

The UI shows monitoring status, last check, data gaps, evidence, unresolved alerts and response history. Its last-check freshness warning does not constitute a separate pager or an uptime guarantee. Browser polling is for display updates; evaluation runs server-side. Monitoring must have supervised, continuously available compute before any clinical pilot. A scale-to-zero, request-billed Cloud Run demo is **not** continuous clinical monitoring. Public sessions remain disposable and external notifications remain disabled.

## API

- `GET /api/modules`: installed optional catalogue, effective activation and management permission.
- `POST /api/modules/:id`: `{ enabled, version, reason }`.
- `GET /api/deterioration?after=...`: authorized unit-scoped monitoring, 50 monitors per page; each includes current assessment, unresolved alerts and up to 100 response events.
- `POST /api/patients/:id/monitoring`: `{ encounterId, reason }`.
- `POST /api/monitoring/:id/evaluate`: `{}`.
- `POST /api/monitoring/:id/stop`: `{ version, reason }`.
- `POST /api/deterioration-alerts/:id/respond`: `{ version, assessmentId, action, note, plan? }`; action is `acknowledge`, `reassess` or `resolve`.

The OpenAPI document advertises these endpoints only when their plugins are installed. Assessments and private monitoring records are not released to patient/proxy chart views or FHIR exports. Associated tasks retain the existing FHIR R4 Task projection. There is no FHIR RiskAssessment implementation in this release.

## Before clinical use

A clinical owner must define population, observation cadence, exclusions, escalation responsibilities and coverage, then validate the complete pathway. A model requires local retrospective and prospective evaluation, calibration and subgroup analysis, missed-deterioration and false-alert review, model change control, downtime drills and independent security/privacy assessment. Assess the intended use and regulatory classification with qualified reviewers before enabling clinical use; the broader [regulatory evidence map](REGULATORY-ALIGNMENT.md) remains applicable. No mortality-reduction, Swedish integration approval or medical-device conformity claim is made.
