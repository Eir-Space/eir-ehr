import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Protocol test fixture only: issues signed test identities, never authenticates real staff.
export async function testProvider() {
  const key = await generateKeyPair('RS256'),
    wrongKey = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const control = { claims: {} as Record<string, any>, badSignature: false };
  let issuer = '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, issuer);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/.well-known/openid-configuration')
        return res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + '/authorize',
            token_endpoint: issuer + '/token',
            jwks_uri: issuer + '/jwks',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      if (url.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
      if (url.pathname === '/authorize') {
        if (
          url.searchParams.get('client_id') !== 'eir-test' ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        )
          throw new Error('Invalid client');
        const code = randomUUID();
        codes.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          redirect: url.searchParams.get('redirect_uri')!,
        });
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: redirect.href });
        return res.end();
      }
      if (url.pathname === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        const data = codes.get(body.get('code')!);
        codes.delete(body.get('code')!);
        if (!data) throw new Error('Missing code');
        const credentials = Buffer.from(
          req.headers.authorization?.replace(/^Basic /, '') ?? '',
          'base64',
        )
          .toString()
          .split(':')
          .map((value) => new URLSearchParams('v=' + value).get('v'));
        if (credentials[0] !== 'eir-test' || credentials[1] !== 'test-secret')
          throw new Error('Client authentication mismatch');
        if (data.redirect !== body.get('redirect_uri')) throw new Error('Redirect mismatch');
        if (
          data.challenge !==
          createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url')
        )
          throw new Error('PKCE mismatch');
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({
          iss: issuer,
          aud: 'eir-test',
          sub: 'emma',
          iat: now,
          exp: now + 300,
          auth_time: now,
          nonce: data.nonce,
          acr: 'urn:eir:test:strong',
          ...control.claims,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .sign(control.badSignature ? wrongKey.privateKey : key.privateKey);
        return res.end(
          JSON.stringify({
            access_token: 'unused-test-access-token',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: token,
          }),
        );
      }
      res.writeHead(404);
      res.end('{}');
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer,
    control,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
