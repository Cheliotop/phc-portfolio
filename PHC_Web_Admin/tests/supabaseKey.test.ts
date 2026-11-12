import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecretKey, jwtPayloadRole } from '../src/domain/supabaseKey.ts';

// Builds an unsigned JWT-shaped key with the given payload (signature is irrelevant to the guard).
const jwt = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature-bytes`;
};

test('a legacy service_role JWT is refused (WEB-19)', () => {
  assert.equal(isSecretKey(jwt({ iss: 'supabase', ref: 'portfolio-project', role: 'service_role', iat: 1 })), true);
});

test('a legacy anon JWT and the new publishable key are accepted', () => {
  assert.equal(isSecretKey(jwt({ iss: 'supabase', ref: 'portfolio-project', role: 'anon', iat: 1 })), false);
  assert.equal(isSecretKey('sb_publishable_REPLACE_WITH_YOUR_PROJECT_KEY'), false);
});

test('the sb_secret_ prefix is still refused', () => {
  assert.equal(isSecretKey('sb_secret_abc123'), true);
});

test('a JWT whose payload does not decode is not taken for a service key', () => {
  assert.equal(jwtPayloadRole('a.%%%.c'), null);
  assert.equal(jwtPayloadRole('not-a-jwt'), null);
  assert.equal(isSecretKey('a.%%%.c'), false);
});
