# FHIR Support

Reviewed 2026-09-19 against `plugins/fhir-r4.ts` and the authenticated API. This is a capability inventory, not an HL7 certification or national conformance statement.

## Implemented Today

`GET /api/patients/:id/export/fhir` returns a FHIR R4-style JSON `Bundle` of type `collection`. The replaceable `eir.fhir.r4-export` plugin projects the authorized current record. Export authorization and chart access are checked inside the storage transaction and the export is audited. Entries use `urn:uuid` full URLs, internal references, resource version IDs, last-updated metadata and an export timestamp.

| Eir record        | Exported resource   | Current representation                                                   |
| ----------------- | ------------------- | ------------------------------------------------------------------------ |
| Patient           | Patient             | Name, date of birth and identifier; local IDs are tenant-scoped          |
| Encounter         | Encounter           | Ambulatory encounter, subject, reason and period                         |
| Vitals            | Observation         | Selected LOINC codes and quantity units represented with UCUM system     |
| Diagnosis         | Condition           | ICD-10-SE coding and release metadata, clinical/error status             |
| Allergy           | AllergyIntolerance  | Text substance/reaction, status and criticality                          |
| Note              | DocumentReference   | Base64 UTF-8 text, author, encounter and amendment relationship          |
| Medication use    | MedicationStatement | Documented use and free-text dose/provenance, not a prescription         |
| Laboratory order  | ServiceRequest      | Text test/specimen/question and order lifecycle                          |
| Laboratory report | DiagnosticReport    | Current report with contained Observations, source identifiers and flags |
| Follow-up task    | Task                | Owner identifier, status, priority and date or exact deadline            |

Superseded lab reports are retained in Eir history but omitted from the current export. Source-level flags and textual reference ranges are preserved; laboratory values currently use `valueString`, not a fully coded quantitative laboratory model. Visibility follows the authenticated actor: a clinician export may include draft notes and internal tasks permitted in their chart. A citizen/proxy export follows the more restrictive visibility path where that identity mode is configured. The clinic identity profile does not yet provide verified patient/proxy onboarding.

## Not Implemented Or Not Proven

- No general FHIR REST server: no resource-type read/search/write API, transaction ingestion, `$validate`, FHIR `_history`, subscriptions or `CapabilityStatement` endpoint.
- No FHIR import or bidirectional synchronization. Existing record history/change-feed endpoints are Eir JSON APIs, not FHIR REST operations.
- No SMART App Launch authorization. Staff OIDC authentication is not SMART-on-FHIR.
- No declared conformance to Swedish implementation guides, NLL profiles, IPS, EHDS exchange formats or a contracted laboratory's profiles.
- No full HL7 validator/terminology-server report is currently part of CI. Tests verify selected mappings, visibility, source preservation and workflow behavior, not complete schema/invariant/profile/terminology conformance.
- No FHIR document Bundle with Composition, cryptographic Bundle signature or separate Provenance/AuditEvent export. Internal note signing is not an eIDAS qualified signature.
- No nationally coded laboratory catalogue, structured prescription model, SNOMED CT service or comprehensive terminology validation.

The lab connector introduced in the prior milestone uses `eir.lab.v1`, a documented Eir JSON protocol. The notification module uses `eir.notification.v1`. Neither is a FHIR integration.

Optional deterioration monitoring uses the `eir.risk.v1` model input contract, not CDS Hooks or a FHIR prediction API. Monitoring settings, assessments and response events remain private application records. Linked tasks use the existing Task projection; FHIR RiskAssessment is not implemented. See [DETERIORATION.md](DETERIORATION.md).

## Next Interoperability Milestone

Choose one real receiving system and pin its FHIR version, implementation-guide package, terminology releases and supported interactions. Add the official HL7 validator to CI with reproducible offline package inputs, representative exports and negative cases. Resolve diagnostics and validate reference resolution before claiming that profile. Then implement the required resource endpoints and accurate CapabilityStatement behind existing authorization, audit and optimistic concurrency controls. Evaluate SMART only when the intended client workflow requires it.

Do not replace the internal database with a FHIR server merely to acquire the label. The export/provider boundary already permits a reviewed adapter or server-backed implementation; clinical authorization and lifecycle guarantees must survive either choice.

References: [HL7 R4 RESTful API](https://hl7.org/fhir/R4/http.html), [HL7 R4 validation](https://hl7.org/fhir/R4/validation.html), [HL7 R4 Bundle](https://hl7.org/fhir/R4/bundle.html). Tests: `tests/medication-results.test.ts`, `tests/terminology.test.ts`, `tests/security.test.ts`, `tests/integration.test.ts` and `scripts/smoke-public.ts`.
