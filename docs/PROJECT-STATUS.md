# Eir EHR: Project Overview

Updated 2026-09-19. Development software, not an approved clinical deployment.

## What We Are Building

An Apache-2.0 electronic health record for Swedish primary care, designed for later country-specific EU deployments. Clinical workflows, storage, identity, terminology, AI providers and chart rendering are replaceable modules. There is no proprietary application core or mandatory paid model API.

## Working Today

| Area                    | Current capability                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinical work           | Patient registration and search; encounters; notes with autosave, signing and amendments; vital signs; diagnoses; allergies                                                                               |
| Swedish terminology     | Official ICD-10-SE 2026 search by code or text, with release metadata and canonical coding                                                                                                                |
| Care team               | Appointments, check-in, assigned tasks, handover and encounter-linked completion                                                                                                                          |
| Medicines               | Documented medication use and versioned medication/allergy reconciliation, not electronic prescribing                                                                                                     |
| Results                 | Local lab orders, manually entered source-labelled results, corrections, assigned review and explicit critical-result acknowledgement                                                                     |
| Lab integration runtime | Atomic outbox, durable authenticated inbox, bounded leased workers, exact matching, correction sequencing and audited operator retry; real local HTTP adapter tests, no contracted Swedish lab connection |
| Clinical follow-up      | Separate review/action completion; deadline oversight, temporary cover, audited escalation, contact history and durable gateway delivery with retries                                                     |
| Optional monitoring     | Unit-level module activation, vital/trend warnings, owned alerts and documented reassessment; replaceable local rules or external HTTP engine, not a validated mortality predictor                        |
| Identity and access     | Tested OIDC adapter; staff assignments; care-unit, patient and action permissions; revocation; protected-record exclusion; manual access-log review                                                       |
| AI                      | Replaceable extractive and local-model providers; evidence-linked proposals, clinician review and draft-only acceptance; changed-source detection                                                         |
| Interoperability        | Authenticated JSON APIs, record history/change feed and FHIR R4 projections; not a complete FHIR server or national implementation-guide certification                                                    |
| Persistence             | Replaceable SQLite/PostgreSQL storage, role-bound provider isolation, version-conflict checks, encrypted logical backups and a tested EHR restore                                                         |

The public website remains a separate disposable synthetic demo. Persistent staging is a separate environment. Neither is permission to enter real patient data.

The follow-up milestone builds on the laboratory integration runtime. See [FOLLOW-UP.md](FOLLOW-UP.md) for clinical state transitions and operating requirements, [FHIR.md](FHIR.md) for exact interoperability coverage, and [REGULATORY-ALIGNMENT.md](REGULATORY-ALIGNMENT.md) for a stakeholder evidence map and outstanding release gates. Repository capabilities and the deployed public revision may differ until a reviewed release is deployed.

Backend and browser tests exercise real PostgreSQL transactions, independent concurrent editors, access boundaries and restoration of application records. This is engineering verification, not clinical validation, service approval or an independent security certification.

The optional [deterioration module](DETERIORATION.md) is off by default, with clinical activation blocked in the clinic example. It applies the CHARTwatch-inspired pattern of monitoring plus a clinician-response workflow, without claiming to reproduce that model or its study results. A continuously supervised worker, a validated predictor and an approved local care pathway remain prerequisites for clinical use.

## Not Yet Connected

[Eir Samverkan](SAMVERKAN.md) now implements consented shared cases, three-unit inboxes, recipient receipts, discharge workflow, structured SIP, attachments/PDFs and versioned payment estimates. Its providers are independently replaceable. The demonstrated organisation separation is within one tenant, not live federation. Regional identity/exchange, complete statutory exception pathways, production document scanning and approved invoicing remain release gates.

See [SWEDISH-INTEGRATIONS.md](SWEDISH-INTEGRATIONS.md) for the service owners, provider responsibilities and recommended first contacts.

No live SITHS/HSA provisioning, NLL prescribing/dispensing, NPÖ/Journalen, external laboratory, Webcert or regional referral integration is claimed. OIDC protocol tests do not establish national identity-service approval. Medication documentation is not a prescription service, and manual result entry is not a laboratory connection.

Before real patient use, the project needs a clinical partner, service-specific onboarding, workflow validation, independent security and privacy review, operational ownership and an intended-use/regulatory assessment. Model evaluation and approval are separate from checking that a citation exists. In-process plugins are trusted code, not sandboxed vendor extensions.

## How To Contribute

- Clinicians: review complete consultation scenarios, record workflow problems and help define clinical acceptance tests.
- Swedish integration specialists: contribute verified identity, laboratory and national-service adapters with contract tests.
- Engineers: open focused pull requests for modules, tests, migrations and reliability improvements.
- Designers and accessibility specialists: test real clinical tasks with keyboard, assistive technology and compact workspaces.
- Security and privacy specialists: review authorization boundaries, recovery procedures and threat models; report vulnerabilities privately through SECURITY.md.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before submitting a pull request. Use fictional examples in issues, screenshots and tests; never submit patient information or credentials.

## LinkedIn Draft

We are building Eir EHR: an open-source electronic health record for Sweden, with an architecture designed to support other EU countries over time.

The project already has working clinical workflows: patient records, appointments, notes with autosave and signing, ICD-10-SE diagnosis lookup, medication reconciliation, and a local lab order/result review process.

AI is part of the architecture, with a clear boundary: proposals cite their source records, clinicians review them, and accepted text becomes a draft rather than an automatically signed clinical action.

Modularity is central. Storage, identity, terminology, AI providers and the way the record is displayed can be replaced. The application is Apache-2.0 licensed, without a proprietary core.

The latest work connects reliable laboratory processing to accountable follow-up: separate result review and action completion, named ownership, temporary cover, escalation and delivery-failure handling. PostgreSQL persistence, provider isolation and encrypted backup/restore provide the underlying storage foundation.

This is a working development system, not yet ready for live patient care. National integrations and clinical validation are still ahead of us.

We are looking for Swedish clinicians, integration engineers, designers and security specialists who want to help build it. Try the demo, challenge the workflows, open an issue or contribute a focused pull request.

Demo: https://ehr.eir.space/

Code and contributions: https://github.com/Eir-Space/eir-ehr
