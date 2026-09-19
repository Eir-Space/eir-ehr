import { z } from 'zod';
import * as oidc from 'openid-client';
import { assert, Fault, type Plugin } from '../packages/contracts.ts';
import { staffSessions, tokenHash } from '../packages/staff-sessions.ts';

const loopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
export default {
  id: 'eir.identity.oidc',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['identity'],
  requires: ['store', 'workforce'],
  async setup(ctx, config) {
    const settings = z
      .object({
        issuer: z.url(),
        clientId: z.string().min(1),
        clientSecretEnv: z.string().min(1),
        origin: z.url(),
        requiredAcr: z.array(z.string().min(1)).min(1),
        localTestOnly: z.boolean().default(false),
        idleMinutes: z.number().int().min(1).max(30).default(15),
        absoluteHours: z.number().int().min(1).max(8).default(8),
      })
      .strict()
      .parse(config);
    const issuer = new URL(settings.issuer),
      origin = new URL(settings.origin);
    assert(
      origin.href === origin.origin + '/',
      422,
      'Origin must not contain a path, credentials, query or fragment',
    );
    const secure = (u: URL) =>
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' ||
        (settings.localTestOnly && loopback(u) && u.protocol === 'http:'));
    assert(
      secure(issuer) && secure(origin) && !issuer.search && !issuer.hash,
      422,
      'HTTPS identity issuer and application origin required',
    );
    const secret = process.env[settings.clientSecretEnv];
    assert(secret, 500, 'OIDC client secret environment variable is missing');
    const execute = [
      oidc.enableNonRepudiationChecks,
      ...(settings.localTestOnly ? [oidc.allowInsecureRequests] : []),
    ];
    const client = await oidc.discovery(
      issuer,
      settings.clientId,
      { id_token_signed_response_alg: 'RS256' },
      oidc.ClientSecretBasic(secret),
      { execute, timeout: 10 },
    );
    const metadata = client.serverMetadata();
    assert(metadata.issuer === settings.issuer, 422, 'Identity issuer mismatch');
    assert(
      metadata.code_challenge_methods_supported?.includes('S256'),
      422,
      'Identity provider must advertise S256 PKCE',
    );
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ])
      assert(endpoint && secure(new URL(endpoint)), 422, 'Unsafe identity endpoint');
    const store = ctx.get('store'),
      workforce = ctx.get('workforce');
    const sessions = staffSessions(store, workforce, settings);
    const redirect = new URL('/auth/callback', origin).href;
    ctx.provide('identity', {
      authenticate: sessions.authenticate,
      select: sessions.select,
      revoke: sessions.revoke,
      // There is intentionally no public issue() capability on the federated adapter.
      browser: {
        origin: origin.origin,
        async begin() {
          const state = oidc.randomState(),
            nonce = oidc.randomNonce(),
            binding = oidc.randomState(),
            verifier = oidc.randomPKCECodeVerifier();
          store.saveLogin(
            tokenHash(binding),
            { state, nonce, verifier },
            new Date(Date.now() + 5 * 60000).toISOString(),
          );
          const url = oidc.buildAuthorizationUrl(client, {
            redirect_uri: redirect,
            response_type: 'code',
            scope: 'openid',
            state,
            nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256',
            acr_values: settings.requiredAcr.join(' '),
            max_age: '0',
            prompt: 'login',
          });
          return { url: url.href, binding };
        },
        async callback(url, binding) {
          assert(
            url.origin === origin.origin &&
              url.pathname === '/auth/callback' &&
              /^[A-Za-z0-9_-]{43}$/.test(binding),
            401,
            'Invalid authentication response',
          );
          const transaction = store.consumeLogin(tokenHash(binding));
          assert(transaction, 401, 'Authentication request expired or already used');
          try {
            const tokens = await oidc.authorizationCodeGrant(client, url, {
              expectedState: transaction.state,
              expectedNonce: transaction.nonce,
              pkceCodeVerifier: transaction.verifier,
              maxAge: 60,
              idTokenExpected: true,
            });
            const claims = tokens.claims();
            assert(
              claims &&
                typeof claims.sub === 'string' &&
                typeof claims.acr === 'string' &&
                settings.requiredAcr.includes(claims.acr) &&
                typeof claims.auth_time === 'number' &&
                claims.auth_time <= Math.floor(Date.now() / 1000) + 30,
              401,
              'Required authentication assurance was not met',
            );
            const assignments = workforce.forIdentity(settings.issuer, claims.sub);
            assert(assignments.length, 403, 'No provisioned active staff assignment');
            const actor = workforce.actor(assignments[0], {
              method: 'oidc',
              issuer: settings.issuer,
              subject: claims.sub,
              acr: claims.acr,
              authenticatedAt: claims.auth_time,
            });
            return sessions.issue!(actor);
          } catch (cause) {
            throw Object.assign(
              new Fault(401, 'Authentication failed or staff assignment unavailable'),
              { cause },
            );
          }
        },
      },
    });
  },
} satisfies Plugin;
