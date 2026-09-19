import { assert, type Plugin } from '../packages/contracts.ts';
import { connectorSecret } from '../packages/integration-auth.ts';
import {
  canonical,
  orderAcknowledgement,
  payloadHash,
  protocol,
  type LabConnector,
  type LabTransport,
} from '../packages/integrations.ts';

export const httpLabTransport: LabTransport = {
  protocol,
  validate(connector: LabConnector) {
    assert(
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
      422,
      'TLS certificate verification must remain enabled',
    );
    const url = new URL(connector.endpoint);
    assert(
      !url.username && !url.password && !url.hash && !url.search,
      422,
      'Connector endpoint cannot contain credentials, fragments or query strings',
    );
    if (connector.localDevelopmentOnly)
      assert(
        ['127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:',
        422,
        'Test connectors require explicit loopback HTTP',
      );
    else assert(url.protocol === 'https:', 422, 'Connector endpoint requires HTTPS');
    connectorSecret(connector.outboundTokenEnv);
    connectorSecret(connector.inboundTokenEnv);
    assert(
      connectorSecret(connector.outboundTokenEnv) !== connectorSecret(connector.inboundTokenEnv),
      422,
      'Each connector direction requires a distinct credential',
    );
  },
  async send(connector, message, signal) {
    try {
      const response = await fetch(connector.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          authorization: `Bearer ${connectorSecret(connector.outboundTokenEnv)}`,
          'content-type': 'application/json',
          'idempotency-key': message.messageId,
          'x-eir-payload-sha256': payloadHash(message),
        },
        body: canonical(message),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          kind: response.status === 429 || response.status >= 500 ? 'retry' : 'quarantine',
          code: `http_${response.status}`,
        };
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel();
        return { kind: 'quarantine', code: 'invalid_acknowledgement' };
      }
      // A laboratory response must never become an unbounded allocation or a UI/log message.
      const reader = response.body?.getReader();
      if (!reader) return { kind: 'quarantine', code: 'invalid_acknowledgement' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) {
          await reader.cancel();
          return { kind: 'quarantine', code: 'invalid_acknowledgement' };
        }
        chunks.push(value);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return { kind: 'quarantine', code: 'invalid_acknowledgement' };
      }
      const parsed = orderAcknowledgement.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.messageId !== message.messageId ||
        parsed.data.orderId !== message.orderId ||
        parsed.data.patientId !== message.patientId ||
        parsed.data.payloadHash !== payloadHash(message)
      )
        return { kind: 'quarantine', code: 'invalid_acknowledgement' };
      return { kind: 'acknowledged', acknowledgement: parsed.data };
    } catch {
      return { kind: 'retry', code: signal.aborted ? 'delivery_timeout' : 'delivery_unconfirmed' };
    }
  },
};
export default {
  id: 'eir.lab-transport.http',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['labTransport'],
  requires: [],
  setup(ctx) {
    ctx.provide('labTransport', httpLabTransport);
  },
} satisfies Plugin;
