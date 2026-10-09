// Code system identifiers Eir uses internally versus the ones it puts on the FHIR wire.
//
// The ICD-10-SE catalogue is identified internally as `http://hl7.org/fhir/sid/icd-10-se`, a URL in
// HL7's reserved namespace that HL7 has not registered (its ICD-10 variants list names only
// Germany, the Netherlands and the United States). Sending it makes the official validator reject
// the resource, and it claims an authority Eir does not have. On the wire we use an identifier in
// Eir's own namespace until Sweden registers a canonical one. Replace it through configuration
// (`codeSystems`) when that happens; the mapping is reversible so imports round-trip.
export type CodeSystemMap = Record<string, string>;

export const defaultCodeSystems: CodeSystemMap = {
  'http://hl7.org/fhir/sid/icd-10-se': 'https://eir.space/fhir/CodeSystem/icd-10-se',
};

export const toFhirSystem = (system: string, map: CodeSystemMap = defaultCodeSystems) =>
  map[system] ?? system;

export function fromFhirSystem(system: string, map: CodeSystemMap = defaultCodeSystems) {
  for (const [internal, wire] of Object.entries(map)) if (wire === system) return internal;
  return system;
}

// A map must be one-to-one, or a round trip would be ambiguous.
export function assertReversible(map: CodeSystemMap) {
  const wire = Object.values(map);
  if (new Set(wire).size !== wire.length)
    throw new Error('codeSystems must map to distinct identifiers');
}
