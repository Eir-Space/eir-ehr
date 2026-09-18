# Diagnosis Catalogue

`eir.terminology.icd-se` implements the `Terminology` contract: release metadata, local code/text search and exact lookup. The clinical plugin depends on this contract, not on a Swedish data file. Replace the provider in the operator-controlled profile for another national catalogue. Switching the country identifier plugin alone does not switch terminology.

## Install

```sh
npm ci
npm run terminology:import
```

The importer downloads the official ICD-10-SE release valid from 2026-01-01. An operator can supply an already downloaded TSV with `npm run terminology:import -- /path/to/icd-10-se.tsv`. The same pinned SHA-256 is required in both modes. Changed upstream bytes fail closed and require a reviewed release update.

The importer uses a TSV parser, validates the checksum and source row count, and derives 38,631 codes/categories with Swedish labels and search terms. Generated data lives in ignored `.terminology/`, outside the Apache-licensed repository. CI and the container build import the same verified source. There are no external requests during clinical search. One read-only search index is shared across public workspaces; patient records remain isolated.

## Source And Rights

- [E-hälsomyndigheten classification downloads](https://samarbetsyta.ehalsomyndigheten.se/spaces/IR2/pages/451267009/Ladda%2Bner%2Bfiler%2Bf%C3%B6r%2Bklassifikationer). The publisher describes the TSV as intended for import into EHR and information systems.
- The pinned file URL, release date and checksum are recorded in `packages/icd.ts` and returned in API source metadata.
- [Official file description](https://samarbetsyta.ehalsomyndigheten.se/download/attachments/451267009/beskrivning-filinnehall-icd-10-se.pdf?api=v2&modificationDate=1779615770723&version=1).

ICD content and its Swedish translation retain their respective WHO/Socialstyrelsen rights. E-hälsomyndigheten now publishes the Swedish classification. Importing the data does not relicense it under Apache-2.0. Review publisher terms before redistributing a catalogue or derivative dataset; do not commit the downloaded source or generated catalogue. The application code, importer and adapter are Apache-2.0.

## Behavior And Boundaries

Search accepts codes with or without a decimal point, Swedish text, accent-insensitive text and published example/inclusion terms. Exact codes rank first. Empty search returns a small set of common codes, not patient-specific diagnostic suggestions. Results include total matches, bounded items and release metadata.

Three-character categories that have subcodes are navigable but cannot be saved as a diagnosis. Codes with optional Swedish extensions remain selectable at the four-character level. A condition write rejects unsupported systems, unknown/non-specific codes and a supplied stale release version. The server replaces client labels with canonical labels and persists the coding version, including in FHIR export. Existing historical records are never silently recoded on release changes.

This is a terminology lookup, not an automated diagnosis or complete coding-rule engine. It does not apply every exclusion, combination, principal-diagnosis or sequencing rule. Result metadata flags manifestation codes and codes marked not suitable as a principal diagnosis; the UI highlights those flags. The clinical record currently stores an unranked problem, not a coded billing claim. External-cause and other supplementary entries are searchable. The separate placeholder-code publication is not imported. Clinical coding review remains necessary.

The current synchronous contract suits a local catalogue. A remote national terminology server needs an explicitly asynchronous contract change and outage/privacy tests, not a blocking network call inside `lookup`.
