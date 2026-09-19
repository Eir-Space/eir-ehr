# Clinical Follow Up

Run `npm run demo:follow-up` for the loopback-only preview at `http://127.0.0.1:4197`. Use the temporary clinician session printed by the command. It seeds missing-result, critical-review and contact work, runs the real follow-up worker and delivers generic messages through a local HTTP test gateway. It does not send email/SMS or contact patients; its synthetic records reset when stopped. `EIR_FOLLOW_UP_PORT` selects another unused port.

This module extends existing tasks and laboratory review. It does not deliver medical advice, infer urgency from values, or replace a clinic's staffed critical-result procedure.

## Working Lifecycle

Orders retain an owned task while awaiting results. `expectedAt` optionally supplies an exact offset timestamp; legacy date-only deadlines are the start of the next day in the configured clinic timezone. Incoming reports reopen the task. Source-labelled critical flags select the configured review deadline; no laboratory threshold is guessed. Corrections reset review against the new report.

The review API accepts `disposition: completed | action-required` and `actionDueAt`. New UI reviews default to action required. Explicit completion means the clinician affirms all necessary actions are already completed. A legacy request without disposition leaves work open with an immediate deadline; it never silently asserts completed care. Existing completed records are not rewritten. Deploy the matching frontend with this behavioral change.

The Bevakning workspace shows open or closed tasks, exact deadlines, the responsible clinician, escalation blockers, gateway delivery and worker freshness. The clinician can open the chart, hand over responsibility, record a contact attempt or performed action, and explicitly complete the work. Only the current owner may record actions. A correction or concurrent reassignment invalidates a stale completion. Events are versioned/audited, paginated and available after closure. Contact attempts and delivered notifications do not complete clinical work.

## Authorization And Coverage

A clinician with `task.write` can schedule their own replacement for a bounded interval, including overnight or weekend coverage. Periods must not overlap. A team listing is not patient access: each automatic handover rechecks current workforce assignment, unit, clinical permission and care relationship. No grants are created. A policy may designate an eligible fallback recipient for escalation or an unavailable owner. Missing eligibility, missing routes and cyclic coverage remain visible blockers.

Ownership is not automatically returned when a coverage period ends or is cancelled. The current responsible person retains it until a deliberate handover or another valid policy transition. A per-cycle visited-owner guard prevents alternating coverage from endlessly bouncing work. Policies use elapsed time; there is no recurring roster importer or holiday calendar. Configure explicit coverage intervals and telephone fallback for the actual clinic.

Only authorized clinicians can see patient-linked oversight and event records. Administrators do not obtain chart access from managing integrations. Coverage, worker and notification records are excluded from chart/history/change-feed/FHIR/AI projection paths; clinical task state remains part of the clinician chart. Events have a dedicated authorized API.

## Replaceable Modules

- `eir.follow-up.policy` provides `FollowUpPolicy`: versioned deadlines, escalation interval, reminders, clinic timezone and optional fallback clinician.
- `eir.notifications.http` provides `NotificationTransport`: bounded real HTTPS delivery with acknowledgement correlation.
- `eir.follow-up` provides `FollowUp`: transitions, durable notifications, coverage, eligibility checks, oversight and a bounded worker.
- `apps/web/follow-up-workspace.js` is the replaceable browser view; the core authorizes all commands independently of the view.

These remain trusted in-process plugins. Swapping providers does not sandbox untrusted code. A replacement policy must pass the executable schema and clinical acceptance tests. A replacement transport must impose a deadline shorter than the worker lease and durably correlate acknowledgement before reporting success.

## Configuration

The demo/staging profiles enable synthetic policy defaults only: routine review 1440 minutes, critical review 15 minutes, escalation 30 minutes after the deadline and reminders every 60 minutes. These numbers are demonstration settings, not clinical guidance or nationally approved targets. Workers and external notification routes are off by default. The clinic example has no policy: it must be approved and configured for each provider and unit.

```json
[
  {
    "module": "./plugins/follow-up-policy.ts",
    "config": {
      "developmentDefaults": false,
      "policies": [
        {
          "tenant": "configured-provider",
          "unitId": "configured-care-unit",
          "version": "clinic-approved-policy-version",
          "timeZone": "Europe/Stockholm",
          "reviewMinutes": 1440,
          "criticalReviewMinutes": 15,
          "escalationMinutes": 30,
          "reminderMinutes": 60,
          "fallbackActorId": "configured-covering-clinician"
        }
      ]
    }
  },
  {
    "module": "./plugins/notification-http.ts",
    "config": {
      "endpoint": "https://gateway.example.invalid/notify",
      "tokenEnv": "EIR_NOTIFICATION_TOKEN",
      "timeoutMs": 5000
    }
  },
  {
    "module": "./plugins/follow-up.ts",
    "config": {
      "worker": false,
      "workspaceUrl": "https://clinic.example.invalid/",
      "routes": [
        {
          "tenant": "configured-provider",
          "unitId": "configured-care-unit",
          "actorId": "configured-clinician",
          "recipient": "gateway-route-identifier"
        }
      ]
    }
  }
]
```

Replace every example identity, destination and timing before clinical configuration. The `.invalid` host is not a connected service. Generate a distinct random token of at least 32 bytes (base64url), inject it through protected environment configuration, and arrange its rotation with the gateway. This does not provision SMS, email, a pager contract or a national messaging service.

## Worker And Delivery

Run `EIR_CONFIG=/absolute/reviewed-profile.json npm run worker:follow-up`; add `-- --once` for a bounded externally scheduled invocation. Do not combine it with `worker: true`. The embedded worker exists for development. Run clinical workers independently of incoming web traffic; a scale-to-zero web service alone is insufficient.

Each cycle scans at most 50 open tasks per configured unit and attempts one due notification per unit. Scan cursors persist across restarts. A completed full-scan timestamp is exposed separately from heartbeat; the UI warns when no full scan has completed within two minutes. This is an operational signal, not a promised latency SLO. Capacity, scan duration, backlog age and alert deadlines must be load-tested and externally monitored before a pilot. Failures must trigger an independently staffed monitoring route, not rely exclusively on the same gateway.

Task state, automatic reassignment, events and notification creation share a database transaction. Deliveries occur outside transactions under expiring fenced leases. Retries preserve message identity. The bounded exponential retry budget defaults to six; exhausted attempts stay visible and require reasoned, versioned replay. Dispatch rechecks current task cycle, owner, permission and configured recipient. Completed, corrected or reassigned work cancels stale queued notifications. A route/destination change does not silently reroute an existing message. In-flight generic notices can still arrive after work changes; the authenticated workspace is authoritative.

When dispatch detects a changed route, it cancels the old envelope. The next evaluation can create a fresh message explicitly bound to the new route; its message ID differs. If the old envelope already exhausted retries, replay it with an audit reason to trigger this check. Normal retries against the same route retain the original message ID. After changing any destination, verify delivery to the intended staffed recipient before relying on it.

Wire protocol `eir.notification.v1` is Eir-specific JSON, not FHIR or a national paging standard. Request: `protocol`, UUID `messageId`, configured `recipient`, fixed text `Open Eir to review assigned work.`, and a fixed authenticated-workspace URL. No patient name, patient ID, task ID, result, urgency or clinical text is transmitted. Staff routing identifiers remain personal/operational data requiring an appropriate processor agreement.

Headers are Bearer authorization, `Idempotency-Key` and `X-Eir-Payload-Sha256`. The gateway must durably deduplicate before acknowledging JSON `{messageId,payloadHash,status:"accepted"}`. Acknowledgements are capped at 2 KiB; redirects and insecure remote URLs are rejected. `delivered` means acceptance by the gateway, not delivery to a handset, reading by a clinician or acknowledgement of a critical result. Delivery is at least once; gateway deduplication is mandatory.

No new relational schema migration is introduced: versioned entities use the existing storage contract. `searchEntities` adds optional bounded `statuses` filtering in both SQL providers. Persistent clinic deployment still requires the existing PostgreSQL migration level. Back up and fence workers before restoration; reconcile notices accepted after the recovery point. Notifications and events follow the provider's retention policy, which must be configured operationally.

## Verification

`tests/follow-up.test.ts` exercises precise deadlines, coverage eligibility, action completion, correction races, delivery failure, replay, restart and independent PostgreSQL workers. `tests/follow-up.e2e.ts` exercises desktop/mobile clinical operations and history. `tests/integration-storage.test.ts` covers bounded status filtering in SQLite and PostgreSQL. Existing clinical, authorization and recovery suites remain release gates.
