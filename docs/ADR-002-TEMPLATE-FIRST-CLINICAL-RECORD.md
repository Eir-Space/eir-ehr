# ADR-002: Template-first clinical record authority

- Status: accepted and implemented for vital signs
- Date: 2026-10-09
- Scope: `eir.openehr.profile.yaml`

## Context

Detailed clinical data is contextual and commonly tree-shaped. Capturing it first in an unrelated
relational schema and converting it later can discard distinctions that an openEHR archetype or
template requires. Some conversions cannot be made reliably after the fact.

Eir still needs relational storage for identity, authorization, workflow, queues, audit, retries and
operational reporting. The choice is therefore not SQL or openEHR. The decision is which system is
authoritative for each class of data and which model controls capture.

## Decision

1. Clinical authority is selected per record kind in a deployment profile. In the first slice,
   `observation` is canonical in openEHR. Encounters, notes, conditions, allergies, medications and
   operational state remain on their existing path until their own model-led migrations are complete.
2. The active clinical-model plugin exposes the capture forms and validates commands against pinned
   operational templates. Startup verifies the exact SHA-256 digest of every bundled OPT.
3. The clinical command writes canonical content to the repository before creating its SQL mirror.
   The SQL mirror preserves Eir identity and workflow compatibility but is not clinical truth.
4. Every canonical create requires a client-generated operation ID. SQL records the operation ID,
   request hash, state and resulting identifiers, but not the clinical values. If the repository
   commits and the connection is lost, retry finds the composition by operation ID and completes the
   mirror without duplication. A database-backed lease prevents concurrent requests from racing the
   same operation ID.
5. Authorized chart, history, deterioration, AI-evidence and FHIR-export paths resolve canonical
   records from the repository. A repository-side revision therefore wins over stale mirror data.
6. Mappings are deterministic code reviewed with the template. A language model may propose a
   migration candidate for human review in the future, but it is never the authoritative conversion
   mechanism.
7. Data that the active model cannot represent is rejected with a precise error. It is not stored
   lossily in an extension or silently dropped.

## Authority matrix

| Data                                         | Authority in the openEHR profile | SQL responsibility                           |
| -------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Pulse, respiration, temperature and SpO2     | openEHR composition              | operation, link, mirror identity, audit      |
| Paired systolic and diastolic blood pressure | one openEHR composition          | operation, link, mirror identity, audit      |
| Encounter and note workflow                  | SQL                              | full record and lifecycle                    |
| Conditions, allergies and medications        | SQL                              | full record pending model-led migration      |
| Identity, access, tasks, queues and audit    | SQL                              | full operational authority                   |
| FHIR export                                  | derived                          | generated from the authorized resolved chart |

The SQL observation mirror is rebuildable from its `contentLink` and canonical composition. It must
not be used as an independent clinical source.

## Write protocol

1. Authorize the actor and verify the open encounter in SQL.
2. Insert or resume a `clinicalWrite` operation containing a request hash and no clinical payload.
3. Validate the command with the active template-backed model.
4. Create the openEHR composition using the operation ID as its idempotency origin.
5. In one SQL transaction, create the mirror and `contentLink`, complete the operation and append the
   Eir audit event.

| Failure point                                      | Result                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| Validation or authorization fails                  | No canonical or mirror write                                         |
| Repository fails before commit                     | Operation marked failed with a non-clinical reason; retry is allowed |
| Repository commits and response is lost            | Retry finds the same composition; no duplicate                       |
| SQL finalization fails after repository commit     | Operation remains recoverable; retry completes the mirror            |
| Same operation ID is reused with different content | Conflict; existing clinical content is unchanged                     |
| Repository is unavailable during a canonical read  | Read fails closed; stale mirror values are not presented as current  |

This is a recoverable cross-system workflow, not a distributed ACID transaction. The operation row
and idempotent repository lookup make the partial state explicit.

## Implemented clinical model

The vital-sign form is derived from the active bindings for `IDCR - Vital Signs Encounter.v1`.
Systolic and diastolic pressure are captured together and committed as one blood-pressure
composition. Pulse, respiration, temperature and SpO2 use their archetyped paths. Body weight is
not present in the active template and is rejected.

The bundled templates are demonstration inputs whose separate licensing and Swedish clinical fitness
remain unverified. They are not approved production models. See `templates/openehr/README.md`.

## Consequences

- Clinical structure is preserved at capture instead of reconstructed later.
- openEHR availability is required for canonical vital-sign writes and reads.
- The existing projection profile remains useful for migration, comparison and non-canonical kinds,
  but it is not the authority model of `eir.openehr.profile.yaml`.
- Each additional clinical kind needs an agreed template, reviewed UI, deterministic mapping,
  migration rules, negative tests and an explicit authority switch. Enabling every content kind at
  once would recreate the ambiguity this decision is intended to remove.

## Verification

- `tests/template-first-clinical.test.ts` covers direct writes, lost-response recovery, operation
  privacy, repository-side revisions, typed reads, corrections, unsupported data and grouped blood
  pressure.
- `tests/template-first-openehr.test.ts` runs against EHRbase and proves that one blood-pressure
  composition contains both archetyped values and is readable through AQL.
- `npm run plugins:dump` resolves the profile and reports the active providers before startup.
