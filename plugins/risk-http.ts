import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';
import { connectorSecret } from '../packages/integration-auth.ts';
import { digest, riskOutput } from '../packages/deterioration.ts';

export default {
  id: 'eir.risk.http',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['riskEngine'],
  requires: [],
  setup(ctx, config) {
    const settings = z
      .object({
        endpoint: z.url(),
        tokenEnv: z.string().min(1),
        modelId: z.string().min(1),
        modelVersion: z.string().min(1),
        label: z.string().min(1),
        intendedUse: z.string().min(1),
        localDevelopmentOnly: z.boolean().default(false),
        timeoutMs: z.number().int().min(100).max(10000).default(5000),
      })
      .strict()
      .parse(config);
    const url = new URL(settings.endpoint);
    assert(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (settings.localDevelopmentOnly &&
            url.protocol === 'http:' &&
            ['127.0.0.1', '[::1]'].includes(url.hostname))),
      422,
      'Risk endpoint requires HTTPS',
    );
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 422, 'Verified TLS required');
    connectorSecret(settings.tokenEnv);
    ctx.provide('riskEngine', {
      id: settings.modelId,
      version: settings.modelVersion,
      label: settings.label,
      intendedUse: settings.intendedUse,
      async evaluate(input) {
        const inputHash = digest(input);
        const response = await fetch(settings.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(settings.timeoutMs),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${connectorSecret(settings.tokenEnv)}`,
          },
          body: JSON.stringify({
            modelId: settings.modelId,
            modelVersion: settings.modelVersion,
            inputHash,
            input,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Risk service unavailable');
        }
        const reader = response.body?.getReader();
        assert(reader, 502, 'Risk response missing');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            assert(bytes <= 65536, 502, 'Risk response exceeds limit');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const result = z
          .object({
            modelId: z.string(),
            modelVersion: z.string(),
            inputHash: z.string(),
            output: riskOutput,
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        assert(
          result.inputHash === inputHash &&
            result.modelId === settings.modelId &&
            result.modelVersion === settings.modelVersion,
          502,
          'Risk response does not match requested model and input',
        );
        return result.output;
      },
    });
  },
} satisfies Plugin;
