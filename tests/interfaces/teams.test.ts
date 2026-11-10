import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseConfigYaml, type JobRecord, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { main } from '../../apps/cli/src/index.js';
import { buildTeamsMessage, EntraTokenSource, notificationKind, parseTeamsWebhookUrl, postTeamsMessage, TierTracker } from '../../apps/cli/src/teams.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const withTeams = (notify = '') => `${canonical}\nnotifications:\n  teams:\n    webhook_url_env: AUTOS_TEAMS_WEBHOOK_URL\n${notify}`;
const config = parseConfigYaml(withTeams());
const TOKEN = 'teams-relay-token-0123456789';
const WEBHOOK = 'https://prod-01.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRET-SIGNATURE';
const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ready: JobRecord = { job_id: JOB_ID, issue_key: 'SAMPLE-1', repository_id: 'example/sample-app', base_sha: 'b'.repeat(40), state: 'READY_FOR_HUMAN', dry_run: false, repair_round: 1, created_at: '2026-11-07T12:00:00.000Z', updated_at: '2026-11-07T12:30:00.000Z', base_branch: 'develop', feature_branch: 'deep/SAMPLE-1', commit_sha: 'c'.repeat(40) };
type Card = { attachments: Array<{ contentType: string; content: { body: Array<{ type: string; text?: string; facts?: Array<{ title: string; value: string }> }>; actions: Array<{ url: string }> } }> };
const cardText = (payload: unknown) => JSON.stringify(payload);
const facts = (payload: unknown) => Object.fromEntries((payload as Card).attachments[0]!.content.body.flatMap((b) => b.facts ?? []).map((f) => [f.title, f.value]));

test('webhook URL must be a credential-free https Teams Workflows URL; errors never echo it', () => {
  assert.equal(parseTeamsWebhookUrl(WEBHOOK, 'X').hostname, 'prod-01.westus.logic.azure.com');
  assert.ok(parseTeamsWebhookUrl('https://default1234.08.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=s', 'X'));
  for (const bad of ['http://prod-01.westus.logic.azure.com/x?sig=SECRET', 'https://evil.example.com/x?sig=SECRET', 'https://u:p@prod-01.westus.logic.azure.com/x?sig=SECRET', 'https://logic.azure.com.evil.com/x?sig=SECRET', 'not a url SECRET', '']) {
    assert.throws(() => parseTeamsWebhookUrl(bad, 'AUTOS_TEAMS_WEBHOOK_URL'), (error: Error) => !error.message.includes('SECRET') && /AUTOS_TEAMS_WEBHOOK_URL/.test(error.message), bad);
  }
});

test('cards carry Autos facts, tier, next-step commands and a Jira link, and nothing from the ticket', () => {
  const tiers = new TierTracker();
  tiers.observe(makeEvent(1, { type: 'tier_selected', role: 'swe', tier: 'sm' }));
  tiers.observe(makeEvent(2, { type: 'tier_escalated', role: 'swe', tier: 'med' }));
  const event = makeEvent(3, { type: 'job_finished', state: 'READY_FOR_HUMAN', role: undefined, provider: undefined } as never);
  assert.equal(notificationKind(event), 'READY_FOR_HUMAN');
  const payload = buildTeamsMessage(event, 'READY_FOR_HUMAN', { job: ready, tier: tiers.get(JOB_ID) }, config);
  const card = (payload as Card).attachments[0]!;
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.match(card.content.body[0]!.text!, /SAMPLE-1 is ready for review/);
  assert.deepEqual([facts(payload).Branch, facts(payload).Commit, facts(payload)['SWE tier'], facts(payload)['Repair rounds']], ['deep/SAMPLE-1', 'cccccccccccc', 'sm → med (1 escalation)', '1']);
  assert.match(cardText(payload), /autos close SAMPLE-1 --merged/); assert.match(cardText(payload), /autos revise SAMPLE-1 --note/);
  assert.equal(card.content.actions[0]!.url, 'https://example.atlassian.net/browse/SAMPLE-1');
  const blocked = buildTeamsMessage(makeEvent(4, { type: 'job_finished', state: 'BLOCKED', code: 'CHECK_FAILED' }), 'BLOCKED', { job: { ...ready, state: 'BLOCKED', blocked_code: 'CHECK_FAILED', blocked_reason: 'Required evidence failed: [CHECKS](http://x) *bold*' } }, config);
  assert.match((blocked as Card).attachments[0]!.content.body[0]!.text!, /blocked \(CHECK_FAILED\)/);
  assert.equal(facts(blocked).Reason, 'Required evidence failed: CHECKS (http://x) bold', 'markdown links/emphasis are neutralized');
  assert.match(cardText(blocked), new RegExp(`autos retry ${JOB_ID}`));
  const quiet = buildTeamsMessage(event, 'READY_FOR_HUMAN', { job: ready }, parseConfigYaml(withTeams('    include_commands: false\n')));
  assert.doesNotMatch(cardText(quiet), /autos close/);
  const paused = buildTeamsMessage(makeEvent(5, { type: 'job_paused', role: 'swe', code: 'RATE_LIMIT', resume_at: '2026-11-07T13:00:00.000Z' }), 'PAUSED', {}, config);
  assert.deepEqual([facts(paused).Code, facts(paused).Resumes], ['RATE_LIMIT', '2026-11-07T13:00:00.000Z']);
  assert.equal(notificationKind(makeEvent(6, { type: 'role_started' })), null);
  assert.equal(notificationKind(makeEvent(7, { type: 'job_finished', state: 'QA' })), null);
});

test('delivery retries 429/5xx and network errors (honouring Retry-After), never retries other 4xx, refuses redirects', async () => {
  const statuses = [503, 429, 202]; const inits: RequestInit[] = [];
  const fake = async (_url: URL, init: RequestInit) => { inits.push(init); const status = statuses.shift()!; return new Response(null, { status, headers: status === 429 ? { 'retry-after': '0' } : {} }); };
  assert.deepEqual(await postTeamsMessage(new URL(WEBHOOK), { a: 1 }, { fetch: fake, retryDelayMs: 1 }), { ok: true, status: 202 });
  assert.equal(inits.length, 3); assert.equal(inits[0]!.redirect, 'error'); assert.equal(inits[0]!.method, 'POST');
  let calls = 0;
  assert.deepEqual(await postTeamsMessage(new URL(WEBHOOK), {}, { fetch: async () => { calls++; return new Response(null, { status: 400 }); }, retryDelayMs: 1 }), { ok: false, status: 400 });
  assert.equal(calls, 1);
  calls = 0;
  assert.deepEqual(await postTeamsMessage(new URL(WEBHOOK), {}, { fetch: async () => { calls++; throw new TypeError('fetch failed'); }, retryDelayMs: 1, attempts: 3 }), { ok: false, status: null });
  assert.equal(calls, 3);
});

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test('autos teams relay starts at "now", posts configured kinds with job facts, survives restarts without re-posting', async () => {
  // Three events happened before the relay was first started: they are history, not notifications.
  const monitor = monitorPort([makeEvent(1, { type: 'job_finished', state: 'BLOCKED' }), makeEvent(2), makeEvent(3)]);
  monitor.activityValue = { ...monitor.activityValue, last_event_id: 3 };
  const workflow: WorkflowServicePort = { submit: async () => ready, execute: async () => ready, cancel: async () => ready, revise: async () => ready, retry: async () => ready, get: async (id) => id === JOB_ID ? ready : null, list: async () => [ready], poll: async () => undefined, ...monitor } as WorkflowServicePort;
  const options: ControllerOptions = { config, workflow, operatorToken: TOKEN, sseHeartbeatMs: 40, runnerHealthTimeoutMs: 100,
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined };
  const app = await createController(options); const base = await listen(app);
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-')); const stops: AbortController[] = [];
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, withTeams('    notify: [READY_FOR_HUMAN, BLOCKED, TIER_ESCALATED]\n'));
    const env = { [config.api.operator_token_env]: TOKEN, AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK };
    const posted: unknown[] = []; const urls: string[] = [];
    const teamsFetch = async (url: URL, init: RequestInit) => { urls.push(url.toString()); posted.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); };
    const run = () => { const stop = new AbortController(); stops.push(stop); const err: string[] = []; const done = main(['--config', configPath, 'teams', 'relay', '--url', base], { cwd: dir, env, signal: stop.signal, stdout: () => undefined, stderr: (l) => err.push(l), reconnectDelayMs: 20, teamsFetch, teamsRetryDelayMs: 1 }); return { stop, err, done }; };
    const first = run();
    await until(() => first.err.some((l) => l.includes('teams_relay_started')));
    await until(() => monitor.listeners.size === 1);
    monitor.emit(makeEvent(4, { type: 'tier_selected', role: 'swe', tier: 'sm' }));
    monitor.emit(makeEvent(5, { type: 'tier_escalated', role: 'swe', tier: 'med', message: 'swe escalated sm -> med: CHECKS_FAILED' }));
    monitor.emit(makeEvent(6, { type: 'role_started' }));
    monitor.emit(makeEvent(7, { type: 'job_finished', state: 'READY_FOR_HUMAN' }));
    await until(() => posted.length === 2);
    assert.match(cardText(posted[0]), /moved up to med/);
    assert.match(cardText(posted[1]), /SAMPLE-1 is ready for review/);
    assert.equal(facts(posted[1]).Branch, 'deep/SAMPLE-1', 'job facts fetched from the controller');
    assert.equal(facts(posted[1])['SWE tier'], 'sm → med (1 escalation)');
    assert.ok(urls.every((u) => u === new URL(WEBHOOK).toString()));
    assert.doesNotMatch(first.err.join('\n'), /SECRET|sig=/, 'the webhook URL is never logged');
    assert.doesNotMatch(first.err.join('\n'), new RegExp(TOKEN));
    first.stop.abort(); assert.equal(await first.done, 0);
    const cursorFile = join(dir, 'data', 'teams-relay.json');
    assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).last_event_id, 7);
    assert.equal((await stat(cursorFile)).mode & 0o777, 0o600);
    // Restart: resumes after event 7, posts only the new BLOCKED card.
    const second = run();
    await until(() => second.err.some((l) => l.includes('"after":7')));
    await until(() => monitor.listeners.size === 1);
    monitor.emit(makeEvent(8, { type: 'job_finished', state: 'BLOCKED', code: 'CHECK_FAILED' }));
    await until(() => posted.length === 3);
    assert.match(cardText(posted[2]), /blocked \(CHECK_FAILED\)/);
    second.stop.abort(); assert.equal(await second.done, 0);
    assert.equal(posted.length, 3);
  } finally { for (const stop of stops) stop.abort(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('autos teams test posts one connectivity card; missing configuration or webhook fails clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, withTeams());
    const posted: unknown[] = []; const out: string[] = []; const err: string[] = [];
    const teamsFetch = async (_url: URL, init: RequestInit) => { posted.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); };
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env: { AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK }, stdout: (l) => out.push(l), stderr: (l) => err.push(l), teamsFetch }), 0);
    assert.equal(posted.length, 1); assert.match(cardText(posted[0]), /notifications are connected/); assert.match(out.join(''), /Test card delivered \(HTTP 202\)/);
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env: {}, stdout: () => undefined, stderr: (l) => err.push(l), teamsFetch }), 1);
    assert.match(err.join('\n'), /AUTOS_TEAMS_WEBHOOK_URL must be set/);
    const plain = join(dir, 'plain.yaml'); await writeFile(plain, canonical);
    assert.equal(await main(['--config', plain, 'teams', 'test'], { cwd: dir, env: { AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK }, stdout: () => undefined, stderr: (l) => err.push(l), teamsFetch }), 1);
    assert.match(err.join('\n'), /notifications\.teams is not configured/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const TENANT = '11111111-2222-3333-4444-555555555555'; const CLIENT = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const authBlock = (cloud = '') => `    auth:\n      tenant_id: ${TENANT}\n      client_id: ${CLIENT}\n      client_secret_env: AUTOS_TEAMS_CLIENT_SECRET\n${cloud}`;

test('teams auth config: GUIDs required, cloud defaults to public', () => {
  assert.deepEqual(parseConfigYaml(withTeams(authBlock())).notifications?.teams?.auth, { tenant_id: TENANT, client_id: CLIENT, client_secret_env: 'AUTOS_TEAMS_CLIENT_SECRET', cloud: 'public' });
  assert.equal(parseConfigYaml(withTeams(authBlock('      cloud: gcch\n'))).notifications?.teams?.auth?.cloud, 'gcch');
  assert.throws(() => parseConfigYaml(withTeams(authBlock().replace(TENANT, 'contoso.onmicrosoft.com'))));
  assert.throws(() => parseConfigYaml(withTeams(authBlock('      client_secret: inline\n'))), 'secrets never go in the config file');
});

test('Entra token source: client-credentials for the Power Automate audience, cached, errors never leak the secret', async () => {
  let now = 1_000_000; const requests: Array<{ url: string; body: URLSearchParams; redirect?: RequestRedirect | undefined }> = [];
  const replies: Array<() => Response> = [() => Response.json({ access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' })];
  const fake = async (url: URL, init: RequestInit) => { requests.push({ url: url.toString(), body: new URLSearchParams(String(init.body)), redirect: init.redirect }); return replies.shift()!(); };
  const source = new EntraTokenSource({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'S3CRET-VALUE', cloud: 'public', fetch: fake, now: () => now });
  assert.equal(await source.token(), 'tok-1'); assert.equal(await source.token(), 'tok-1');
  assert.equal(requests.length, 1, 'cached');
  assert.equal(requests[0]!.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.deepEqual(Object.fromEntries(requests[0]!.body), { grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'S3CRET-VALUE', scope: 'https://service.flow.microsoft.com//.default' });
  assert.equal(requests[0]!.redirect, 'error');
  now += 3301 * 1000; replies.push(() => Response.json({ access_token: 'tok-2', expires_in: '3599' }));
  assert.equal(await source.token(), 'tok-2', 'refreshed five minutes before expiry');
  source.invalidate();
  replies.push(() => Response.json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret S3CRET-VALUE provided' }, { status: 401 }));
  await assert.rejects(source.token(), (error: Error) => /HTTP 401, invalid_client/.test(error.message) && !error.message.includes('S3CRET') && !error.message.includes('AADSTS'));
  const gcch = new EntraTokenSource({ tenantId: TENANT, clientId: CLIENT, clientSecret: 's', cloud: 'gcch', fetch: async (url, init) => { requests.push({ url: url.toString(), body: new URLSearchParams(String(init.body)) }); return Response.json({ access_token: 't', expires_in: 60 }); } });
  await gcch.token();
  assert.equal(requests.at(-1)!.url, `https://login.microsoftonline.us/${TENANT}/oauth2/v2.0/token`);
  assert.equal(requests.at(-1)!.body.get('scope'), 'https://high.service.flow.microsoft.us//.default');
});

test('autos teams test signs posts with a bearer token, refreshes once on 401, explains an unsigned 401', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-auth-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, withTeams(authBlock()));
    const env = { AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK, AUTOS_TEAMS_CLIENT_SECRET: 'S3CRET-VALUE' };
    let issued = 0; const webhookAuth: Array<string | undefined> = []; const webhookStatuses = [401, 202]; const out: string[] = []; const err: string[] = [];
    const teamsFetch = async (url: URL, init: RequestInit) => {
      if (url.hostname === 'login.microsoftonline.com') { issued++; return Response.json({ access_token: `tok-${issued}`, expires_in: 3600 }); }
      webhookAuth.push((init.headers as Record<string, string>).authorization); return new Response(null, { status: webhookStatuses.shift()! });
    };
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: (l) => err.push(l), teamsFetch, teamsRetryDelayMs: 1 }), 0);
    assert.deepEqual(webhookAuth, ['Bearer tok-1', 'Bearer tok-2'], 'a refused token is replaced once');
    assert.match(out.join(''), /delivered \(HTTP 202\)/);
    // Wrong secret: fails at once with a config error, no secret in the output.
    const badFetch = async (url: URL) => url.hostname === 'login.microsoftonline.com' ? Response.json({ error: 'invalid_client' }, { status: 401 }) : new Response(null, { status: 202 });
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: (l) => err.push(l), teamsFetch: badFetch, teamsRetryDelayMs: 1 }), 1);
    assert.match(err.join('\n'), /Teams app sign-in failed \(HTTP 401, invalid_client\)/);
    // Missing secret variable.
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env: { AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK }, stdout: () => undefined, stderr: (l) => err.push(l), teamsFetch }), 1);
    assert.match(err.join('\n'), /AUTOS_TEAMS_CLIENT_SECRET must be set/);
    // No auth configured and the trigger demands sign-in: a 401 with a pointer to the fix.
    const plain = join(dir, 'plain.yaml'); await writeFile(plain, withTeams()); const plainOut: string[] = [];
    assert.equal(await main(['--config', plain, 'teams', 'test'], { cwd: dir, env, stdout: (l) => plainOut.push(l), stderr: () => undefined, teamsFetch: async () => new Response(null, { status: 401 }) }), 1);
    assert.match(plainOut.join(''), /HTTP 401\)\. The workflow requires sign-in: set notifications\.teams\.auth/);
    assert.ok(![...out, ...err, ...plainOut].join('\n').includes('S3CRET'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('autos teams relay announces Autos up once per controller process, down after an outage, back up, and its own stop', async () => {
  const monitor = monitorPort([]);
  const workflow: WorkflowServicePort = { submit: async () => ready, execute: async () => ready, cancel: async () => ready, revise: async () => ready, retry: async () => ready, get: async () => ready, list: async () => [ready], poll: async () => undefined, ...monitor } as WorkflowServicePort;
  const options: ControllerOptions = { config, workflow, operatorToken: TOKEN, sseHeartbeatMs: 40, runnerHealthTimeoutMs: 100,
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined };
  let app = await createController(options); const base = await listen(app); const port = Number(new URL(base).port);
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-life-')); const stops: AbortController[] = [];
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, withTeams()); // default notify includes AUTOS_UP / AUTOS_DOWN
    const env = { [config.api.operator_token_env]: TOKEN, AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK };
    const posted: unknown[] = [];
    const teamsFetch = async (_url: URL, init: RequestInit) => { posted.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); };
    const run = () => { const stop = new AbortController(); stops.push(stop); const err: string[] = []; const done = main(['--config', configPath, 'teams', 'relay', '--url', base], { cwd: dir, env, signal: stop.signal, stdout: () => undefined, stderr: (l) => err.push(l), reconnectDelayMs: 20, teamsFetch, teamsRetryDelayMs: 1, teamsDownAfterMs: 0 }); return { stop, err, done }; };
    const titles = () => posted.map((p) => (p as Card).attachments[0]!.content.body[0]!.text!);

    const first = run();
    await until(() => posted.length === 1);
    assert.equal(titles()[0], '🟢 Autos is up');
    assert.match(facts(posted[0])['Auto poll']!, /^(on|off)/); assert.ok(facts(posted[0])['Controller started']);
    first.stop.abort(); assert.equal(await first.done, 0);
    assert.equal(titles()[1], '⏹ Autos Teams notifications stopped');

    // A relay restart against the same controller process does not announce it again.
    const second = run();
    await until(() => second.err.some((l) => l.includes('teams_relay_started')));
    await until(() => monitor.listeners.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(posted.length, 2, 'same controller process: no second up card');

    // The controller goes away: one down card; it comes back (a new process): one "back up" card.
    await app.close();
    await until(() => titles().includes('🔴 Autos is down: the controller stopped answering'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(titles().filter((t) => t.startsWith('🔴')).length, 1, 'down is posted once per outage');
    app = await createController(options); await app.listen({ host: '127.0.0.1', port });
    await until(() => titles().includes('🟢 Autos is back up'));
    const back = posted[titles().indexOf('🟢 Autos is back up')];
    assert.ok(facts(back)['Down for']); assert.match(cardText(back), /Controller started/);
    second.stop.abort(); assert.equal(await second.done, 0);
    assert.equal(titles().at(-1), '⏹ Autos Teams notifications stopped');
    assert.doesNotMatch(second.err.join('\n'), /SECRET|sig=/);
  } finally { for (const stop of stops) stop.abort(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('payload: card posts the bare Adaptive Card for workflows that use the trigger Body as the card', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-teams-card-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, withTeams('    payload: card\n'));
    const posted: Array<Record<string, unknown>> = [];
    const teamsFetch = async (_url: URL, init: RequestInit) => { posted.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); };
    assert.equal(await main(['--config', configPath, 'teams', 'test'], { cwd: dir, env: { AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK }, stdout: () => undefined, stderr: () => undefined, teamsFetch }), 0);
    assert.equal(posted[0]!.type, 'AdaptiveCard'); assert.equal(posted[0]!.version, '1.4'); assert.equal(posted[0]!.attachments, undefined);
    assert.match(JSON.stringify(posted[0]), /notifications are connected/);
    assert.equal(parseConfigYaml(withTeams()).notifications?.teams?.payload, 'message');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
