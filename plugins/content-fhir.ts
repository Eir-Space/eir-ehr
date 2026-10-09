import type { Plugin } from '../packages/contracts.ts';
import { createFhirStore, fhirOptions } from '../packages/fhir-store.ts';

// Registers a FHIR R4 server as a content store (observations, diagnoses, notes) under a key.
// Nothing contacts the server until the store is used; `health()` verifies it.
export default {
  id: 'eir.content.fhir',
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  contributes: ['contentStore'],
  setup(ctx, config) {
    ctx.contribute('contentStore', fhirOptions.parse(config).key, createFhirStore(config));
  },
} satisfies Plugin;
