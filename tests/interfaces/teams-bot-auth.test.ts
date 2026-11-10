import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { test } from 'node:test';
import { createBotAuthenticator } from '../../apps/cli/src/teams-bot/auth.js';
import type { Activity } from '../../apps/cli/src/teams-bot/types.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const APP = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const SERVICE = 'https://smba.trafficmanager.net/amer/';
const activity = { type: 'message', serviceUrl: SERVICE, channelId: 'msteams', from: { id: 'user' }, conversation: { id: 'conversation' } } as Activity;
const issuers = [
  { issuer: 'https://api.botframework.com', metadata: 'https://login.botframework.com/v1/.well-known/openidconfiguration', jwksHost: 'login.botframework.com' },
  { issuer: `https://sts.windows.net/${TENANT}/`, metadata: `https://login.microsoftonline.com/${TENANT}/.well-known/openid-configuration`, jwksHost: 'login.microsoftonline.com' },
  { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, metadata: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`, jwksHost: 'login.microsoftonline.com' },
];

async function key(kid: string) {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  return { ...pair, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } };
}

async function token(privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'], issuer: string, claims: Record<string, unknown> = {}, kid = 'key-1') {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).setIssuer(issuer).setAudience(APP).setIssuedAt().setExpirationTime('1h').sign(privateKey);
}

function fixture(issuerSpec: typeof issuers[number], jwks: () => unknown) {
  const requests: URL[] = [];
  const fetch = async (url: URL, init: RequestInit) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url.toString() === issuerSpec.metadata) return Response.json({ issuer: issuerSpec.issuer, jwks_uri: `https://${issuerSpec.jwksHost}/keys` });
    if (url.toString() === `https://${issuerSpec.jwksHost}/keys`) return Response.json(jwks());
    throw new Error('unexpected fake request');
  };
  return { requests, fetch };
}

test('accepts Bot Framework and both single-tenant Entra issuers', async () => {
  for (const spec of issuers) {
    const signingKey = await key(`key-${issuers.indexOf(spec)}`);
    const signed = await token(signingKey.privateKey, spec.issuer, { serviceUrl: SERVICE }, `key-${issuers.indexOf(spec)}`);
    const fake = fixture(spec, () => ({ keys: [signingKey.jwk] }));
    const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fake.fetch });
    assert.deepEqual(await auth.verify(`Bearer ${signed}`, activity), { ok: true });
    assert.deepEqual(fake.requests.map((url) => url.toString()), [spec.metadata, `https://${spec.jwksHost}/keys`]);
  }
});

test('rejects wrong audience, wrong issuer, expired token, and invalid signature with fixed reasons', async () => {
  const spec = issuers[0]!; const signingKey = await key('key-1');
  const fake = fixture(spec, () => ({ keys: [signingKey.jwk] }));
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fake.fetch });
  const wrongAudience = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(spec.issuer).setAudience('other-app').setExpirationTime('1h').sign(signingKey.privateKey);
  const wrongIssuer = await token(signingKey.privateKey, 'https://attacker.example', {}, 'key-1');
  // jose accepts NumericDate seconds or duration strings here; use an epoch
  // timestamp so the fixture is a valid, already expired JWT.
  const expired = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(spec.issuer).setAudience(APP).setExpirationTime(1).sign(signingKey.privateKey);
  const unknownKey = await token((await key('other')).privateKey, spec.issuer, {}, 'missing-key');
  assert.deepEqual(await auth.verify(`Bearer ${wrongAudience}`, activity), { ok: false, reason: 'wrong audience' });
  assert.deepEqual(await auth.verify(`Bearer ${wrongIssuer}`, activity), { ok: false, reason: 'wrong issuer' });
  assert.deepEqual(await auth.verify(`Bearer ${expired}`, activity), { ok: false, reason: 'expired' });
  assert.deepEqual(await auth.verify(`Bearer ${unknownKey}`, activity), { ok: false, reason: 'bad signature' });
});

test('rejects a serviceUrl claim that differs from the activity', async () => {
  const spec = issuers[0]!; const signingKey = await key('key-1');
  const signed = await token(signingKey.privateKey, spec.issuer, { serviceUrl: 'https://different.example/' });
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fixture(spec, () => ({ keys: [signingKey.jwk] })).fetch });
  assert.deepEqual(await auth.verify(`Bearer ${signed}`, activity), { ok: false, reason: 'service url mismatch' });
});

test('rejects missing and non-Bearer authorization without fetching metadata', async () => {
  const spec = issuers[0]!; const fake = fixture(spec, () => ({ keys: [] }));
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fake.fetch });
  assert.deepEqual(await auth.verify(undefined, activity), { ok: false, reason: 'missing token' });
  assert.deepEqual(await auth.verify('Basic abc', activity), { ok: false, reason: 'missing token' });
  assert.equal(fake.requests.length, 0);
});

test('caches metadata and keys across verifications', async () => {
  const spec = issuers[0]!; const signingKey = await key('key-1');
  const signed = await token(signingKey.privateKey, spec.issuer, { serviceurl: SERVICE }, 'key-1');
  const fake = fixture(spec, () => ({ keys: [signingKey.jwk] }));
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fake.fetch });
  for (let i = 0; i < 5; i++) assert.deepEqual(await auth.verify(`Bearer ${signed}`, activity), { ok: true });
  assert.equal(fake.requests.length, 2);
});

test('refreshes once for an unknown kid, then throttles further unknown-key refreshes', async () => {
  const spec = issuers[0]!; const initialKey = await key('key-1'); const replacement = await key('key-2'); const other = await key('key-3');
  let keyDocument = { keys: [initialKey.jwk] }; let now = 1_000_000;
  const fake = fixture(spec, () => keyDocument);
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: fake.fetch, now: () => now });
  const initial = await token(initialKey.privateKey, spec.issuer, { serviceurl: SERVICE }, 'key-1');
  assert.deepEqual(await auth.verify(`Bearer ${initial}`, activity), { ok: true });
  keyDocument = { keys: [replacement.jwk] };
  const newlyKeyed = await token(replacement.privateKey, spec.issuer, { serviceurl: SERVICE }, 'key-2');
  assert.deepEqual(await auth.verify(`Bearer ${newlyKeyed}`, activity), { ok: true });
  assert.equal(fake.requests.length, 4, 'unknown kid caused one metadata/JWKS refresh');
  const stillUnknown = await token(other.privateKey, spec.issuer, { serviceurl: SERVICE }, 'key-3');
  assert.deepEqual(await auth.verify(`Bearer ${stillUnknown}`, activity), { ok: false, reason: 'bad signature' });
  assert.equal(fake.requests.length, 4, 'additional unknown kid refresh was throttled');
  now += 5 * 60 * 1000;
  keyDocument = { keys: [other.jwk] };
  assert.deepEqual(await auth.verify(`Bearer ${stillUnknown}`, activity), { ok: true });
  assert.equal(fake.requests.length, 6, 'refresh resumes after five minutes');
});

test('metadata failures return a fixed reason without exposing upstream details', async () => {
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT, fetch: async () => { throw new Error('secret response https://user:pass@example.test'); } });
  const signed = await token((await key('key-1')).privateKey, issuers[0]!.issuer);
  assert.deepEqual(await auth.verify(`Bearer ${signed}`, activity), { ok: false, reason: 'metadata unavailable' });
});

test('requires the service URL claim (an app-only token for the bot audience is not enough); tenant ID case does not matter', async () => {
  const signingKey = await key('key-1'); const spec = issuers[1]!; const fake = fixture(spec, () => ({ keys: [signingKey.jwk] }));
  const auth = createBotAuthenticator({ appId: APP, tenantId: TENANT.toUpperCase(), fetch: fake.fetch });
  assert.deepEqual(await auth.verify(`Bearer ${await token(signingKey.privateKey, spec.issuer, {}, 'key-1')}`, activity), { ok: false, reason: 'service url missing' });
  assert.deepEqual(await auth.verify(`Bearer ${await token(signingKey.privateKey, spec.issuer, { serviceurl: SERVICE }, 'key-1')}`, activity), { ok: true });
});
