import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { parseConfigYaml, type JobRecord } from '@autos/contracts';
import { main } from '../../apps/cli/src/index.js';
import { createControllerClient } from '../../apps/cli/src/teams-bot/actions.js';
import { createBotServer } from '../../apps/cli/src/teams-bot/server.js';
import type { Activity, OutgoingMessage } from '../../apps/cli/src/teams-bot/types.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const APP = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const ALLOWED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STRANGER = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const job = (over: Partial<JobRecord> = {}): JobRecord => ({ job_id: JOB, issue_key: 'SAMPLE-12', repository_id: 'example/sample-app', base_sha: 'b'.repeat(40), state: 'QUEUED', dry_run: true, repair_round: 0, created_at: '2026-11-10T12:00:00.000Z', updated_at: '2026-11-10T12:00:00.000Z', ...over });

interface Call { method: string; path: string; body: unknown; actor: string | null }
function harness(routes: (call: Call) => { status: number; body?: unknown } = () => ({ status: 202, body: job() })) {
  const calls: Call[] = []; const replies: Array<{ activity: Activity; message: OutgoingMessage }> = []; const logs: Array<Record<string, unknown>> = [];
  const controller = createControllerClient(new URL('http://127.0.0.1:8787'), 'operator-token-0123456789', async (url, init) => {
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer operator-token-0123456789');
    const call = { method: String(init.method), path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null, actor: headers['x-autos-operator'] ?? null };
    calls.push(call); const result = routes(call);
    return Response.json(result.body ?? {}, { status: result.status });
  });
  const { server, idle } = createBotServer({
    tenantId: TENANT, allowedUsers: [ALLOWED.toUpperCase()],
    parse: { allowedProjects: ['SAMPLE'], jiraSiteUrl: 'https://example.atlassian.net', maxNoteChars: 4000 },
    auth: { verify: async (authorization) => authorization === 'Bearer good' ? { ok: true } : { ok: false, reason: 'bad signature' } },
    connector: { reply: async (activity, message) => { replies.push({ activity, message }); return { ok: true, status: 200 }; } },
    controller, log: (record) => logs.push(record),
  });
  return { server, idle, calls, replies, logs };
}
async function start(h: ReturnType<typeof harness>): Promise<string> {
  await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(h.server.address() as AddressInfo).port}`;
}
let counter = 0;
const activity = (over: Record<string, unknown> = {}) => ({ type: 'message', id: `act-${++counter}`, serviceUrl: SERVICE, channelId: 'msteams', from: { id: '29:user', name: 'Pat', aadObjectId: ALLOWED }, conversation: { id: '19:chan@thread.tacv2', tenantId: TENANT }, recipient: { id: '28:bot' }, ...over });
const post = (base: string, body: unknown, auth = 'Bearer good', type = 'application/json') => fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': type, authorization: auth }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const cardText = (message: OutgoingMessage | undefined) => JSON.stringify(message ?? {});

test('only authenticated POST /api/messages is accepted; bad requests are refused before any work', async () => {
  const h = harness(); const base = await start(h);
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/other`, { method: 'POST' })).status, 404);
    assert.equal((await post(base, activity(), 'Bearer good', 'text/plain')).status, 415);
    assert.equal((await post(base, '{not json')).status, 400);
    assert.equal((await post(base, { type: 'message' })).status, 400);
    assert.equal((await post(base, 'x'.repeat(300 * 1024)).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await post(base, activity({ text: 'status' }), 'Bearer forged')).status, 401);
    await h.idle();
    assert.equal(h.calls.length, 0); assert.equal(h.replies.length, 0);
    assert.ok(h.logs.some((l) => l.event === 'teams_bot_auth_rejected' && l.reason === 'bad signature'));
  } finally { h.server.close(); }
});

test('an allowed user starts a run from a Jira link with role notes; the call is audited as that Teams user', async () => {
  const h = harness(); const base = await start(h);
  try {
    const text = '<at>Autos</at> run https://example.atlassian.net/browse/SAMPLE-12 dry run<br>Only touch the billing module\nqa: check the PDF totals';
    assert.equal((await post(base, activity({ text: text.replace('<br>', '\n') }))).status, 200);
    await h.idle();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], { method: 'POST', path: '/v1/jobs', actor: `teams-${ALLOWED}`, body: { issue_key: 'SAMPLE-12', dry_run: true, notes: [{ instructions: 'Only touch the billing module', roles: ['swe'] }, { instructions: 'check the PDF totals', roles: ['qa'] }] } });
    assert.match(cardText(h.replies[0]!.message), /Dry run queued for SAMPLE-12/);
    // A form submit starts a real run the same way.
    await post(base, activity({ text: undefined, value: { autos: 'v1', action: 'run', issue: 'SAMPLE-12', swe: 'Fix it', dry_run: 'false' } }));
    await h.idle();
    assert.deepEqual(h.calls[1]!.body, { issue_key: 'SAMPLE-12', dry_run: false, notes: [{ instructions: 'Fix it', roles: ['swe'] }] });
  } finally { h.server.close(); }
});

test('strangers, other tenants, other channels and duplicate deliveries do nothing', async () => {
  const h = harness(); const base = await start(h);
  try {
    await post(base, activity({ text: 'run SAMPLE-12', from: { id: '29:x', aadObjectId: STRANGER } }));
    await post(base, activity({ text: 'run SAMPLE-12', conversation: { id: 'c', tenantId: '99999999-9999-9999-9999-999999999999' } }));
    await post(base, activity({ text: 'run SAMPLE-12', channelId: 'webchat' }));
    const once = activity({ text: 'status' });
    await post(base, once); await post(base, once);
    await h.idle();
    assert.deepEqual(h.calls.map((c) => c.path), ['/v1/status'], 'only the first status delivery reaches the controller');
    assert.match(h.replies[0]!.message.text ?? '', /not allowed to use Autos/);
    assert.equal(h.replies.length, 2, 'one refusal + one status reply');
    assert.ok(h.logs.some((l) => l.event === 'teams_bot_duplicate'));
  } finally { h.server.close(); }
});

test('close and cancel need a confirmation click; controller errors and outages come back as short cards', async () => {
  const h = harness((call) => call.path.endsWith('/close') ? { status: 200, body: {} } : call.path.endsWith('/revisions') ? { status: 409, body: { code: 'CONFLICT', message: 'The request conflicts with current state', request_id: 'r' } } : { status: 202, body: job() });
  const base = await start(h);
  try {
    await post(base, activity({ text: 'close SAMPLE-12 merged' })); await h.idle();
    assert.equal(h.calls.length, 0);
    assert.match(cardText(h.replies[0]!.message), /Confirm closing SAMPLE-12 as merged/);
    await post(base, activity({ text: undefined, value: { autos: 'v1', action: 'close', issue: 'SAMPLE-12', resolution: 'merged', confirmed: true } })); await h.idle();
    assert.deepEqual(h.calls[0], { method: 'POST', path: '/v1/issues/SAMPLE-12/close', actor: `teams-${ALLOWED}`, body: { resolution: 'merged' } });
    assert.match(cardText(h.replies[1]!.message), /Closed SAMPLE-12 as merged/);
    await post(base, activity({ text: `cancel ${JOB}` })); await h.idle();
    assert.equal(h.calls.length, 1); assert.match(cardText(h.replies[2]!.message), /Confirm cancelling/);
    await post(base, activity({ text: 'revise SAMPLE-12 also handle empty lists' })); await h.idle();
    assert.match(cardText(h.replies[3]!.message), /Could not revise SAMPLE-12.*conflicts with current state \(CONFLICT\)/);
    await post(base, activity({ text: 'show OTHER-1' })); await h.idle();
    assert.match(cardText(h.replies[4]!.message), /I did not understand that/);
  } finally { h.server.close(); }
  // Controller unreachable.
  const offline = harness(); const controller = createControllerClient(new URL('http://127.0.0.1:1'), 't', async () => { throw new Error('ECONNREFUSED secret-detail'); });
  const { server, idle } = createBotServer({ tenantId: TENANT, allowedUsers: [ALLOWED], parse: { allowedProjects: ['SAMPLE'], jiraSiteUrl: 'https://example.atlassian.net', maxNoteChars: 4000 }, auth: { verify: async () => ({ ok: true }) }, connector: { reply: async (a, m) => { offline.replies.push({ activity: a, message: m }); return { ok: true, status: 200 }; } }, controller, log: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await post(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, activity({ text: 'status' })); await idle();
    assert.match(cardText(offline.replies[0]!.message), /controller is not reachable/);
    assert.doesNotMatch(cardText(offline.replies[0]!.message), /secret-detail/);
  } finally { server.close(); }
});

test('autos teams bot requires teams_bot config and its client secret', async () => {
  const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
  const config = parseConfigYaml(canonical);
  const err: string[] = [];
  const env = { [config.api.operator_token_env]: 'operator-token-0123456789' };
  const dir = new URL('../../config/', import.meta.url).pathname;
  assert.equal(await main(['--config', `${dir}config.example.yaml`, 'teams', 'bot'], { env, stdout: () => undefined, stderr: (l) => err.push(l) }), 1);
  assert.match(err.join('\n'), /teams_bot is not configured/);
  const withBot = parseConfigYaml(`${canonical}\nteams_bot:\n  app_id: ${APP}\n  tenant_id: ${TENANT}\n  client_secret_env: AUTOS_TEAMS_BOT_SECRET\n  allowed_users: [${ALLOWED}]\n`);
  assert.equal(withBot.teams_bot?.port, 3978); assert.equal(withBot.teams_bot?.listen_host, '127.0.0.1');
  assert.throws(() => parseConfigYaml(`${canonical}\nteams_bot:\n  app_id: ${APP}\n  tenant_id: ${TENANT}\n  client_secret_env: AUTOS_TEAMS_BOT_SECRET\n  allowed_users: []\n`));
  assert.throws(() => parseConfigYaml(`${canonical}\nteams_bot:\n  app_id: ${APP}\n  tenant_id: ${TENANT}\n  client_secret_env: AUTOS_TEAMS_BOT_SECRET\n  allowed_users: [${ALLOWED}]\n  listen_host: 0.0.0.0\n`), 'the bot only listens on loopback');
});
