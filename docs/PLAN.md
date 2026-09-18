# Delivery Plan: Sweden First

Baseline 2026-09-18. This is a delivery proposal with acceptance gates, not a claim that the current code is ready for patient care. Dates depend on a partner clinic, staffing, national service onboarding and regulatory assessment.

## Product Boundary

Start with one Swedish primary-care practice and its complete consultation loop. It must eventually support reception/identity, appointments, encounters, history, measurements, clinical documentation, problem and allergy reconciliation, medicines, laboratory orders/results, referrals, tasks, communication and patient access. Hospital medication administration, theatre management, billing across 27 countries and inpatient order sets are later products.

The current code is the executable foundation: registration, encounters, notes/sign/amend, selected vitals, problems/allergies, tasks, local identity/policy, audit, AI proposals, record export and plugin composition. The care-team release adds daily scheduling/check-in, assigned tasks with explicit handover and server-autosaved drafts with recovery/conflict handling (see CARE-TEAM.md). It does not yet include medication ordering, lab connectivity, referrals, attachments, automatic escalation or national services. Unfinished capabilities are tracked here rather than exposed as fake modules.

The medication/results release now implements documented medication use, version-snapshotted medication/allergy reconciliation, local lab orders, source-labelled manual results, owned review and correction-triggered reopening (see MEDICATIONS-AND-RESULTS.md). It does not implement prescribing, dose checking, specimen collection or laboratory transmission. The next safety-critical targets are verified identity/access, persistent deployment isolation, and a real laboratory partner's transport plus critical-result escalation; those gates remain ahead of a care pilot.

## Milestones

| Milestone                       | Indicative effort after team formed | Deliverables                                                                                                                                                                            | Exit evidence                                                                                                                                       |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0: executable foundation       | Current release                     | Working local workflows and plugin contracts                                                                                                                                            | Backend tests, browser workflow, restart persistence; synthetic data only                                                                           |
| M1: design partner and identity | 4–6 weeks                           | Clinic workflow mapping; SITHS/IdP integration in test environment; HSA assignment mapping; protected identities; patient search policy; session management; async persistence contract | Named clinical owner; threat model; role matrix; test identity round trips; revocation and privilege escalation tests                               |
| M2: complete consultation       | 6–10 weeks                          | Appointments/worklists, autosaved drafts with recovery, encounter handover, terminology lookup, task assignment/escalation, attachments and referral workflow                           | Clinicians complete realistic cases without parallel spreadsheets; duplicate identities and merge/unmerge tested; keyboard and accessibility review |
| M3: medicines and results       | 8–16 weeks, some parallel           | NLL integration journey, reconciliation, prescription workflow, drug knowledge provider, lab order/result adapters, abnormal-result acknowledgement and routing                         | Contract validation; duplicate/out-of-order messages; cancelled orders; critical results; external service outage scenarios; no lost follow-up      |
| M4: operational pilot gate      | 6–10 weeks, overlaps M2/M3          | PostgreSQL/RLS, encrypted storage/backup, KMS, reliable integration outbox, audit anchoring, recovery runbooks, support/on-call, clinical safety evidence                               | Restore drill against agreed RPO/RTO; load and soak tests; independent penetration test; DPIA and provider deployment review; signed pilot decision |
| M5: supervised Swedish pilot    | 8–12 weeks                          | Limited cohort, monitored release, incident process, staff training, migration reconciliation, independent chart review                                                                 | Agreed clinical and workflow metrics; traceable migration; incident trends reviewed; user acceptance and exit decision                              |
| M6: second-country deployment   | After Swedish validation            | One selected country's identifiers, professional identity, terminology, consent/proxy/retention rules and national connectors                                                           | Country partner accepts local workflows and exchange contracts; same kernel contract tests pass                                                     |

Plan for a multidisciplinary team: 3–4 product/backend engineers, 1 integration engineer, 1 designer/researcher, 1 test/reliability engineer, a clinical safety/product lead and fractional privacy/security/regulatory expertise. A durable primary-care product is likely a many-month effort; broad EU deployment is a multi-year programme. The ranges above are planning estimates, not promised delivery dates.

## Next Concrete Backlog

| Priority | Work package                | Acceptance criterion                                                                                                                                                                             |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Strong identity adapter     | Validate issuer, audience, nonce/PKCE where applicable, assurance and actor attributes; no browser-supplied role/tenant; test logout/revocation with the selected IdP                            |
| P0       | Swedish authorization model | Map HSA unit/assignment, patient relationship, within-provider vs cross-provider use, consent, protected identity, restrictions, proxy validity and emergency access; exercise every deny branch |
| P0       | Persistence v2              | Async unit-of-work contracts; PostgreSQL integration tests with two concurrent clients and RLS; migration rollback/recovery path                                                                 |
| P0       | Audit export and review     | Externally anchor log digests, archive immutably, assign a log-review queue, test tamper/deletion detection and patient-specific access reports                                                  |
| P1       | Patient identity lifecycle  | Local reserve ID, corrected birth dates, deceased/unknown patients, protected identity masking, merge/unmerge with evidence and no silent reattachment                                           |
| P1       | Complete note workflow      | Autosave/recovery, co-sign rules, template plugins, dictated text, patient-release policy, corrected authorship and cross-cover handover                                                         |
| P1       | Orders and results          | Order state machine; source identifiers, units and ranges; explicit acknowledgement, reassignment, escalation and out-of-hours routing                                                           |
| P1       | Medicines                   | Reconciled list versus prescriptions/dispensing; treatment intent, dose and route validation; NLL service onboarding; pharmacy acknowledgements; no substring-based allergy decision engine      |
| P1       | National data exchange      | First NPÖ/Journalen producer scope with a provider partner; validate actual RIV TA contracts and acknowledgements; dead-letter/replay/reconciliation tooling                                     |
| P1       | AI evaluations              | De-identified/synthetic Swedish test set with clinician scoring; omissions, fabricated facts, attribution, prompt injection, drift, timing and failure metrics; per-model release approval       |
| P2       | Citizen/proxy experience    | Mobile accessible records, audit history, validated delegation evidence/expiry, age transitions and revocation, correction requests and understandable restrictions                              |
| P2       | Country packs               | Estonia or Denmark first, chosen with a partner; pin national IGs and terminology; conformance suite and migration tests for every pack                                                          |

## National Integration Inventory

Sweden requires service-by-service onboarding. SITHS/HSA professional identity differs from citizen login. BankID or an eID alone does not prove a professional assignment, a care relationship or parental authority. NPÖ/Journalen access and contribution are separate capabilities. NLL is a specific national FHIR implementation, not the generic record export in this repository. Include regional lab/radiology systems, referral destinations, Webcert and 1177 communication as separate contracts.

Every connection must expose operator-visible status: not configured, onboarding, test-verified, production-connected, degraded or suspended. Track actual successful contributions, acknowledgement rate, latency, rejected messages, replay backlog, missing categories and patient identity match confidence. A configured endpoint never counts as a working provider connection. This release intentionally reports no live national connections.

## EU And Country Expansion

EHDS planning tracks the Commission's current 2029 patient-summary/prescription/dispensation milestone and 2031 imaging/lab/discharge milestone; monitor implementing acts and pin the requirements actually applicable to the product. Do not equate the eHealth indicator's categories with the EHDS legal priority categories. The 2026 maturity percentages quoted in the original brief remain unverified here and are not used as product conformance evidence.

Keep one shared workflow and integrity core with country packs for national identifiers, languages, terminology versions, identity mappings, patient rights, proxy rules and adapters. The EU-local pack today only demonstrates switching country/locale with local identifiers. It does not implement Danish CPR, Estonian identity or their access laws. Those require distinct tested plugins.

## Clinical And Operational Quality Gates

Before any real-data deployment, complete the intended-use and regulatory assessment for the EHR and each AI/CDS module. Review GDPR, Swedish patient-data/healthcare-documentation requirements, MDR applicability, AI Act obligations and EHDS requirements with responsible specialists. Record a hazard log tied to tests and release evidence. FHIR/IPS validation and national certification are explicit work, not inferred from JSON field names.

Proposed pilot targets to agree with the clinic: zero unsigned automated clinical actions; all chart disclosures auditable; all critical results assigned and acknowledged; no silent lost updates; no cross-tenant access; full restore drill; task-based accessibility testing to WCAG 2.2 AA; measured p95 chart opening under two seconds at agreed load. Availability, RPO/RTO and staffing obligations must be negotiated for the clinical setting.

## Open Governance

Keep kernel, SDK, default UI, test fixtures and national adapters publicly licensed. Accept DCO contributions; publish architectural decisions, schemas, migrations, changelogs and compatibility policy. Require two-person review for authorization, record lifecycle and migration changes. Maintain a clinician/patient advisory group and a country-pack maintainer per deployment. Third-party terminology, model weights and national access agreements have separate terms; application openness does not override them.

Publish reviewed plugin versions and hashes, dependency inventories and evaluation results. Avoid auto-installing marketplace code into a clinical runtime. New UI renderers and model providers should prove replacement through the same contract suite before a release is labelled compatible.
