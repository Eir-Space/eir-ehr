import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';
import { connectorSecret } from '../packages/integration-auth.ts';
import { payloadHash } from '../packages/integrations.ts';
import { notificationMessage } from '../packages/follow-up.ts';

export default {
  id: 'eir.notifications.http',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['notificationTransport'],
  requires: [],
  setup(ctx, config) {
    const settings = z
      .object({
        endpoint: z.url().optional(),
        tokenEnv: z.string().optional(),
        localDevelopmentOnly: z.boolean().default(false),
        timeoutMs: z.number().int().min(100).max(10000).default(5000),
      })
      .strict()
      .parse(config);
    if (settings.endpoint) {
      const url = new URL(settings.endpoint);
      assert(
        !url.username && !url.password && !url.search && !url.hash,
        422,
        'Unsafe notification URL',
      );
      assert(
        url.protocol === 'https:' ||
          (settings.localDevelopmentOnly &&
            url.protocol === 'http:' &&
            ['127.0.0.1', '[::1]'].includes(url.hostname)),
        422,
        'Notification transport requires HTTPS',
      );
      assert(
        settings.tokenEnv && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
        422,
        'Notification transport requires a credential and verified TLS',
      );
      connectorSecret(settings.tokenEnv);
    }
    ctx.provide('notificationTransport', {
      destination: payloadHash({ endpoint: settings.endpoint ?? null }),
      async send(input) {
        assert(
          settings.endpoint && settings.tokenEnv,
          503,
          'Notification transport not configured',
        );
        const message = notificationMessage.parse(input);
        const hash = payloadHash(message);
        const response = await fetch(settings.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(settings.timeoutMs),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${connectorSecret(settings.tokenEnv)}`,
            'Idempotency-Key': message.messageId,
            'X-Eir-Payload-Sha256': hash,
          },
          body: JSON.stringify(message),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Notification delivery unconfirmed');
        }
        const reader = response.body?.getReader();
        assert(reader, 502, 'Notification acknowledgement missing');
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            assert(length <= 2048, 502, 'Notification acknowledgement too large');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const ack = z
          .object({ messageId: z.uuid(), payloadHash: z.string(), status: z.literal('accepted') })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        assert(
          ack.messageId === message.messageId && ack.payloadHash === hash,
          502,
          'Notification acknowledgement mismatch',
        );
      },
    });
  },
} satisfies Plugin;
