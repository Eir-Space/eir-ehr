# API Contract v0.1

Base: `http://127.0.0.1:4180/api`. JSON requests and responses. Every `/api` endpoint requires `Authorization: Bearer <session>` issued by the configured identity service. Client actor/role/tenant headers are ignored. FHIR exports use `application/fhir+json`. No SMART/OAuth discovery is advertised by the local identity profile.

Errors have `{error, fields?}`. Statuses: 401 invalid/expired session, 403 authorization, 404 missing record, 409 revision/lifecycle conflict, 422 validation. Request bodies are limited to 128 KiB. Rate limits and same-origin checks apply. Secrets and records are not included in server request logging.

| Method | Path                            | Operation                                                                                |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/session`                      | Authenticated actor, country, locale, configured renderers and supported vitals          |
| POST   | `/logout`                       | Revoke local bearer session                                                              |
| GET    | `/plugins`                      | Active plugin IDs, versions and service dependencies                                     |
| GET    | `/openapi.json`                 | OpenAPI 3.1 discovery with request schemas derived from validators                       |
| GET    | `/patients`                     | Patients accessible to this principal only                                               |
| POST   | `/patients`                     | Register patient; establish a 30-day local care assignment for registering clinician     |
| GET    | `/patients/:id/chart`           | Authorized clinical entities; patient/proxy views omit drafts/proposals                  |
| POST   | `/patients/:id/records/:kind`   | Create encounter/note/observation/condition/allergy/task                                 |
| POST   | `/records/:id/:action`          | Expected-version clinical transition                                                     |
| GET    | `/records/:id/history`          | Authorized version history                                                               |
| GET    | `/patients/:id/changes?after=0` | Up to 100 version entries plus next cursor; patient-specific authorization on every poll |
| GET    | `/patients/:id/export/fhir`     | FHIR R4 collection Bundle projection                                                     |
| POST   | `/patients/:id/ai`              | Generate/persist proposal for specified open encounter                                   |
| POST   | `/proposals/:id/review`         | Accept into draft note or reject                                                         |
| POST   | `/patients/:id/access`          | Clinician grants expiring clinician or proxy access                                      |
| POST   | `/patients/:id/restriction`     | Patient toggles the coarse local restriction                                             |
| GET    | `/audit`                        | Auditor: tenant events; patient: own events; last 200 events and chain verification      |

Local care assignments, proxy grants and the coarse restriction are development policy primitives. The API does not verify HSA employment, legal guardianship, delegation evidence or Swedish cross-provider access rules. Do not expose these primitives as a production onboarding workflow.

## Payloads

Patient creation:

```json
{
  "name": "Alex Exempel",
  "birthDate": "1985-03-12",
  "identifier": { "type": "local", "value": "DEMO-002" }
}
```

For Swedish national identifiers use `personnummer` or `samordningsnummer` and 12 digits. Birth date remains independently recorded; the system does not infer gender or assume national identity registration from a checksum.

Clinical create payloads (UUIDs are returned by previous operations):

```text
encounter:   {reason}
note:        {encounterId, text}
observation: {encounterId, code, value, unit, effectiveAt}
condition:   {code: {system, code, display}, onset?}
allergy:     {substance, reaction, criticality: "low" | "high" | "unable-to-assess"}
task:        {title, due: "YYYY-MM-DD"}
```

Supported vital codes/units are returned by `/session`. The server enforces code/unit pairing and input bounds. These are input integrity checks, not diagnostic interpretation. A diagnosis coding payload is recorded as entered; terminology-service validation is not yet implemented.

All entity revisions start at 1. Supply the currently read version:

```json
{ "version": 1, "data": { "text": "Reviewed clinical note" } }
```

Note actions: `save` with text; `sign` with `{}`; `amend` with text and reason. Encounter: `close`; task: `complete`; observation/condition/allergy: `correct` with reason. The latter marks the record entered-in-error; the corrected replacement is a new record.

AI request: `{encounterId}`. Review: `{version, decision: "accept" | "reject", text?}`. The response is a proposal entity including evidence refs and versions. Accepted proposals link to a new **draft** note through `noteId`. An accepted/rejected proposal cannot be replayed. A proposal with changed source context must be regenerated.

Access grant: `{actorId, role: "clinician" | "proxy", expires: ISO-8601 timestamp}`. Restriction: `{blocked: boolean}`. No caller can assign itself an API role through either endpoint.

## Export And Change Feed

FHIR output covers Patient, Encounter, Observation, Condition, AllergyIntolerance, DocumentReference and Task. Local references use Bundle UUID URNs; note content is base64 UTF-8. Local identifiers are institution-scoped; Swedish identifiers use the namespaces from the cited HL7 Sweden base guide. No profile conformance is asserted. Run a full FHIR validator and the intended national IG suite before exchange with another health system.

The change feed exposes immutable historical versions in database cursor order, scoped to one authorized patient. Persist `nextCursor` even when the page contains no visible entries: hidden draft/proposal versions may have been scanned. Delivery is polling-based and at-least-once from a consumer's perspective. Deduplicate by `record.id` plus `record.version`. It is not a FHIR Subscription endpoint or a push webhook system. Audit access and chart changes are separate streams.
