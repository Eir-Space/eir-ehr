# Contributing

Eir EHR is an open collaboration to build an open-source electronic health record for Sweden, with replaceable modules for other countries. Clinicians, patients, designers, security specialists, translators and engineers are welcome. You do not need to write code to identify an unsafe workflow, improve a label or make documentation clearer.

## Open A Pull Request

1. Read the [plan](docs/PLAN.md) and existing issues. For substantial changes, open an issue with the workflow, scope and acceptance criteria first.
2. Fork this repository, clone your fork and create a focused feature branch.
3. Install dependencies and run the synthetic workspace using the README instructions.
4. Implement the change with tests. Preserve module boundaries and existing clinical data semantics. Document migrations and API changes.
5. Run `npm run check`, `npm run format:check` and `npm run test:e2e`.
6. Open a pull request against `main`. Include screenshots for UI changes and explain what was tested, what remains uncertain and any clinical or security risks. Address review feedback before merge.

## Other Ways To Help

Use issues for synthetic workflow feedback, bug reports, accessibility findings, documentation suggestions and country-pack proposals. Include concrete steps, expected behavior and the care setting. National-service adapters require current primary documentation, an authorized test environment and conformance evidence. Never simulate a successful national transaction to make an integration look complete. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Review Standards

Use Apache-2.0-compatible contributions and sign off commits with the Developer Certificate of Origin (`git commit -s`). Keep clinical workflows, country policy, persistence and presentation in their declared modules. Explain the user behavior, contract change, migration impact and verification in each pull request.

Run `npm ci`, `npm run terminology:import`, `npm run check`, `npx playwright install chromium`, and `npm run test:e2e`. Use only synthetic fixtures. Never commit a database, credential, patient identifier from a real record, identifiable clinical text or downloaded terminology dataset. Do not label a connector operational until it has passed its service-specific checks against an authorized test environment.

New plugins must document trust, dependencies, cleanup, license and failure modes. Replacing a provider must pass its behavioral contract suite. Security, record lifecycle, migrations and clinical semantics require maintainer review. Architectural decisions and country-specific requirements belong in public documentation.
