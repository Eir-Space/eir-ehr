import { Fault, type Plugin } from '../packages/contracts.ts';
export default {
  id: 'eir.country.eu-local',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['country'],
  requires: [],
  setup(ctx, config) {
    const code = String(config.code ?? 'EE');
    const locale = String(config.locale ?? 'en-GB');
    if (!/^[A-Z]{2}$/.test(code)) throw new Error('Two-letter country code required');
    ctx.provide('country', {
      code,
      locale,
      identifier(input) {
        if (input.type !== 'local' || !/^[A-Z0-9-]{3,64}$/.test(input.value))
          throw new Fault(422, 'This country pack accepts institution-local identifiers only');
        return { ...input, system: 'urn:eir:identifier:local' };
      },
    });
  },
} satisfies Plugin;
