# Medication Reconciliation And Laboratory Results

This release adds two working service providers, `eir.medications` and `eir.laboratories`, and the Swedish medication/laboratory workspace. They use the existing identity, access, versioning, audit and care-team contracts. The public deployment is still a disposable example workspace; the local SQLite installation persists the same workflows across restarts.

## What Works

- Document medication use, source and indication, including an explicitly unknown dosage. Change reported use to active, on hold, stopped or entered in error with a reason and expected version. Earlier versions remain available. This is not a prescribing or dispensing workflow.
- Reconcile an exact snapshot of **all medication and allergy versions**. Every subsequent medicine/allergy addition or correction makes that reconciliation out of date. An empty list is unknown until a clinician explicitly confirms no current medicines. The note retains unresolved questions; an avstamd/current flag means the recorded list was reviewed, not that every dose was verified or a medication safety check passed.
- Create a local lab order against an open encounter with specimen description, clinical question, due date and a responsible team member who already has patient access. The order and its follow-up task commit together.
- Record a full source report with up to 30 analytes, verbatim result values/units/reference text and source-supplied flags. The system does not calculate reference ranges, normality, dosing, interactions or clinical interpretation. A missing flag is unknown, never normal.
- Review the exact latest report with assessment, action and a patient-communication plan. Only its assigned reviewer can sign this application attestation. Critical reports require a separate explicit acknowledgement. A generic task completion/cancellation cannot bypass this review.
- Replace a report with a reasoned correction. The previous report and its review remain intact, the order returns to unreviewed, and the linked task reopens, even after completion. Old reports are labelled replaced in both chart renderers and retained under the order's history.
- Reassign through the existing inbox with an explicit handover reason. Handover invalidates an already open review form via task revision. The linked task is the authority for the current owner; the original order assignee is historical input.

No button claims to transmit an order to an external laboratory. Reporting is a manual, authenticated clinical action in this release, not an unauthenticated inbound webhook. No lab or national-service connector is installed. Result arrival makes follow-up due no later than the current clinic date; critical source flags set urgent priority. There is **no background pager, escalation daemon or out-of-hours routing**. Those are clinical-pilot gates, not implied by a red badge.

## API

All routes require the existing authenticated clinician and active patient access. Validation schemas live in `packages/medications.ts` and `packages/laboratories.ts` and are exposed by `/api/openapi.json`.

| Method | Route                              | Payload / behavior                                                                                  |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/patients/:id/medications`        | `{items, snapshot, review, current}`                                                                |
| POST   | `/patients/:id/medications`        | `{clientId, name, dosageText, indication, source, sourceDetail, status}`                            |
| POST   | `/medications/:id`                 | `{version, data: {name, dosageText, indication, source, sourceDetail, status, reason}}`             |
| POST   | `/patients/:id/medication-reviews` | `{clientId, snapshot, source, note, confirmed: true, noCurrentMedicines}`                           |
| POST   | `/patients/:id/lab-orders`         | `{clientId, encounterId, test, question, specimen, assigneeId, due, priority}`                      |
| POST   | `/lab-orders/:id/receive`          | `{version, data: {source, messageId, collectedAt, reportedAt, results, correctionReason?}}`         |
| POST   | `/lab-orders/:id/review`           | `{version, data: {reportId, taskVersion, assessment, action, communication, criticalAcknowledged}}` |
| POST   | `/lab-orders/:id/cancel`           | `{version, data: {reason}}`; before any report only, current owner only                             |

`dosageText` is null for unknown, otherwise the source's free-text dose instruction. Medication `source` is `patient`, `record` or `caregiver`; status is `active`, `on-hold`, `stopped` or `entered-in-error`. There is no coded medication catalogue or dose validator yet. A voided statement cannot be restored; create a new statement. A review snapshot is the sorted list of `id@version` strings for medication/allergy entities, including corrected entries. Review sequence numbers disambiguate same-millisecond reviews.

A result item is `{name, value, unit, reference, flag}`. Value is text so decimal commas, comparators and qualitative results are preserved. Units/reference may be empty when absent at source. Flags are `unknown`, `normal`, `high`, `low` or `critical`. Analysis names are uncoded text, not fabricated NPU/LOINC identifiers. Report timestamps include offsets and cannot be in the future; collection must precede reporting. Entry fields explicitly use UTC; display follows the browser locale/timezone. Corrections are **complete replacement reports**, not partial patches, and their previous analytes are prefilled in the UI.

UUID `clientId` makes medicine creation, reconciliation and order creation retryable within the patient. Reusing it with different input returns 409. Source/message ID pairs are tenant-unique report identities: identical retries return the existing report without reopening a reviewed task; changed content or another order returns 409. Corrections need a new message ID and the current order version. Source labels are operator-entered, not verified lab identities. A future integration needs a configured source namespace, authenticated principal, patient/order matching, quarantine and replay controls.

Medicine updates, cancellations and review use compare-and-set versions. A lost response after these actions requires reloading current state before retrying; they do not silently overwrite or double-sign. Report/review/task writes share one synchronous SQLite transaction. Tests inject an audit-write failure after the report/order write and verify complete rollback.

## Visibility, AI And FHIR

The new entities are clinician-only in chart, history, change feed and export. Patient/proxy result release needs its own reviewed policy. `packages/visibility.ts` centralizes the filter. This restriction does not automatically redact signed note text that a clinician elects to publish via the existing note workflow.

AI evidence now includes documented medication status/source/unknown dosage, lab orders and **only their latest reports**. Source changes invalidate pending proposals. The AI still cannot prescribe, acknowledge a report or close a follow-up through its provider contract. It produces a reviewed draft only. Provenance validation does not validate clinical reasoning.

The FHIR R4 collection projection adds `MedicationStatement`, `ServiceRequest` and `DiagnosticReport` with contained `Observation` results. It emits no `MedicationRequest` or `MedicationDispense`, no invented product codes, and no invented UCUM mapping. Result values remain `valueString` including their source unit. Superseded reports stay in internal history rather than appearing alongside current ones in the export. Reviews remain application records; their export as Provenance/Composition is future work. This is not national IG conformance or a validated exchange gateway.

## Replacement Contracts

Replace either provider entry in the operator's profile with a reviewed implementation of `Medications` or `Laboratories`. The laboratory provider depends on `CareTeam.createLinkedTask` and `syncLinkedTask`; these are trusted internal operations called **inside the domain service's transaction**. They validate actor, patient, order, ownership and state but must not start a nested transaction. Custom care-team providers must implement these methods to use the new laboratory module. Ordinary task commands may assign/start a linked task but cannot resolve, cancel, postpone or reopen it. `apps/web/clinical-workflows.js` is independent of chart rendering; an alternate shell can call the same APIs.

No schema migration is needed: new kinds use the existing versioned entity store. Older executable versions cannot operate these tasks safely because they lack the linked-task guard. After real persisted use, do not roll the application back to the pre-laboratory release against the same database. Restore a matching backup/application pair or forward-fix. Never transfer the public demo's temporary stores into a clinical environment.

## Acceptance And Remaining Gates

`tests/medication-results.test.ts` exercises replay/mismatch, stale medication/allergy snapshots, explicit no-medicine confirmation, owner/grant/tenant restrictions, critical acknowledgement, corrected report reopening, generic-task bypass prevention, transaction rollback, restart persistence, patient/proxy disclosure, AI stale-context and FHIR projection. Browser tests exercise the full workflow at desktop/mobile widths and the public deployed API.

Still required for care use: verified professional identity/authorization, coded medication and lab catalogues with rights/versioning, structured prescribing and dose/route validation, approved NLL and actual lab transport, specimen collection/label/accession workflows, source authentication, critical-result delivery/escalation with staffing and delivery evidence, patient release, national conformance, clinical safety assessment and independent security/clinical validation.

## Design Sources

- [HL7 R4 MedicationStatement](https://hl7.org/fhir/R4/medicationstatement.html): reported use is distinct from ordering, dispensing and administration.
- [HL7 R4 ServiceRequest](https://hl7.org/fhir/R4/servicerequest.html) and [DiagnosticReport](https://hl7.org/fhir/R4/diagnosticreport.html): order/report projection boundaries.
- [E-halsomyndigheten: NLL contents](https://samarbetsyta.ehalsomyndigheten.se/utbildningavNLL/introduktion-till-nationella-laekemedelslistan-haelso-och-sjukvardspersonal/vad-innehaller-registret-nationella-laekemedelslistan): prescriptions and dispensing are not equivalent to a reconciled list of actual use.
- Example product names/strengths checked against FASS: [Enalapril 5 mg](https://www.fass.se/LIF/product?docType=30&nplId=20000505000073&userType=2), [Metformin 500 mg](https://www.fass.se/LIF/product?nplId=20171116000063&userType=0), [Pulmicort Turbuhaler 200 micrograms/dose](https://fass.se/health/product/19881209000118). Patient scenarios and lab values are fictional; no FASS dosage instructions or interaction database are bundled. Example medication dosages are deliberately unknown, awaiting reconciliation.
