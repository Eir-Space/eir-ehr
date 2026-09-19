# Staff Identity And Access

Release: 2026-09-19. Working identity/authorization modules, not a completed SITHS/HSA connection or approval for real patient data.

## Profiles And Setup

- `eir.config.json`: legacy development policy, retained for existing integrations/tests. Never use as a clinic deployment.
- `eir.demo.config.json`: strict workforce policy; public launcher provisions fictional local identities into disposable stores. Run `PORT=4193 npm run demo:public` to try clinical, reviewer and administrator assignments. Demo permissions are not recommended clinic role templates.
- `eir.clinic.config.example.json`: OIDC + strict authorization + workforce administration + audit review. Replace placeholders and provision staff before first startup. The example retains SQLite; select the PostgreSQL provider using [PERSISTENCE.md](PERSISTENCE.md) for a separately provisioned database.

Register a confidential OIDC client supporting Authorization Code flow, S256 PKCE, RS256 ID tokens and `client_secret_basic`. Register the exact callback `https://your-host/auth/callback`. Configure exact issuer, client ID, origin and approved `acr` assurance allowlist. Set the secret through the environment variable named by `clientSecretEnv`; never commit it. Start with `EIR_CONFIG=/absolute/path/to/profile.json npm start` behind a reviewed TLS reverse proxy. The server binds loopback. The `localTestOnly` HTTP exception is false by default and accepts only loopback endpoints; never use it in a real deployment.

Configure care units and initial bootstrap assignments, including an administrative operator, before creating the store. Assignment example:

```json
{
  "actorId": "stable-local-staff-id",
  "name": "Staff display name",
  "unitId": "configured-care-unit-id",
  "issuer": "https://your-registered-idp.example",
  "subject": "exact-verified-oidc-subject",
  "role": "administrator",
  "permissions": ["workforce.manage"],
  "validFrom": "2026-09-19T00:00:00.000Z",
  "validUntil": "2026-12-19T00:00:00.000Z",
  "enabled": true
}
```

Identity mapping is explicit issuer/subject, never email or client-supplied roles. One identity retains the same local staff ID across assignments. These are locally provisioned organizational assignments: live HSA synchronization is not implemented. Bootstrap runs once per provider store; editing bootstrap cannot restore revoked assignments. Subsequent provisioning uses administrator-authenticated `POST /api/workforce`; versioned changes/revocation also have a UI. Administration is unit-scoped and cannot modify one's own assignments. New-unit onboarding requires an operator-controlled migration. There is no open enrollment bypass if an operator was not initially provisioned.

## Login And Sessions

The OIDC adapter validates issuer, audience, JWKS signature, expiration, nonce, state, PKCE, authentication time and assurance. Browser-bound five-minute single-use transactions prevent replay and swapped browser flows. Provider tokens are discarded. A separate opaque EHR session is hashed at rest and sent in an HttpOnly, SameSite=Strict cookie, with Secure/`__Host-` naming on HTTPS. The transaction cookie is Lax for the identity redirect. Cookie-authenticated writes also require exact configured Origin. Application tokens never enter redirect URLs or browser storage. The OIDC adapter does not expose `issue()`.

Maximum session lifetime is eight hours; server inactivity is configurable up to 30 minutes, default 15. The default UI clears its chart after 15 minutes without API activity and on a 401. Unsaved text cannot be recovered after clearing; autosaved drafts remain. Manual lock flushes drafts before revocation. Assignments are reloaded every request; changes, expiry and revocation are not cached in tokens. Already completed disclosures cannot be recalled. IdP global/back-channel logout and multi-device session administration remain future work; local logout and fresh-login prompting work now.

## Policy

The independent `workforce`, `identity`, `access` and `accessReview` providers require active identity-matching assignments, specific action permissions, the same provider/care unit, and unexpired assignment-linked patient relationships. Restrictions deny access. Protected identity also requires `patient.protected`; unauthorized staff receive no such patient through directory, chart, history, change feed or export.

Permissions in `packages/workforce.ts` distinguish documentation/signing, medication/reconciliation, laboratory order/receipt/review, scheduling, tasks, AI, export and oversight. Clinical, administrative and review duties use separate assignments. The organization must approve its own duties-based needs/risk analysis. Registration records an initial 30-day relationship in the active unit. Delegation requires existing access, `access.manage`, a named active clinician in that unit, a reason, and expiry within 30 days and assignment validity. No self-grants or automatic proxy grants.

Only a draft's author can edit/sign under clinic policy. Signed notes retain assignment, unit and authentication method/assurance. This is application attestation, not qualified electronic signature; co-signing is not implemented.

Exceptional access requires a known internal patient ID, reason, `access.emergency` and chart-read permission. It lasts 15 minutes, is read-only/unit-scoped, never bypasses restrictions, and still requires protected-identity permission. No export, AI or writing is authorized by the exception. An event is recorded for review. This is NOT a complete Swedish emergency override or cross-provider consent mechanism. Cross-unit/provider sharing, verified citizen/proxy access and country-specific restriction management fail closed. Legacy records are not silently assigned to a unit. National protected-person search, safe contact channels and identity merges also remain outstanding.

## Review And Extension Boundaries

Reviewers see unit-scoped events, not patient charts. Staff-ID, patient-ID and outcome filters plus cursor pagination avoid a last-200-events blind spot. The UI offers older pages, page export and append-only assessments (`justified` / `follow-up`) tied to event sequence/hash. Own events cannot be self-reviewed; earlier assessments remain. Audit includes actor, assignment, unit, purpose, outcome and authentication method. Clinic policy blocks the legacy broad `/audit` route; permission denials and authenticated 403s are logged.

Hash-chain verification is NOT external anchoring: a database administrator could rewrite/recompute the chain. Immutable external storage, digest anchoring, automated suspicious-access detection, scheduled review, case ownership/escalation and patient-facing access reports are not implemented by the manual review screen.

Clinical services and AI enforce the shared policy. AI rechecks after inference before storing output; acceptance also requires record-write permission. Providers receive authorized evidence, not an unrestricted chart credential. In-process plugins remain trusted code with server-process privileges: dependency declarations are NOT a sandbox. Untrusted integrations need separate processes and scoped authenticated APIs. OAuth client credentials, SMART scopes, agent token brokering and marketplace isolation remain separate work.

## Migration And Pilot Gates

SQLite v2 adds session inactivity and durable login transactions. Upgrade invalidates v1 sessions, preserves records/audit and refuses future schemas. Take/verify a backup first; never run a v1 binary against v2. Assignments, revocations and reviews survive restart. Legacy patient data needs reviewed provider/unit/relationship migration before strict policy; no blanket migration is included.

Tests cover permissions, provider/unit boundaries, protected disclosure routes, exceptional access, review pagination/self-review, session switching/expiry/revocation, restart/bootstrap, schema migration, post-inference revocation, signed OIDC failure paths, browser CSRF/HttpOnly, authenticated signing and UI clearing. The loopback IdP signs real protocol messages but does not establish national integration or independent security review.

Before real data: a clinical design partner, approved access matrix/threat model, verified professional IdP and assignment source, privacy/safety/regulatory reviews, durable deployment with tested restore, external audit anchoring, incident/recovery exercises and independent testing. The asynchronous PostgreSQL provider and separate persistent synthetic staging are now described in [PERSISTENCE.md](PERSISTENCE.md); they are infrastructure groundwork, not a supervised clinical pilot approval.

## Primary References

- [Inera staff IdP](https://www.inera.se/tjanster/alla-tjanster-a-o/legitimeringstjanst-idp-for-medarbetare/): professional identity/HSA context; actual service/protocol/assurance requires onboarding.
- [IMY permission guidance](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/vard/informationssakerhet--for-vardgivare/tilldelning-av-behorighet-till-uppgifter-om-patienter--for-vardgivare/): duties-based needs/risk analysis, including protected identities.
- [openid-client](https://github.com/panva/openid-client) and [signature checks](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md): maintained protocol implementation used here.
