# Reliable Laboratory Integrations

This is working delivery infrastructure, not a claim of connection to a Swedish laboratory or national service. `eir.lab.v1` is Eir's explicit JSON-over-HTTPS protocol. It is not HL7 v2, a FHIR implementation guide or an Inera contract.

Default public/staging profiles include the modules with **no configured external destinations and no background worker**. Clinical deployment requires a laboratory agreement, approved adapter, identity/terminology mapping, security review, operational ownership and end-to-end acceptance evidence.

## Working Flow

1. A clinician selects an authorized laboratory. The order, owned follow-up task, immutable delivery envelope, versions and audit commit in the **same transaction**.
2. A worker reserves due work with an expiring lease and sends outside the transaction. Retries retain the exact message ID and payload hash. New leases fence off late workers.
3. HTTP success alone is insufficient: the acknowledgement must match the message, order, patient and hash. Explicit rejection, malformed acknowledgements and exhausted retries remain visible for operations.
4. The laboratory posts results using a separate machine credential. The envelope is stored before `202`: **received**, not clinically applied or reviewed. Duplicates return the original receipt. Reusing an ID with changed content returns `409` and appends a denial audit, without overwriting anything.
5. Processing verifies connector scope, exact patient/order identifiers, the lab's order acknowledgement, current restrictions, correction predecessor, and an active assigned reviewer with a current care relationship. Unsafe messages stay outside the chart.
6. Report, order, follow-up task, receipt state, versions and audit commit atomically. Critical results create urgent owned review work. Corrections retain previous reports and reopen the same responsibility. Only the authorized assigned clinician can review/acknowledge them.

Network delivery is **at least once**. The receiver must durably deduplicate and save its response before acknowledging. Eir enforces one clinical application per connector/message identity; it does not claim exactly-once delivery across the network. A crash after remote acceptance can cause another HTTP delivery with the same key.

## Modules

| Module                              | Responsibility                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `plugins/integrations.ts`           | Durable queues, machine scope, matching, lease/retry policy, atomic application, audited operations |
| `plugins/lab-transport-http.ts`     | Real bounded HTTPS order transport implementing `LabTransport`                                      |
| `packages/integrations.ts`          | Versioned wire schemas and service interfaces                                                       |
| `packages/lab-application.ts`       | Internal shared report/task transitions; authorized callers hold the transaction                    |
| `apps/web/integration-workspace.js` | Unit-scoped operations UI, without raw payloads or credentials                                      |
| `apps/integration-worker.ts`        | Supervised worker process or bounded `--once` execution                                             |

API-2 storage providers may expose `searchEntities`. This runtime requires the capability and fails startup without it. SQLite/PostgreSQL implement bounded database-side filtering and keyset pagination. Queue identities have uniqueness constraints; payload, hash, scope and matching fields cannot be revised. No Redis/Kafka or mandatory paid service is required.

`integration.manage` is an administrative permission, separate from clinical and workforce management. **Existing persistent assignments are not automatically elevated.** Use the workforce change workflow with a different authorized administrator. Operators can inspect metadata, pause/enable configured connections and retry failed messages with an expected version and reason. They cannot edit envelopes, switch patients, reroute orders, force clinical application or replay applied/acknowledged messages.

Machine credentials authorize only result intake and receipt lookup for their configured connector/tenant/unit. They cannot authenticate at `/api/session`, read charts, sign notes, prescribe, manage staff or execute AI. Writes are attributed to `connector:<id>` with audit role `integration`; no clinician identity is borrowed and no machine session is created.

Server plugins remain trusted in-process code, not a security sandbox. Untrusted integrations must run out of process behind scoped credentials and restricted egress. A replacement `LabTransport` can change network implementation while preserving `eir.lab.v1` semantics; the core independently validates acknowledgements. A different clinical model needs an explicit schema/version and conformance tests, not an unvalidated pass-through.

## Configure And Run

Add these entries to a reviewed profile that supplies `store`, `access`, `workforce`, `laboratories` and `careTeam`. Paths resolve relative to the profile file. Tenant/unit must already exist in workforce configuration.

```json
[
  { "module": "./plugins/lab-transport-http.ts" },
  {
    "module": "./plugins/integrations.ts",
    "config": {
      "connectors": [
        {
          "id": "partner-lab",
          "name": "Contracted laboratory",
          "tenant": "configured-provider",
          "unitId": "configured-care-unit",
          "adapter": "eir.lab.v1",
          "endpoint": "https://lab.example.invalid/eir/orders",
          "outboundTokenEnv": "EIR_LAB_ORDER_TOKEN",
          "inboundTokenEnv": "EIR_LAB_RESULT_TOKEN"
        }
      ],
      "worker": false,
      "timeoutMs": 10000,
      "leaseMs": 30000,
      "retryMs": 5000,
      "maxAttempts": 6
    }
  }
]
```

The `.invalid` URL is explanatory, not a partner connection. Use the contracted endpoint. Credentials must be **different**, independently generated random base64url tokens of at least 32 bytes (43-256 permitted characters). Inject secrets through protected environment variables, never JSON, source control, URLs or logs. Rotate both parties together; overlapping-key grace periods are not implemented. Verified TLS/mTLS or gateway policy may supplement transport, but this module does not claim OAuth client-credentials or national PKI integration.

Remote endpoints require HTTPS with normal Node certificate verification. URL credentials, queries, fragments and redirects are rejected. Test HTTP requires `localDevelopmentOnly: true` with literal `127.0.0.1`/`[::1]`. Endpoint configuration is a trusted deployment operation; also restrict DNS/network egress to approved lab destinations.

Destination, tenant, unit and protocol are bound to a persisted connector fingerprint. Changing them under an existing ID fails startup. Reconcile old work before provisioning another identity. Removing a connector stops authentication/processing but preserves its records; restore its original configuration for reconciliation.

PostgreSQL migration version 2 adds queue indexes, uniqueness and immutable-message guards. Apply with operator credentials **before** new API/worker processes start:

```sh
npm run db:migrate -- --connection-string-env EIR_POSTGRES_MIGRATION_URL
EIR_CONFIG=/absolute/path/to/reviewed-profile.json npm run worker:integrations
```

For a bounded externally scheduled invocation:

```sh
EIR_CONFIG=/absolute/path/to/reviewed-profile.json npm run worker:integrations -- --once
```

One cycle handles at most one outgoing and one incoming message per configured connector. The continuous runner polls between cycles. `worker: true` embeds a worker for single-process development; do not also run the standalone runner in that process. Multiple PostgreSQL worker processes share leases and role-bound tenant storage. SQLite is a local development option, not distributed clinical deployment.

Use supervised workers independent of web traffic, or external scheduled jobs with a backlog/capacity policy. A scale-to-zero HTTP service alone is **not** a reliable background worker. Cloud Run scheduling/scaling and costs remain operator choices, not resources provisioned by this change or a promise of zero cost.

## Wire Contract

`POST /api/patients/:id/lab-orders` accepts the usual fields plus `connectorId`. Without it, the order is local/manual. `GET /api/lab-connectors` lists active permitted choices; `GET /api/lab-orders/:id/delivery` exposes authorized delivery status, not its envelope.

Orders use JSON, an outbound bearer credential, `Idempotency-Key: <messageId>` and `X-Eir-Payload-Sha256: <hash>`. `OrderMessage` contains protocol/type, connector/message/order/patient IDs, a minimal patient identification snapshot and the test/specimen/requester. The full chart and AI context are never included.

The acknowledgement includes `protocol: eir.lab.v1`, the original UUIDs `messageId`, `orderId`, `patientId`, `payloadHash` (64 hex characters), and `status: accepted | rejected`. Optional `reasonCode` is restricted to `unsupported_test`, `invalid_specimen`, `invalid_patient`, `not_authorized`, `duplicate_order`, `other`. Never send patient data as diagnostics. Responses are capped at 8 KiB. Hashing uses recursively sorted object keys, original array order and ordinary JSON primitive encoding; use the exported `canonical()`/`payloadHash()`. This is Eir's rule, not a claim of RFC 8785 conformance.

Results use **`POST /integrations/:connectorId/results`**, outside `/api`, with the inbound bearer token. The strict `ResultMessage` schema includes:

- `protocol`, unique `messageId`, original `orderMessageId`, `orderId`, `patientId`.
- `patientIdentifier: { system, value }`, matching the outgoing snapshot and current patient.
- `supersedesMessageId: null` for an initial report or the precise previous message UUID for a correction.
- `report: { collectedAt, reportedAt, results, correctionReason? }`. Observations contain `name`, `value`, `unit`, `reference`, and source-supplied `flag`: `unknown`, `normal`, `high`, `low`, or `critical`. Thresholds are not guessed. Corrections require a reason.

Times are offset datetimes, collection before reporting, neither in the future. Syntactically invalid envelopes get `422` without a receipt. Semantically unmatched envelopes are durably quarantined; no fuzzy name matching or silent reassignment occurs. Bodies are limited to 128 KiB and 30 observations per report. `GET /integrations/:connectorId/receipts/:messageId` returns processing state and a bounded code, never clinical payloads.

`/api/openapi.json` includes enabled integration routes with separate connector security and base paths. The exported TypeScript/Zod schemas are executable protocol definitions.

## Recovery And Limitations

Outgoing states: `pending -> sending -> acknowledged | rejected | retry | quarantined`. Inbox uses the same lease/retry mechanism and terminates at `applied` or `quarantined`. Abandoned leases become eligible at their stored deadline. Exponential backoff has jitter, a one-hour cap and a bounded attempt budget. Audited replay resets that budget, not the total attempt count or immutable identity.

Network faults, 429/5xx, and missing order/predecessor acknowledgements retry. Wrong identities, conflicting corrections, restrictions, invalid acknowledgements and unavailable review ownership require intervention. Clinical/storage failures roll back application before recording retry. Logs contain fixed diagnostics, not partner response bodies, credentials or clinical content.

Pause stops new claims and rejects new incoming messages. In-flight transmissions can finish and retain their acknowledgement; already transmitted bytes cannot be retracted. **Connected-order cancellation is blocked** until a partner-specific confirmed-cancellation protocol exists. Reconcile with the lab rather than displaying a false local cancellation. Manual result entry cannot bypass the connector.

Operational owners must monitor failed cycles, oldest pending work, quarantined results and overdue clinical tasks, with agreed response times and telephone fallback. The UI supports investigation/retry, not paging/SMS, staffed monitoring or certified critical-result escalation.

Before restoring a clinical database, stop ingress/workers and fence the original deployment. Restored outbox rows may replay messages accepted after backup: receiver idempotency and reconciliation are mandatory. Credentials are not in backups. Review accepted-but-unapplied receipts before restart. Queue/history/audit retention remains subject to the provider's approved policy; no automatic deletion is implemented.

## Local Sandbox And Verification

```sh
npm run demo:integrations
```

The developer harness runs EHR at `http://127.0.0.1:4195` and the test-lab console at `http://127.0.0.1:4196`, with a real HTTP receiver and isolated SQLite data. Use the temporary clinician session printed in the terminal. Choose **Anslutet testlaboratorium** on an order, register a result in the lab console, then refresh the EHR. Select the administrative assignment for **Integrationer**, filters, pause and audited retry. The lab console can simulate downtime, lost/incorrect acknowledgements and rejection. Data is disposable and cleaned on normal shutdown. `EIR_SANDBOX_PORT`/`EIR_LAB_SANDBOX_PORT` override ports. This is local test tooling, not public hosting or a clinical laboratory product.

`npm run check` includes both storage contracts. `EIR_TEST_POSTGRES_URL` must point to a disposable administrative test database to run independent PostgreSQL replicas, actual HTTP, duplicate/wrong-patient protection, correction ordering, audit rollback, restart after acceptance, leases, bounded queries, revocation and immutable message tests. `npm run test:e2e` covers clinical ordering, operator reconciliation and desktop/mobile layouts. Existing encrypted backup/restore and clinical regression tests remain required.

The next external milestone is a contracted Swedish lab test endpoint, coded test/specimen catalogue, identity mapping, partner security/transport, confirmed cancellation and jointly approved acceptance scenarios. This runtime alone does not mark any national integration as connected.
