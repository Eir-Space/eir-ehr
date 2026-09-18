# Care-Team Release

Implemented: daily scheduling/check-in, encounter-linked appointments, assigned follow-up inbox and server-autosaved note drafts. These are working modules, not national integrations or a production-readiness declaration.

## Use

The workspace navigation adds **Arbetslista**, **Inkorg** and **Patientjournal**. The public session seeds four appointments, three named team members and eight follow-ups. The initially selected clinician is Emma Sjoberg. Other team members are assignment targets; their titles are display information, not verified professional credentials or separate permission roles.

Arbetslista filters by clinic-local date and responsible clinician. Book, reschedule, mark arrival, record cancellation/no-show reasons and open an encounter. Starting a booking reuses the patient's existing open encounter or creates one atomically. A second appointment cannot share an in-progress encounter. Signing all drafts and closing the encounter completes its linked appointment in the same transaction. Scheduling a visit does not implement a video-call service or send a reminder.

Inkorg filters by owner and open/overdue/closed status. Tasks have priority, due date, responsible person, version history and optional completion outcome. Reassignment, postponement, cancellation and reopening require reasons. Only the current owner can start, complete or cancel; a covering colleague first records reassignment to themselves. The chosen colleague must already have an active care relationship. A roster entry or assignment never grants chart access. There is no automatic absence routing, escalation service or notification delivery yet.

Draft text autosaves after 900 ms of inactivity. Saves are serialized, use expected versions, and do not sign the note. Initial creates include a retry identifier to prevent duplicate drafts after an uncertain response. Conflicts preserve the unsaved editor text and show the saved version; replacing local edits requires explicit confirmation. Closing or Escape flushes pending edits, and a failed save keeps the editor open. Explicit discard leaves previously saved versions intact. Browser reload while dirty warns about unsaved changes.

On a persistent local installation, log in again after a reload and open the saved draft under Anteckningar. The public demo remains disposable: reload loses its session, instance replacement loses its workspace, and drafts are not recoverable across new demo sessions. No patient text or bearer token is stored in localStorage/sessionStorage/IndexedDB. This is recovery of server-confirmed saves, not offline storage or a guarantee that an unacknowledged keystroke survives a browser crash.

## Module Contract

`eir.care-team` requires `store` and `access` and provides `CareTeam`. It has no SQL and uses the same transactional record/version/audit path as clinical records. The clinical plugin delegates task commands and invokes `encounterClosed` inside its close transaction. Replacement implementations must preserve that transaction boundary and the access/overlap/state-machine tests.

Config: `{timeZone: "Europe/Stockholm", members: [{id, tenant, name, profession}]}`. Roster entries are tenant-scoped and operator-controlled. An authenticated clinician not listed has a self entry. Production workforce directory/credential validation and more granular roles remain separate planned work. Clinical task records without `assigneeId` continue to use their original author as owner.

The care-team release adds the required `careTeam` service and `Access.allowed` permission predicate. Custom profiles must add a compatible provider; custom access plugins must implement the predicate using the same policy as `check`. The predicate does not record disclosures. Workspace queries call audited `check` before returning patient-linked data. Patient/proxy chart, history and changes omit internal tasks and appointments as well as proposals and draft notes. A citizen appointment view needs its own deliberate authorization contract.

Scheduling uses the Temporal polyfill, never the server/browser local zone. `localStart` is converted in the configured IANA clinic timezone. Nonexistent and ambiguous DST wall times are rejected, not guessed. Overlap checks cover the patient and clinician across all active tenant bookings without disclosing another patient's identity. Date queries include bookings overlapping midnight. Availability calendars, rooms/equipment, recurrence and waiting-list rules remain future work.

## Verification And Limits

`tests/care-team.test.ts` covers overlapping/adjacent bookings, DST, transitions, delegation, wrong-tenant/blocked access, patient-hidden records, idempotent drafts, persistence and transaction rollback. `tests/care-team.e2e.ts` covers booking through signed encounter closure, inbox handover/completion, offline recovery, concurrent editing and desktop/mobile layout. Its public test also runs against `EIR_DEMO_TEST_URL`.

The inbox is an on-demand, authorized view. Refresh fetches current state; concurrent edits return a conflict rather than overwriting. The current SQLite implementation is still a single-process development deployment. PostgreSQL, strong workforce identity, protected-identity policy, independent security/clinical validation, NMI/intended-use assessment and real national connectivity remain pilot gates in PLAN.md.
