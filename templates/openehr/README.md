# Bundled openEHR operational templates

Used by the openEHR content provider (`plugins/content-openehr.ts`) and uploaded with `npm run openehr:setup`. `eir.openehr.profile.yaml` currently activates the vital-sign template as the direct canonical model; the problem and note templates remain adapter/conformance inputs until those record kinds receive their own reviewed migrations.

| File                                  | Used for                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `IDCR - Vital Signs Encounter.v1.opt` | Eir `observation` (pulse, respiration, temperature, blood pressure, SpO2) |
| `IDCR - Problem List.v1.opt`          | Eir `condition` (diagnosis with ICD-10-SE code)                           |
| `RIPPLE - Clinical Notes.v1.opt`      | Eir `note`                                                                |

**Provenance.** Copied unchanged from `service/src/test/resources/knowledge/opt/` in [ehrbase/ehrbase](https://github.com/ehrbase/ehrbase) (branch `develop`, fetched 2026-10-06). The EHRbase repository is Apache-2.0. The licensing of these three templates, and of the archetypes inside them, was **not separately verified**. Confirm it, and check the openEHR CKM terms, before any production use.

**Fitness.** These are general-purpose test and demonstration templates, not a Swedish or Eir-specific content model. Known gaps are listed in [PLUGIN-ARCHITECTURE.md](../../docs/PLUGIN-ARCHITECTURE.md#content-seam-slice-3). A real deployment should author or adopt templates with its clinicians.
