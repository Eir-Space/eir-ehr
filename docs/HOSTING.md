# Public Demo Hosting

This is a **synthetic-only, disposable demonstration**, not clinical hosting.

## Topology

Spaceship DNS for `ehr.eir.space` -> Firebase Hosting (custom domain, managed HTTPS, static workspace and guide) -> Cloud Run `eir-ehr-demo` in `europe-north1` (Finland) for `/api/**`, `/demo/**`, `/deployment.json` and `/health`.

Firebase's CDN is global. This configuration is not a claim of exclusive EU processing or a healthcare data-residency solution. The dynamic demo runs in Finland; infrastructure request metadata can be logged. No external model, analytics service, persistent database or real national service is connected.

## Cost Controls

- Cloud Run request-based billing, minimum instances 0, maximum instances 1, 1 vCPU, 512 MiB, concurrency 40, 60-second timeout. Cold starts are expected.
- No Cloud SQL, VPC connector, dedicated load balancer, GPU or paid model API.
- Dedicated runtime service account with no project roles. The application requires no Google APIs.
- At most 20 workspaces per process, each with 400 API requests, 60 writes and 256 KiB cumulative request-body allowance. Individual requests are capped at 32 KiB. Capacity exhaustion returns a visible error, not shared patient data.
- The server rate-limits starts and requests. It deliberately does not trust arbitrary forwarded IP headers. Proxied traffic may share a rate-limit bucket; this is not a DDoS protection service.

Low traffic may fit within the free tiers. **There is no guaranteed zero-cost ceiling.** Cloud Run's request-based allowance is currently 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds monthly, shared across projects on the billing account. Builds, retained container images, logging, Firebase bandwidth and network egress can be billed separately. Existing services may already consume the free allowance. Maximum instances limits scaling but not cumulative monthly spend. Configure a small billing budget with alerts; alerts do not stop spending.

Pricing checked 2026-09-18: [Cloud Run](https://cloud.google.com/run/pricing), [Firebase Hosting quotas](https://firebase.google.com/docs/hosting/usage-quotas-pricing). Review actual billing before expanding this setup.

## Reproduce

```sh
npm ci
npm run terminology:import
npm run check
npm run test:e2e
npm run demo:public
```

Local public-demo mode listens on `http://127.0.0.1:4181`. The container sets `HOST=0.0.0.0` and `PORT=8080`. Do not expose the normal local-identity/persistent entry point as the public demo.

Deploy the Dockerfile to a new Cloud Run service. Use `eir-ehr-demo@eir-space.iam.gserviceaccount.com` with no project roles, `--min=0 --max=1 --cpu=1 --memory=512Mi --concurrency=40 --timeout=60 --cpu-throttling`, and public invocation. Set `EIR_PUBLIC_ORIGINS` to the comma-separated exact HTTPS origins for your Hosting site and custom domain. The origin allowlist handles the Firebase reverse proxy without trusting forwarded host headers. It is not authentication; API authorization still requires a per-visitor session.

`firebase.json` targets only the separate `eir-ehr-demo` Hosting site. With that site created in the project, run `firebase deploy --project eir-space --only hosting`. Its predeploy script copies only the static UI and installed Lucide asset. The API never returns a bearer token in a URL. Configure `ehr.eir.space` in Firebase Hosting, then add the exact DNS records reported by its custom-domain wizard/API to Spaceship. Do not change the apex, mail or other application records. DNS validation and TLS issuance may take time.

Deployment order: backend first, smoke its session/chart/write paths, then static Hosting assets, then repeat that smoke test through Hosting. UI and API remain compatible within this release. Old sessions can be lost during a deployment. To roll back, restore the previous Cloud Run revision and matching Firebase Hosting release.

## Session And Failure Behavior

If Firebase CLI authentication is not configured but the operator is already authenticated with `gcloud`, the repository also includes `npm run hosting:deploy -- eir-space eir-ehr-demo`. It uses the [documented Hosting REST deployment sequence](https://firebase.google.com/docs/hosting/api-deploy), prepares the static directory, validates the supported configuration, uploads content-addressed compressed files and only releases a fully finalized version. It requires explicit project and site arguments and keeps short-lived authentication in memory. It does not create service-account keys or change IAM. Use the CLI for Hosting configurations outside the script's deliberately narrow supported schema.

Each start creates a new plugin runtime with a separate in-memory SQLite database and random tenant. Bearer hashes route requests to that workspace. Unknown, revoked or expired tokens cannot access it. Start requests reserve a capacity slot before asynchronous setup. Logout destroys the runtime even after exhausting a budget. National identifiers are rejected by the public registration endpoint; free-text data cannot be reliably classified, so synthetic-only use is mandatory.

The 30-minute lifetime is checked before every API request. Timers may pause when Cloud Run is idle; cleanup also happens at the next start request, and process exit discards all databases. Refreshing a browser loses its token; its old inaccessible workspace is reclaimed on expiry, not immediately. Cloud Run may retire the instance at any time. Even with a maximum of one, deployments and platform replacement can temporarily create different instances. A token reaching the wrong instance receives a restart instruction, never another visitor's records. This deliberate reset behavior is acceptable for a demo, not for patient care.

## Before Real Clinical Use

For a live release check, run `npm run smoke:public -- https://eir-ehr-demo.web.app`, then `EIR_DEMO_TEST_URL=https://eir-ehr-demo.web.app npm run test:e2e`. The public browser test will drive the deployed service with synthetic data and log out afterward. Repeat with the custom domain once its HTTPS certificate is ready. The normal clinical browser test still uses its local isolated fixture.

Use the delivery and safety gates in [PLAN.md](PLAN.md): verified workforce identity, lawful access/proxy policy, protected identities, durable transactional storage, backup/restore evidence, immutable external audit, approved national integrations, deployment threat model, incident response and clinical validation. Do not migrate to real records by simply adding a volume or removing the demo badge.
