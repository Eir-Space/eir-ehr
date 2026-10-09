import { z } from 'zod';
import type { AIProvider, NetworkReach, Plugin } from '../packages/contracts.ts';
const rank: Record<NetworkReach, number> = { none: 0, loopback: 1, allowlist: 2, any: 3 };
// Presents one `aiProvider` to ai-review and tries the configured chain of registered models in
// order. A model whose declared reach exceeds `maxNetwork` is never called, so a fallback cannot
// silently send clinical text somewhere the operator did not allow. Output validation and review
// stay in ai-review; the router only chooses who answers.
export default {
  id: 'eir.ai.router',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['aiProvider'],
  requires: [],
  setup(ctx, config) {
    const options = z
      .object({
        chain: z.array(z.string().min(1)).min(1),
        maxNetwork: z.enum(['none', 'loopback', 'allowlist', 'any']).default('loopback'),
        timeoutMs: z.number().int().min(1000).max(120000).default(45000),
        trace: z.boolean().default(false),
      })
      .strict()
      .parse(config);
    const router: AIProvider = {
      id: `router:${options.chain.join('>')}`,
      async generate(evidence) {
        const models = ctx.contributions('aiModel');
        const failures: string[] = [];
        for (const key of options.chain) {
          const model = models.get(key);
          const started = Date.now();
          const note = (outcome: string) => {
            if (options.trace)
              console.error(`[ai-router] ${key}: ${outcome} (${Date.now() - started} ms)`);
          };
          if (!model) {
            failures.push(`${key}: not registered`);
            note('not registered');
            continue;
          }
          if (!model.meta || rank[model.meta.network] > rank[options.maxNetwork]) {
            failures.push(`${key}: blocked by maxNetwork ${options.maxNetwork}`);
            note('blocked by network policy');
            continue;
          }
          let timer: NodeJS.Timeout | undefined;
          try {
            const result = await Promise.race([
              model.generate(structuredClone(evidence)),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
                  options.timeoutMs,
                );
              }),
            ]);
            note('ok');
            return result;
          } catch (error) {
            // Error text can echo model output, which may contain clinical text: keep only the type.
            failures.push(`${key}: ${error instanceof Error ? error.name : 'failed'}`);
            note('failed');
          } finally {
            clearTimeout(timer);
          }
        }
        throw new Error(`No AI model answered (${failures.join('; ')})`);
      },
    };
    ctx.provide('aiProvider', router);
  },
} satisfies Plugin;
