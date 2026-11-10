import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseConfigYaml, type JobRecord, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { main } from '../../apps/cli/src/index.js';
import { buildTeamsMessage, notificationKind, parseTeamsWebhookUrl, postTeamsMessage, TierTracker } from '../../apps/cli/src/teams.js';
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
