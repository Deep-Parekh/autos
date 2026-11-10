import assert from 'node:assert/strict';
import test from 'node:test';
import { AutosError } from '@autos/contracts';
import { ConnectorClient, conversationRef, parseServiceUrl } from '../../apps/cli/src/teams-bot/connector.js';
import type { Activity, ConversationRef } from '../../apps/cli/src/teams-bot/types.js';

const TOKEN = 'private-connector-token';
const ref: ConversationRef = { serviceUrl: 'https://smba.trafficmanager.net/amer/', conversationId: 'conv /?&', tenantId: 'tenant' };
const activity: Activity = {
  type: 'message', id: 'activity /?&', serviceUrl: 'https://smba.trafficmanager.net/amer', channelId: 'msteams',
  from: { id: 'user' }, conversation: { id: 'conv /?&', tenantId: 'tenant' },
};
const tokens = (onInvalidate: () => void = () => undefined) => {
  let issued = 0;
  return {
    source: {
      token: async (_signal?: AbortSignal) => `token-${++issued}`,
      invalidate: onInvalidate,
    },
    issued: () => issued,
  };
};

test('service URL allowlist accepts documented Teams hosts and rejects unsafe destinations without echoing input', () => {
  for (const value of [
    'https://smba.trafficmanager.net/amer',
    'https://api.botframework.com',
    'https://emea.teams.microsoft.com',
    'https://api.teams.microsoft.us',
  ]) assert.equal(parseServiceUrl(value).protocol, 'https:');

  for (const value of [
    'http://smba.trafficmanager.net',
    'https://user:secret@smba.trafficmanager.net',
    'https://smba.trafficmanager.net/?sig=secret',
    'https://smba.trafficmanager.net/#secret',
    'https://smba.trafficmanager.net.evil.example',
    'https://evil.example/path?token=secret',
    'not a url with secret',
  ]) {
    assert.throws(() => parseServiceUrl(value), (error: unknown) => {
      assert.ok(error instanceof AutosError);
      assert.equal(error.code, 'POLICY');
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('conversationRef validates service URL and prefers conversation tenant id', () => {
  assert.deepEqual(conversationRef(activity), { serviceUrl: 'https://smba.trafficmanager.net/amer', conversationId: 'conv /?&', tenantId: 'tenant' });
  const channelTenant = { ...activity, conversation: { id: 'c' }, channelData: { tenant: { id: 'channel-tenant' } } };
  assert.equal(conversationRef(channelTenant).tenantId, 'channel-tenant');
  assert.throws(() => conversationRef({ ...activity, serviceUrl: 'https://evil.example' }), AutosError);
});

test('reply, send and update build encoded Bot Connector endpoints and message bodies', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const auth = tokens();
  const client = new ConnectorClient({ tokens: auth.source, retryDelayMs: 0, fetch: async (url, init) => {
    calls.push({ url: url.toString(), init });
    return init.method === 'POST' && calls.length === 2 ? Response.json({ id: 'new-activity' }, { status: 200 }) : new Response(null, { status: 200 });
  } });
  const card = { type: 'AdaptiveCard', version: '1.4' };
  assert.deepEqual(await client.reply(activity, { text: 'hello' }), { ok: true, status: 200 });
  assert.deepEqual(await client.send(ref, { text: 'from Autos', card }), { ok: true, status: 200, activityId: 'new-activity' });
  assert.deepEqual(await client.update(ref, 'update /?&', { card }), { ok: true, status: 200 });

  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
    ['https://smba.trafficmanager.net/amer/v3/conversations/conv%20%2F%3F%26/activities/activity%20%2F%3F%26', 'POST'],
    ['https://smba.trafficmanager.net/amer/v3/conversations/conv%20%2F%3F%26/activities', 'POST'],
    ['https://smba.trafficmanager.net/amer/v3/conversations/conv%20%2F%3F%26/activities/update%20%2F%3F%26', 'PUT'],
  ]);
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    type: 'message', text: 'from Autos', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  });
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer token-1');
});

test('401 invalidates and retries once with a fresh token without counting against transient attempts', async () => {
  const sent: string[] = []; let invalidated = 0;
  const auth = tokens(() => { invalidated++; });
  const client = new ConnectorClient({ tokens: auth.source, retryDelayMs: 0, fetch: async (_url, init) => {
    sent.push((init.headers as Record<string, string>).authorization!);
    return new Response(null, { status: sent.length === 1 ? 401 : 202 });
  } });
  assert.deepEqual(await client.send(ref, {}), { ok: true, status: 202 });
  assert.deepEqual(sent, ['Bearer token-1', 'Bearer token-2']);
  assert.equal(invalidated, 1);
  assert.equal(auth.issued(), 2);

  let calls = 0;
  const noSecondRefresh = new ConnectorClient({ tokens: auth.source, retryDelayMs: 0, fetch: async () => { calls++; return new Response(null, { status: 401 }); } });
  assert.deepEqual(await noSecondRefresh.reply(activity, { text: 'x' }), { ok: false, status: 401 });
  assert.equal(calls, 2, 'one initial request and one refreshed request');
});

test('retries 429, 5xx and network errors at most three times, honoring capped Retry-After', async () => {
  const statuses = [429, 503, 200]; let count = 0; const waits: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    waits.push(ms ?? 0); callback(...args); return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const client = new ConnectorClient({ tokens: tokens().source, retryDelayMs: 1, fetch: async () => {
      const status = statuses[count++]!;
      return new Response(null, { status, headers: count === 1 ? { 'retry-after': '45' } : {} });
    } });
    assert.deepEqual(await client.send(ref, {}), { ok: true, status: 200 });
    assert.equal(count, 3);
    assert.deepEqual(waits, [30_000, 2]);
  } finally { globalThis.setTimeout = originalSetTimeout; }

  let networkCalls = 0;
  const network = new ConnectorClient({ tokens: tokens().source, retryDelayMs: 0, fetch: async () => { networkCalls++; throw new TypeError(`failure ${TOKEN}`); } });
  assert.deepEqual(await network.send(ref, {}), { ok: false, status: null });
  assert.equal(networkCalls, 3);
});

test('other HTTP failures stop immediately and neither results nor thrown errors expose tokens or upstream bodies', async () => {
  let count = 0;
  const client = new ConnectorClient({ tokens: { token: async () => TOKEN, invalidate: () => undefined }, fetch: async () => {
    count++;
    return new Response(`body ${TOKEN}`, { status: 403 });
  } });
  const result = await client.send(ref, {});
  assert.deepEqual(result, { ok: false, status: 403 });
  assert.equal(count, 1);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});
