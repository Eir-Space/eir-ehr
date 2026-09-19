# Eir EHR regulatory alignment and readiness

Technical evidence brief for Swedish healthcare providers and regulatory stakeholders

**Assessment date:** 19 September 2026. **Document status:** draft for clinical, privacy, security and regulatory review. **Software scope:** repository version 0.2.0, runtime API 2, follow-up development branch based on main commit `a2084ac9d15e8bdeebdedcd88a7622c489a0c3ca`. This assessment includes the new clinical follow-up modules; it does not assert that they are already deployed publicly.

## Executive conclusion

Eir is an open-source EHR under active development, focused first on Swedish primary care. It implements working clinical documentation, care-team workflows, medication documentation, laboratory processing, staff authorization, audit review, PostgreSQL persistence and clinician-reviewed AI assistance. The architecture supports replaceable modules with explicit service contracts.

Several implemented controls support Swedish and EU regulatory requirements. The project has not established complete regulatory compliance, clinical validation, national-service approval or readiness for real patient use. This document is an evidence map, not a declaration of conformity, certification, legal opinion or regulator endorsement. Open-source licensing does not remove the responsibilities of the deploying healthcare provider or any legal manufacturer.

**Decision requested:** appoint a clinical design partner and accountable privacy, security, operations and regulatory leads; approve the intended use and evidence plan; keep evaluation limited to synthetic data until the release gates below are met. A public demonstration is not the proposed clinical deployment.

## Scope and intended use

The candidate clinical scope is professional primary-care documentation and coordination within one healthcare provider: identify the patient, conduct and document an encounter, review medication history, order and review laboratory investigations, assign follow-up and preserve an attributable record. This is a proposed scope for formal approval, not an approved manufacturer statement of intended purpose.

The implemented medication module records medication use and reconciliation; it does not issue Swedish electronic prescriptions. Local and protocol-test laboratory workflows do not establish a contracted Swedish laboratory connection. No autonomous diagnosis, prescribing, emergency triage or autonomous closure of critical results is proposed. AI output remains a reviewable proposal and does not become a signed clinical record on its own.

The public website uses disposable synthetic workspaces. Private synthetic staging supports PostgreSQL persistence. A clinical deployment would require a separate reviewed configuration, verified professional identity, approved interfaces, protected infrastructure and staffed operating procedures. The public Cloud Run/Firebase configuration is not evidence of exclusive EU data residency, appropriate contractual safeguards or suitability for health information.

## Regulatory applicability

**Patient records and access.** Patientdatalagen governs journal handling and need-based access. Corrections must remain attributable and preserve the original information; journal retention is generally at least ten years after the last entry, with other archival duties potentially extending it. The software's version history supports these objectives but does not implement a complete legal archive. [Patientdatalagen 2008:355, chapters 3 and 4](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/patientdatalag-2008355_sfs-2008-355/).

**Information security and supervision.** The current consolidated HSLF-FS 2016:40 includes HSLF-FS 2025:57. It requires documented needs/risk-based authorization, access logging, recurring documented checks and retention of access logs for at least five years. These are organizational obligations as well as software requirements. Manual review functionality is not evidence that reviews are staffed or performed. [Socialstyrelsen, especially chapter 4](https://www.socialstyrelsen.se/kunskapsstod-och-regler/regler-och-riktlinjer/foreskrifter-och-allmanna-rad/konsoliderade-foreskrifter/201640-om-journalforing-och-behandling-av-personuppgifter-i-halso--och-sjukvarden/).

**Personal data.** The provider must establish the applicable Article 6 and Article 9 bases, controller/processor roles, contracts, records of processing, privacy information and patient-rights procedures. Consent must not be assumed to be the universal basis for ordinary care documentation. Articles 25 and 32 inform privacy/security design; Articles 33–35 concern breach handling and impact assessment. International transfers need a separate Chapter V assessment. No deployment-specific DPIA, DPA or transfer assessment has been approved for this project. [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng).

**Product qualification.** The EHR core and each AI or decision-support module need a documented intended-purpose assessment against MDR/IVDR and, where relevant, Sweden's rules for nationella medicinska informationssystem (NMI), HSLF-FS 2022:42. Being outside MDR/IVDR does not establish that an EHR is unregulated. The responsible manufacturer, qualification rationale and applicable registration/conformity route have not been determined. A plugin label or a human review step does not settle classification. [Läkemedelsverket guidance on medical device software and NMI](https://www.lakemedelsverket.se/en/medical-devices/which-rules-apply-to-me/medical-device-software).

**European interoperability and AI.** EHDS introduces phased interoperability and logging requirements; priority data exchange expands in 2029 and 2031. A FHIR-shaped export alone does not meet those obligations. AI Act applicability must be assessed per intended use and provider/deployer role, using the current amended timetable rather than an older generic deadline. Neither EHDS nor AI Act conformity is claimed. [European Commission EHDS overview](https://health.ec.europa.eu/ehealth-digital-health-and-care/european-health-data-space-regulation-ehds_en); [Commission AI regulatory framework](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai).

## Implemented controls and remaining work

The status “implemented” below means a working repository control with developer test evidence. It does not mean independently validated, operationally adopted or legally sufficient. Evidence identifiers refer to the source index later in this document.

| Control                  | Working implementation                                                                                                                                | Remaining acceptance work                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 Record integrity      | Draft, signing, immutable signed content, attributed amendments, version checks and atomic audit writes. E1                                           | Clinical content review; co-signing/delegation requirements; archive, retention and authorized destruction procedures. Signing is application attestation, not a qualified electronic signature. |
| C2 Staff access          | OIDC authentication; active provider/unit assignments; action permissions and patient relationships; immediate revocation checks. E2                  | Contracted professional IdP/HSA source; verified assurance configuration; approved duties-based access matrix and periodic access recertification.                                               |
| C3 Sensitive records     | Restricted records denied; protected-identity permission enforced across directory, chart, export and AI. Temporary access is limited and audited. E2 | Full Swedish unit/process blocking and cross-provider rules; protected-person contact handling; verified guardianship, proxy and citizen access.                                                 |
| C4 Accountability        | Attributed access events, append-only versions, hash-chain verification and unit-scoped review assessments. E3                                        | External immutable log preservation/anchoring, minimum retention, recurring reviewer assignments, alert investigation and patient-readable access reports.                                       |
| C5 Persistence           | PostgreSQL role-bound provider isolation, forced row security, restricted runtime credentials and controlled migrations. E4                           | Independent penetration testing; production TLS/key rotation; hardened hosting; capacity, availability and privileged-operator controls.                                                         |
| C6 Recovery              | Authenticated encrypted logical backups; isolated restore tests; restored sessions invalidated. E5                                                    | Approved RPO/RTO, off-host immutable storage, key custody, point-in-time recovery and scheduled evidenced restore drills.                                                                        |
| C7 Lab processing        | Durable outbox/inbox, exact patient/order correlation, idempotent processing, corrections, retries and accountable review. E6                         | Partner-approved adapter/catalogue, real onboarding, acceptance environment, reconciliation and outage procedures.                                                                               |
| C8 Clinical follow-up    | Separate review/action states, named ownership, deadlines, coverage eligibility checks, escalation, contact history and durable notifications. E7     | Clinically approved timing and escalation policies, staffed fallback, gateway contract, load validation and independent monitoring.                                                              |
| C9 AI oversight          | Authorized evidence, source-reference checks, post-inference access recheck, reviewable proposals and clinician acceptance. E8                        | Swedish clinical evaluation; omission/hallucination and injection testing; model/version change control; literacy, safety and classification evidence.                                           |
| C10 Interoperability     | Authenticated FHIR R4 collection export and authorized JSON APIs/change feed. E9                                                                      | Target implementation-guide validation, terminology completeness, national certification/onboarding and any needed FHIR REST/SMART functionality.                                                |
| C11 Extension governance | API-version checks, explicit dependencies and replaceable service providers. E10                                                                      | Approved module inventory, software bill of materials, provenance/security review, change qualification and process isolation for untrusted extensions.                                          |

## Clinical safety of follow up

The new workflow distinguishes a result awaiting review from a reviewed result whose action is still outstanding. A contact attempt does not complete the action. Completion is explicit and attributable; a corrected report reopens work and prevents completion against an obsolete report version. Notifications contain a generic instruction and fixed workspace link, not patient names, identifiers, results or task details.

Delivery confirmation means the configured gateway accepted the message. It does not mean a clinician saw it, accepted responsibility or contacted the patient. The task remains open independently. Delivery failures remain visible and support audited, version-checked retries. Worker leases and message identifiers address restart and duplicate-delivery risks; a gateway must honor idempotency for downstream deduplication.

Coverage never grants access. The target must already have a current assignment, appropriate permission and patient relationship. Missing eligible coverage or escalation recipients are flagged. Automatic changes use a machine audit identity. Coverage periods are individual dated intervals, not a complete recurring on-call roster; ownership does not automatically revert when cover ends.

The clinic must define acceptable turnaround, critical-result handling, staffing and telephone fallback. The bundled development policy is illustrative, not a medical recommendation. An embedded worker on a scale-to-zero or request-throttled web service is not a reliable clinical timer; a separately scheduled or continuously running worker with external monitoring is needed. The present bounded scanner and queue require clinic-volume load testing. A stale-work warning in the UI cannot detect an outage when nobody opens the UI.

These controls support referral/result responsibility but do not replace written provider routines or clinical judgement. [Socialstyrelsen SOSFS 2004:11 on responsibilities for referrals and responses](https://www.socialstyrelsen.se/kunskapsstod-och-regler/regler-och-riktlinjer/foreskrifter-och-allmanna-rad/konsoliderade-foreskrifter/200411-om-ansvar-for-remisser-for-patienter-inom-halso--och-sjukvarden-tandvarden-m.m/).

## Privacy and trust boundaries

Tenant isolation is only one boundary. Clinical access additionally depends on the current staff assignment, unit, action and patient relationship. An administrator role does not automatically give access to clinical charts. Auditors use a separate review surface. Denying cross-provider access is safer than treating a generic local grant as compliance with Sweden's shared care documentation rules; the complete national workflow is not implemented.

Server plugins execute as trusted in-process code. Dependency declarations are not a sandbox, and a malicious plugin or privileged host/database operator is within the current trust boundary. Third-party AI or integration services should be isolated behind scoped interfaces with reviewed processing agreements and approved data flows. The bundled local model adapter restricts network destinations, but replacing it changes the risk assessment. No patient-data transmission to an external model is authorized by this document.

Record and audit retention need distinct approved schedules, preserved readability across upgrades and verified exports for archival use. Keeping rows indefinitely is not a retention policy. Erasure requests must be evaluated alongside statutory journal obligations. Neither a generic deletion API nor an assumed right to delete all clinical records should be introduced without legal review.

Patient-facing access, guardian authority, safe communication channels and rights handling remain separate delivery work. Responsive clinician pages and browser checks do not establish accessibility conformance; keyboard, screen-reader and intended-user testing need an agreed acceptance standard.

## Current FHIR support

`GET /api/patients/:id/export/fhir` is an authenticated, authorized and audited export using `application/fhir+json`. The replaceable `eir.fhir.r4-export` module produces a collection Bundle, with local UUID references and record-version metadata. It projects Patient, Encounter, Observation, Condition, AllergyIntolerance, DocumentReference, MedicationStatement, ServiceRequest, DiagnosticReport and Task.

The export preserves the caller's visibility policy. A permitted clinician can export authorized drafts and internal tasks; it is not automatically an approved patient-summary publication. Only the current lab report for each order is exported. Lab result components are contained Observations with text values; standardized coded analytes, quantitative values and complete terminology mappings remain work. Internal notification destinations and follow-up delivery records are not chart resources.

There is no general FHIR REST server, import/transaction service, resource search, CapabilityStatement, SMART launch, FHIR Subscription, IPS document or verified Swedish/EHDS profile conformance. Existing OIDC login is not SMART authorization. The lab and notification transports use explicit Eir JSON contracts, not FHIR protocols. Repository projection tests do not substitute for an official validator and target implementation-guide test suite. [HL7 R4 REST](https://hl7.org/fhir/R4/http.html); [HL7 validation](https://hl7.org/fhir/R4/validation.html).

The next interoperability milestone should choose a named partner use case and pinned Swedish implementation-guide release, validate complete exported examples in CI, resolve terminology/reference errors, and obtain partner acceptance. Build a full FHIR server only if the agreed integration requires it. The detailed resource inventory is in `docs/FHIR.md`.

## Evidence index

All paths refer to the reviewed repository snapshot. Tests are developer-controlled engineering evidence with synthetic records. They do not establish clinical effectiveness, regulator approval, national onboarding or independent security certification. Preserve the exact commit, profile, dependency lockfile, test output and environment with a release assessment.

| ID  | Primary implementation                                                         | Verification and operational detail                                               |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| E1  | `plugins/clinical.ts`; both storage providers                                  | `tests/clinical.test.ts`; `tests/postgres-clinical.test.ts`                       |
| E2  | `plugins/identity-oidc.ts`; `plugins/access-clinic.ts`; `plugins/workforce.ts` | `tests/oidc.test.ts`; `tests/workforce.test.ts`; `docs/IDENTITY-AND-ACCESS.md`    |
| E3  | `plugins/access-review.ts`; storage audit/version guards                       | `tests/postgres-security.test.ts`; `tests/workforce.test.ts`                      |
| E4  | `plugins/storage-postgres.ts`; `packages/postgres-migrations.ts`               | PostgreSQL lifecycle, isolation and HTTP tests; `docs/PERSISTENCE.md`             |
| E5  | `scripts/postgres-backup.ts`; `scripts/postgres-restore.ts`                    | `tests/postgres-recovery.test.ts`; `tests/backup.test.ts`; `docs/RECOVERY.md`     |
| E6  | `plugins/integrations.ts`; `packages/lab-application.ts`                       | `tests/integrations.test.ts`; `tests/integrations.e2e.ts`; `docs/INTEGRATIONS.md` |
| E7  | `plugins/follow-up.ts`; policy/notification plugins; follow-up UI              | `tests/follow-up.test.ts`; `tests/follow-up.e2e.ts`; `docs/FOLLOW-UP.md`          |
| E8  | `plugins/ai-review.ts`; configured model provider                              | `tests/plugins-ai.test.ts`; workforce post-inference checks; `docs/PLUGINS.md`    |
| E9  | `plugins/fhir-r4.ts`; `packages/visibility.ts`                                 | Clinical, medication/result and access tests; `docs/FHIR.md`                      |
| E10 | `packages/runtime.ts`; `packages/contracts.ts`; locked dependencies            | `tests/plugins-ai.test.ts`; `tests/storage-async.test.ts`; `docs/PLUGINS.md`      |

## Clinical release gates

Every gate below is open for a real-patient deployment. Proposed accountable roles are roles to appoint, not evidence that somebody has accepted responsibility.

| Gate                              | Accountable role                         | Evidence required before approval                                                                                                                     |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended use and qualification    | Product owner and regulatory lead        | Named legal manufacturer where applicable; approved intended purpose; NMI/MDR/IVDR rationale; applicable registration or conformity evidence.         |
| Clinical safety                   | Provider medical lead                    | Hazard log, end-to-end scenario validation, acceptable residual risks, critical-result and coverage routines, training and stop criteria.             |
| Privacy and patient rights        | Provider controller and DPO              | DPIA, legal bases, processing agreements, data-flow/transfer assessment, rights/proxy/blocking procedures and retention schedules.                    |
| Security and access               | Provider security lead                   | Threat model, approved access matrix, verified IdP/assignment source, independent testing, remediation and privileged-access controls.                |
| Operations and resilience         | Service owner                            | Monitored private deployment, staffed incident response, backup/key custody, restore and outage exercises, RPO/RTO and worker/gateway service levels. |
| Integrations and interoperability | Provider integration lead and partner    | Contracted endpoints/catalogues, profile validation, conformance/onboarding evidence and recovery/reconciliation acceptance.                          |
| Release and module changes        | Maintainer and provider change authority | Signed-off evidence snapshot, reviewed dependencies/plugins, regression results, rollback plan and re-assessment of changed AI or clinical functions. |

No clinical, privacy, security or regulatory approval is recorded by this draft. The immediate use of this document is to make those decisions inspectable and assign the missing work, not to market an unfinished system as certified.

## Review record

Prepared from repository inspection, automated engineering tests and the primary sources linked above. Legal applicability is a preliminary technical interpretation requiring qualified Swedish review. No regulator has reviewed or endorsed this assessment. Reassess it when intended use, clinical workflows, AI models, third-party modules, hosting, interfaces or relevant rules change.

For circulation, attach the precise reviewed commit and test run. The editable Word copy is generated from this Markdown source; repository changes after its generation are not included automatically.
