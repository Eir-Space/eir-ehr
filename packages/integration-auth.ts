import { timingSafeEqual } from 'node:crypto';
import { assert } from './contracts.ts';

export function connectorSecret(name: string) {
  const token = process.env[name];
  assert(
    token && /^[A-Za-z0-9_-]{43,256}$/.test(token),
    503,
    'Connector credential is missing or invalid',
  );
  return token;
}
export function matchesSecret(authorization: string, expected: string) {
  const actual = Buffer.from(authorization);
  const target = Buffer.from(`Bearer ${expected}`);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
