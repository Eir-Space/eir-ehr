import { createFhirStore } from '../packages/fhir-store.ts';
import { runContentContract } from './content-contract.ts';

// Needs a FHIR R4 server: docker compose -f docker/compose.fhir.yml up -d
const url = process.env.EIR_TEST_FHIR_URL;
runContentContract(
  'FHIR content store',
  async () => ({ store: createFhirStore({ endpoint: url }), stop: async () => {} }),
  { skip: url ? false : 'EIR_TEST_FHIR_URL is not set' },
);
