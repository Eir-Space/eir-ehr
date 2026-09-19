# Eir Samverkan

Updated 2026-09-19. Working development module for shared care coordination, with its own implementation and name. It is not SAMSA, is not connected to SAMSA, and does not claim feature parity or approval for patient care.

## Try The Workflow

Run `npm run demo:public` and open the printed local address. A fresh public-demo session has separate fictional primary-care, hospital and municipality assignments for Emma Sjöberg.

1. Open the journal, select primary care and enable **Eir Samverkan** in **Moduler**. Activation is per unit, off initially, audited and revision-checked.
2. Open **Samverkan**. Create an inpatient, outpatient or SIP case from a patient you can already access. Choose the other participating units.
3. Record scoped, expiring consent. Until then, only the originating unit sees case metadata; other units cannot open it.
4. Send a care request. Change the active assignment to the hospital, enable the module for that unit and acknowledge the received message. The hospital sees the shared case, not the underlying primary-care chart.
5. From the hospital, send admission and discharge-ready messages. From primary care, record the fixed care contact and confirm availability of planned outpatient services.
6. Create a SIP with patient priorities, participation, meeting details, participants, goals, interventions, owners and follow-up dates. Invite the units, switch assignments to confirm each unit's responsibility, then finalize from the coordinating unit.
7. Send discharge from the hospital. Acknowledge outstanding messages before closing the case. SIP follow-up continues independently of case closure. Reopening a SIP clears confirmations; completed goals must be reconfirmed before closing the plan.
8. Upload a small TXT/PDF attachment, download an authorized case/SIP PDF, or export the selected inbox page as CSV. The public workspace expires. Use persistent synthetic staging for restart recovery.

The separate Vitalövervakning switch also starts off deliberately; this is not an access error. Turning a module off blocks its writes, without deleting history. Samverkan consent can still be withdrawn while the module is off.

## Components

Contracts are in `packages/coordination.ts`. Each service has one replaceable provider in the operator-controlled profile.

| Provider                    | Responsibility                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `coordinationDirectory`     | Map workforce units to organisations, hospital/primary-care/municipality roles and optional opaque notification routes     |
| `coordination`              | Cases, consent, unit inboxes, recipient-scoped messages, receipts, retraction, process transitions, history and CSV export |
| `sipPlans`                  | Structured versioned plans, invitations, per-unit confirmation, finalization, follow-up and closure                        |
| `coordinationPayment`       | Pure calculation from dated facts and versioned policy; estimate or blocking reasons                                       |
| `coordinationDocuments`     | Persisted attachments, integrity hashes, authorized downloads and generated PDFs                                           |
| `coordinationNotifications` | Durable generic delivery, leases, retries, destination binding and cancellation checks                                     |
| `notificationTransport`     | Existing authenticated HTTP gateway adapter, shared with follow-up; replaceable delivery provider                          |

`apps/web/coordination-workspace.js` is a separate UI module. The API does not depend on its layout. Removing SIP/documents from a profile removes their routes and controls; core cases remain available. Documents require SIP for combined exports. Payment and directory providers are required by the core but independently replaceable. Installation is reviewed server configuration, not code uploaded through a browser. Plugins remain privileged in-process code.

## Persistence And Access

Case, party, message, receipt, notification, plan, event and attachment records use the existing versioned store and audit chain. SQLite and PostgreSQL implement the same transactions. A message, recipient receipts, notification outbox and case transition commit together. Conflicting edits receive 409. Process-message retraction is allowed only in reverse transition order and retains history.

Private `sam*` records have no chart `patientId` and are excluded from chart views, generic chart history/change feeds and FHIR projections. The source-patient reference is retained for restriction checks but omitted from shared responses. Every access checks current staff assignment, tenant, permission, active membership, patient restrictions and consent. Writes also require unit activation and contributing membership. Exports and billing have separate permissions; hospital process events require `coordination.discharge`.

Messages are visible only to their sending/receiving units. SIP, participants, attachments and case history are shared with all currently consented case participants. History does not copy recipient-private message bodies or retraction reasons. Adding/reactivating a unit invalidates consent until a new scope is recorded. Changing contributors reopens an active SIP and invalidates confirmations. Units with unfinished SIP responsibilities cannot simply be removed. Consent withdrawal does not delete history.

**Deployment boundary:** the demonstration is one tenant containing multiple care units, not federation between independent provider databases. Existing PostgreSQL tenant/role isolation is unchanged. Do not place unrelated real controllers into one tenant to bypass it. A regional service needs a reviewed controller/processor model and explicit federated identity, directory and exchange adapters. No cross-tenant query bypass has been added.

## Messages And Plans

Message types: care request, admission, planning, discharge-ready, discharge, care-transfer, administrative, referral, interruption and SIP invitation. Messages support explicit recipients, replies, receipt state/time/actor and reasoned sender retraction. Acknowledgement records receipt, not delivery of care.

Inpatient states are `open -> admitted -> ready -> discharged`, with interruption from admitted/ready. Process events go to every other active unit. Discharge requires a fixed primary-care contact and confirmed outpatient availability. These are application guards, not a clinical decision engine. Clinical event time is distinct from the server's notification timestamp.

SIP states are `draft -> invited -> agreed -> closed`, with revision back to draft. The fixed primary-care contact's unit coordinates inpatient SIP. Every contributing unit must confirm the current plan; read-only units do not confirm. Changes do not carry old approvals forward. Patient involvement is documented by staff; there is no patient e-signature or citizen portal. Meeting details are stored and invitations delivered within the case, not in an external calendar/video service.

## Documents

Attachments are real stored bytes. Public mode limits files to 16 KiB; staging defaults to 64 KiB. Text must be UTF-8; PDFs must parse, be unencrypted and contain at most 100 pages. Parsing runs off the HTTP event loop in a worker with a two-second deadline and bounded V8 heap; this is not an OS security sandbox or a complete memory/CPU quota. Downloads verify SHA-256 and live authorization. Case metadata never contains attachment bytes. These limits reflect the transactional store, not document-management capacity.

Uploaded PDFs are **quarantined by default**. Parsing is not malware scanning. Only the synthetic public composition permits immediate PDF download (`developmentPdfDownloads`). Production needs an isolated scanner, quarantine release, hardened object storage, larger-file controls, retention and review. There is no fake clean result or working scanner claimed. Generated PDFs use pdf-lib and include permitted messages, SIP and, if authorized, a labelled payment estimate. Helvetica supports Swedish; unsupported glyphs become `?`, so multilingual font coverage remains a release gate.

## Notifications

Email/SMS delivery is delegated to the existing `eir.notification.v1` gateway, not simulated. Configure an opaque mailbox route in the directory and a reviewed HTTPS endpoint/credential in `eir.notifications.http`. Payloads contain a generic prompt and deployment URL, never names, case content or attachments. Gateway acceptance is not proof of email delivery or staff reading; clinical receipt is separate.

Run a supervised process with the same persistent storage/profile:

```sh
EIR_CONFIG=/absolute/path/to/reviewed-profile.json npm run worker:coordination
EIR_CONFIG=/absolute/path/to/reviewed-profile.json npm run worker:coordination -- --once
```

Keep embedded `worker:false` with the standalone worker. Workers poll every ten seconds, scan at most 50 due notifications per tenant per pass, use 60-second claims and at most five attempts. The bundled HTTP timeout is at most ten seconds. Retries preserve message ID; the gateway must deduplicate. After a claim, changing endpoint/origin cancels retry. Consent, membership, patient restriction, route and message state are checked before claiming. In-flight generic notifications cannot be recalled.

States are pending, sending, delivered-to-gateway, failed, cancelled or not-configured. The demo sends nothing externally. Switching the module off does not cancel committed notification obligations; withdrawing consent or retracting a message prevents subsequent claims. Operators must supervise workers and monitor failed/stuck queues. No guaranteed delivery or national notification integration is claimed.

## Payment And Legal Boundaries

The provider calculates a preliminary amount in integer öre using policy version, rate, grace days, noon cutoff, Stockholm calendar dates and discharge-day treatment. Missing notices, missing required invitation or unavailable/unclear outpatient services block estimation. Tests cover the noon boundary and daylight-saving transition. **The demo's SEK 5,000/day is fictional, not Sweden's 2026 rate or a VGR agreement.** Clinic configuration has no rate and cannot silently produce a charge.

Swedish law provides notice, fixed-contact and SIP requirements, a default three-/four-day payment start depending on notification time, and permits agreements changing timing/amount. This module does not implement every legal condition: authoritative residence/payment-municipality determination, a verified 24-hour admission-notice clock, all mandatory admission fields, regional aggregate settlement and approved invoicing remain missing. Output is an estimate, not a liability decision. [Current SFS 2017:612](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2017612-om-samverkan-vid-utskrivning-fran_sfs-2017-612/)

This implementation requires explicit scoped consent for all shared operations. It lacks statutory minimum-information exceptions, inability-to-consent/proxy pathways, compulsory psychiatric care and all confidentiality assessments. This is a known functional restriction, not a statement that Swedish law always requires consent. A regional clinical/legal team must review those pathways before real use.

## API

Routes are authenticated and appear in profile-aware `/api/openapi.json`. Request schemas are in `packages/coordination.ts`.

| Route (prefix `/api`)                         | Behavior                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /coordination?status=open&after=...`     | Unit inbox, at most 50 membership rows scanned; follow cursor even if filtered items are empty |
| `GET /coordination/report`                    | Same query/scope; permission-checked, audited page CSV as base64 JSON                          |
| `POST /coordination/cases`                    | Patient, title, pathway, participants                                                          |
| `GET /coordination/cases/:id`                 | Case, messages, receipts, metadata, history and permitted estimate                             |
| `POST /coordination/cases/:id/consent`        | Case version, grant/withdraw, expiry, units and reason                                         |
| `POST /coordination/cases/:id/action`         | Version plus close/contact/availability/participant change                                     |
| `POST /coordination/cases/:id/messages`       | Case version, type, body, recipients, optional reply/date fields                               |
| `POST /coordination/messages/:id/acknowledge` | Expected receipt version                                                                       |
| `POST /coordination/messages/:id/withdraw`    | Message version and reason                                                                     |
| `GET/POST /coordination/cases/:id/sip`        | Current plan/save; version 0 only for creation                                                 |
| `POST /coordination/cases/:id/sip/action`     | Plan version, invite/accept/finalize/reopen/close and reason                                   |
| `POST /coordination/cases/:id/attachments`    | Name, content type, bounded base64 bytes                                                       |
| `GET /coordination/attachments/:id`           | Authorized `{name, contentType, base64}` download                                              |
| `GET /coordination/cases/:id/pdf`             | Generated PDF in the same envelope                                                             |

Case reads are bounded to 1,000 records of each kind. Exceeding that returns a conflict instead of dropping older data. Archive/paginated long-case tools and population statistics remain to be built. Reports are a unit inbox-page CSV and permitted case/SIP PDF, not an exhaustive statutory subject-access export or financial ledger.

`tests/coordination.test.ts` covers access, consent expiry/withdrawal, protected records, recipient privacy, SIP revisions, workflow guards, real documents, CSV safety, rollback, notification retries and PostgreSQL restart/concurrency. `tests/coordination.e2e.ts` exercises the three-unit workflow and desktop/mobile layout. These are engineering tests, not clinical validation.

## Configuration And Upgrades

The module is included in demo/staging profiles and the clinic example. Clinical activation remains blocked; demo/staging activation is per unit. Existing persistent staff assignments are not automatically expanded when bootstrap configuration changes: grant reviewed assignments through the existing workforce administration rather than modifying old grants silently. The legacy `eir.config.json` is unchanged.

New private entity kinds use the existing storage schema; there is no destructive migration. Keep tested backups and verify restores with coordination records before deployment. Only public synthetic profiles permit direct PDF download. No AI provider reads shared case data or sends messages autonomously.

## Next Release Gates

- Regional acceptance: changed discharge dates, consent exceptions, representatives, deceased/protected patients and transfer of coordinating responsibility.
- SITHS/HSA onboarding, verified organisations, federation agreements and directory lifecycle. Existing OIDC/assignment controls are reused; no live SITHS connection is claimed.
- Approved payment rates/policies, residence attribution, notice deadlines, invoice review and historical settlement snapshots.
- Production scanning/document service, retention/archive, complete subject-access extraction and accessible multilingual PDFs.
- Independent security/privacy review, cross-controller threat model, monitored persistence, recovery drills and staffed notification escalation.
- A receiving-system-specific exchange adapter with contract tests. No SAMSA import/export or FHIR CarePlan/Communication implementation yet; see [FHIR.md](FHIR.md).

## Process References

The inpatient, SIP and outpatient separation follows publicly documented regional process families. SIP follow-up is independent of discharge closure. This is design inspiration, not reproduction of every regional rule. [GITS process overview, updated May 2026](https://gitsvg.se/shvo/samverkansprocesser/)

Further primary references: [VGR SAMSA overview](https://www.vgregion.se/halsa-och-vard/vardgivarwebben/it/it-system/samsa---samordnad-vard--och-omsorgsplanering/), [GITS fallback procedures and forms](https://gitsvg.se/shvo/reservrutin/). No proprietary code, branding or screen assets were copied.
