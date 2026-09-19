import { createRequire } from 'node:module';
import { Fault, type Plugin } from '../packages/contracts.ts';
const Personnummer = createRequire(import.meta.url)(
  'personnummer',
) as typeof import('personnummer').default;

export default {
  id: 'eir.country.se',
  version: '1.0.0',
  apiVersion: 2,
  requires: [],
  provides: ['country'],
  setup(ctx) {
    ctx.provide('country', {
      code: 'SE',
      locale: 'sv-SE',
      identifier(input) {
        if (input.type === 'local') {
          if (!/^[A-Z0-9-]{3,64}$/.test(input.value))
            throw new Fault(422, 'Reserv-ID must be 3–64 uppercase letters, digits or hyphens');
          return { ...input, system: 'urn:eir:identifier:local' };
        }
        if (
          !['personnummer', 'samordningsnummer'].includes(input.type) ||
          !/^\d{12}$/.test(input.value)
        )
          throw new Fault(422, 'Use an explicit 12-digit Swedish identifier');
        try {
          const parsed = new Personnummer(input.value, {
            allowCoordinationNumber: true,
            allowInterimNumber: false,
          });
          if (parsed.isCoordinationNumber() !== (input.type === 'samordningsnummer'))
            throw new Error();
          return {
            type: input.type,
            value: parsed.format(true),
            system: `http://electronichealth.se/identifier/${input.type}`,
          };
        } catch {
          throw new Fault(422, 'Invalid Swedish identifier, date or checksum');
        }
      },
    });
  },
} satisfies Plugin;
