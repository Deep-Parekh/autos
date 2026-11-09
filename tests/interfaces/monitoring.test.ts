import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseConfigYaml, type JobRecord, type WorkflowActivity, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { formatStatus as formatStatusForTest, main } from '../../apps/cli/src/index.js';
import { emptyActivity, makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const TOKEN = 'monitoring-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const job: JobRecord = { job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'IMPLEMENTING', dry_run: true, repair_round: 0, created_at: now, updated_at: now, base_branch: 'develop' };

function withActive(active: NonNullable<WorkflowActivity['active']>, counts: WorkflowActivity['counts'], lastEventId: number, more: NonNullable<WorkflowActivity['active']>[] = []): WorkflowActivity {
  const all = [active, ...more];
  return { ...emptyActivity, active, active_jobs: all, slots: { max_parallel: Math.max(1, all.length), in_use: all.length, max_concurrent_checks: 1, checks_in_use: 0 }, counts, last_event_id: lastEventId };
}

function setup(overrides: Partial<ControllerOptions> = {}) {
  const monitor = monitorPort([makeEvent(1), makeEvent(2, { type: 'role_finished', outcome: 'SUCCEEDED', message: 'see /Users/me/secret/file at https://user:pw@example.com/x' }), makeEvent(3, { job_id: null, issue_key: null, type: 'poll_finished', count: 2, stage: undefined, role: undefined, provider: undefined, repair_round: undefined } as never)]);
  const workflow: WorkflowServicePort = {
    submit: async () => job, execute: async () => job, cancel: async () => job, revise: async () => job, retry: async () => job, get: async (id) => id === job.job_id ? job : null, list: async () => [job], poll: async () => undefined, ...monitor,
  };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, sseHeartbeatMs: 40, runnerHealthTimeoutMs: 100,
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined, ...overrides,
  };
  return { options, monitor };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test('all monitoring routes require the bearer token', async () => {
  const { options } = setup(); const app = await createController(options);
  try {
    for (const url of ['/v1/status', '/v1/events', `/v1/jobs/${job.job_id}/events`, '/v1/events/stream']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
      assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong-token-wrong-token' } })).statusCode, 401, url);
    }
  } finally { await app.close(); }
});

test('status reports controller, loop, runner, activity and server-side elapsed times', async () => {
  const startedAt = new Date(Date.now() - 125_000).toISOString(); const stageAt = new Date(Date.now() - 20_000).toISOString();
  const activity: WorkflowActivity = withActive({ job_id: job.job_id, issue_key: 'SAMPLE-1', state: 'IMPLEMENTING', dry_run: false, repair_round: 1, stage: 'implementation', stage_started_at: stageAt, role: 'swe', provider: 'claude', started_at: startedAt }, { IMPLEMENTING: 1, QUEUED: 2 }, 3);
  const next = new Date(Date.now() + 30_000).toISOString();
  const { options, monitor } = setup({ runnerHealth: async () => ({ status: 'ready', version: 1, docker: 'available' }), loopStatus: () => ({ running: true, next_poll_at: next, consecutive_failures: 2, auto_poll: true, last_discovery_at: null }) });
  monitor.activityValue = activity;
  const app = await createController(options);
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/status', headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.controller.version, '0.1.0'); assert.equal(body.controller.poll_interval_s, config.jira.poll_seconds);
    assert.deepEqual(body.controller.poll_loop, { running: true, next_poll_at: next, consecutive_failures: 2, auto_poll: true, last_discovery_at: null });
    assert.deepEqual(body.runner, { status: 'ready', version: 1, docker: 'available' });
    assert.equal(body.activity.active.role, 'swe'); assert.equal(body.activity.counts.QUEUED, 2); assert.equal(body.activity.last_event_id, 3);
    assert.ok(body.active_elapsed_s >= 125 && body.active_elapsed_s < 140); assert.ok(body.stage_elapsed_s >= 20 && body.stage_elapsed_s < 35);
    assert.match(body.controller.started_at, /^\d{4}-/);
  } finally { await app.close(); }
});

test('status is null-safe without a loop or runner health and maps failures to unreachable', async () => {
  const idle = setup(); const app = await createController(idle.options);
  try {
    const body = (await app.inject({ method: 'GET', url: '/v1/status', headers: auth })).json();
    assert.deepEqual(body.runner, { status: 'unknown' });
    assert.deepEqual(body.controller.poll_loop, { running: false, next_poll_at: null, consecutive_failures: 0, auto_poll: config.jira.auto_poll, last_discovery_at: null });
    assert.equal(body.activity.active, null); assert.equal('active_elapsed_s' in body, false);
  } finally { await app.close(); }
  for (const runnerHealth of [async () => { throw new Error('socket /var/run/secret.sock refused'); }, () => new Promise<never>(() => undefined)]) {
    const failing = setup({ runnerHealth }); const failingApp = await createController(failing.options);
    try {
      const response = await failingApp.inject({ method: 'GET', url: '/v1/status', headers: auth });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json().runner, { status: 'unreachable' });
      assert.doesNotMatch(response.body, /secret\.sock/);
    } finally { await failingApp.close(); }
  }
});

test('events paginate by cursor, filter by job, scrub text, and scoped route 404s unknown jobs', async () => {
  const { options } = setup(); const app = await createController(options);
  try {
    const first = (await app.inject({ method: 'GET', url: '/v1/events?limit=2', headers: auth })).json();
    assert.deepEqual(first.events.map((e: { event_id: number }) => e.event_id), [1, 2]); assert.equal(first.next_after, 2);
    assert.doesNotMatch(JSON.stringify(first), /Users\/me|example\.com|pw@/);
    const second = (await app.inject({ method: 'GET', url: `/v1/events?after=${first.next_after}&limit=2`, headers: auth })).json();
    assert.deepEqual(second.events.map((e: { event_id: number }) => e.event_id), [3]); assert.equal(second.next_after, 3);
    const empty = (await app.inject({ method: 'GET', url: '/v1/events?after=3', headers: auth })).json();
    assert.deepEqual(empty, { events: [], next_after: 3 });
    const scoped = (await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}/events`, headers: auth })).json();
    assert.deepEqual(scoped.events.map((e: { event_id: number }) => e.event_id), [1, 2]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/events?job_id=cccccccc-cccc-4ccc-8ccc-cccccccccccc', headers: auth })).json().events.length, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/events', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/events?limit=501', headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/events?after=-1', headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});

test('job output includes base_branch', async () => {
  const { options } = setup(); const app = await createController(options);
  try { assert.equal((await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}`, headers: auth })).json().base_branch, 'develop'); } finally { await app.close(); }
});

async function openStream(url: string, headers: Record<string, string> = auth) {
  const abort = new AbortController(); const decoder = new TextDecoder(); let text = '';
  const response = await fetch(url, { headers, signal: abort.signal });
  const done = (async () => { try { for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true }); } catch { /* aborted */ } })();
  return { response, abort, done, text: () => text };
}

test('SSE replays after a cursor, then delivers live events, heartbeats, and unsubscribes on disconnect', async () => {
  const { options, monitor } = setup(); const app = await createController(options); const base = await listen(app);
  try {
    const stream = await openStream(`${base}/v1/events/stream?after=1`);
    assert.equal(stream.response.status, 200); assert.match(stream.response.headers.get('content-type') ?? '', /text\/event-stream/);
    await until(() => stream.text().includes('id: 3'));
    assert.match(stream.text(), /id: 2\nevent: role_finished\ndata: \{/); assert.doesNotMatch(stream.text(), /id: 1\n/);
    assert.doesNotMatch(stream.text(), /Users\/me|example\.com/);
    assert.equal(monitor.listeners.size, 1);
    monitor.emit(makeEvent(4, { type: 'checks_started' }));
    await until(() => stream.text().includes('id: 4\nevent: checks_started'));
    await until(() => stream.text().includes(': heartbeat'));
    stream.abort.abort(); await stream.done;
    await until(() => monitor.listeners.size === 0);
  } finally { await app.close(); }
});

test('SSE honours Last-Event-ID, filters by job, and does not duplicate events persisted during subscribe', async () => {
  const { options, monitor } = setup(); const app = await createController(options); const base = await listen(app);
  // An event that is both persisted before the replay read and delivered live must be sent once.
  const originalEvents = monitor.events; let injected = false;
  options.workflow.events = async (query) => {
    if (!injected) { injected = true; monitor.emit(makeEvent(4, { type: 'stage_started' })); }
    return originalEvents(query);
  };
  try {
    const stream = await openStream(`${base}/v1/events/stream?job_id=${job.job_id}`, { ...auth, 'last-event-id': '1' });
    await until(() => stream.text().includes('id: 4'));
    monitor.emit(makeEvent(5, { job_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', issue_key: 'SAMPLE-2' }));
    monitor.emit(makeEvent(6, { type: 'job_finished' }));
    await until(() => stream.text().includes('id: 6'));
    const ids = [...stream.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [2, 4, 6]);
    stream.abort.abort(); await stream.done;
  } finally { await app.close(); }
});

test('closing the app ends open streams and unsubscribes', async () => {
  const { options, monitor } = setup(); const app = await createController(options); const base = await listen(app);
  const stream = await openStream(`${base}/v1/events/stream`);
  await until(() => monitor.listeners.size === 1);
  await app.close();
  await stream.done;
  assert.equal(monitor.listeners.size, 0);
});

// ---- CLI against a real loopback controller with a fake runtime ----

async function withCli<T>(setupOptions: Partial<ControllerOptions>, run: (ctx: { base: string; env: NodeJS.ProcessEnv; monitor: ReturnType<typeof monitorPort>; configPath: string; dir: string }) => Promise<T>): Promise<T> {
  const { options, monitor } = setup(setupOptions); const app = await createController(options); const base = await listen(app);
  const dir = await mkdtemp(join(tmpdir(), 'autos-monitor-'));
  try {
    const port = new URL(base).port;
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    return await run({ base, env: { [config.api.operator_token_env]: TOKEN }, monitor, configPath, dir });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('autos status prints a concise summary or raw JSON from the running controller', async () => {
  const activity: WorkflowActivity = withActive({ job_id: job.job_id, issue_key: 'SAMPLE-1', state: 'IMPLEMENTING', dry_run: false, repair_round: 0, stage: 'implementation', stage_started_at: now, role: 'swe', provider: 'claude', started_at: now }, { IMPLEMENTING: 1 }, 3);
  await withCli({ runnerHealth: async () => ({ status: 'ready', version: 1, docker: 'test-only' }) }, async ({ env, monitor, configPath, dir }) => {
    monitor.activityValue = activity;
    const out: string[] = [];
    assert.equal(await main(['--config', configPath, 'status'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: () => undefined }), 0);
    const text = out.join('\n');
    assert.match(text, /Controller 0\.1\.0/); assert.match(text, /Runner: ready \(docker test-only\)/); assert.match(text, /Active: SAMPLE-1 IMPLEMENTING stage=implementation swe\/claude round 0/);
    assert.match(text, /Jobs: IMPLEMENTING 1/); assert.doesNotMatch(text, new RegExp(TOKEN));
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'status'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: () => undefined }), 0);
    assert.equal(JSON.parse(out[0]!).activity.active.issue_key, 'SAMPLE-1');
  });
});

test('autos events lists and paginates; bad flags and missing token are clear errors', async () => {
  await withCli({}, async ({ env, base, configPath, dir }) => {
    const out: string[] = []; const err: string[] = [];
    const deps = { cwd: dir, env, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
    assert.equal(await main(['--config', configPath, 'events', '--limit', '2'], deps), 0);
    assert.equal(out.length, 2); assert.match(out[0]!, /^12:01:01 SAMPLE-1 role_started swe\/claude round 0 stage=implementation$/);
    assert.doesNotMatch(out.join('\n'), /Users\/me|example\.com/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, 'events', '--after', '2'], deps), 0);
    assert.equal(out.length, 1); assert.match(out[0]!, /^12:01:03 service poll_finished count=2$/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'events', '--job', job.job_id, '--url', base], deps), 0);
    assert.equal(JSON.parse(out[0]!).events.length, 2); assert.equal(JSON.parse(out[0]!).next_after, 2);
    assert.equal(await main(['--config', configPath, 'events', '--limit', '0'], deps), 2);
    assert.equal(await main(['--config', configPath, 'events', '--job', 'nope'], deps), 2);
    assert.equal(await main(['--config', configPath, 'events'], { ...deps, env: {} }), 1);
    assert.match(err.at(-1)!, /INVALID_CONFIG/);
    assert.equal(await main(['--config', configPath, 'events'], { ...deps, env: { [config.api.operator_token_env]: 'wrong-token-wrong-token' } }), 1);
    assert.match(err.at(-1)!, /AUTH/); assert.doesNotMatch(err.join(''), /wrong-token/);
  });
});

test('CLI reports an unreachable controller clearly without a stack or token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-monitor-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, 'port: 59999'));
    for (const command of ['status', 'events', 'watch']) {
      const err: string[] = [];
      assert.equal(await main(['--config', configPath, command], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: () => undefined, stderr: (l) => err.push(l) }), 1, command);
      assert.match(err[0]!, /not reachable/); assert.doesNotMatch(err.join(''), new RegExp(TOKEN));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('autos watch replays, follows live events, reconnects with Last-Event-ID, and exits on abort', async () => {
  await withCli({}, async ({ env, monitor, configPath, dir }) => {
    const out: string[] = []; const stop = new AbortController();
    const done = main(['--config', configPath, 'watch', '--job', job.job_id], { cwd: dir, env, signal: stop.signal, stdout: (l) => out.push(l), stderr: () => undefined, reconnectDelayMs: 20 });
    await until(() => out.length >= 2);
    assert.match(out[1]!, /^12:01:02 SAMPLE-1 role_finished swe\/claude round 0 stage=implementation outcome=SUCCEEDED/);
    monitor.emit(makeEvent(4, { type: 'checks_started', role: undefined, provider: undefined } as never));
    await until(() => out.length >= 3);
    assert.match(out[2]!, /^12:01:04 SAMPLE-1 checks_started round 0 stage=implementation$/);
    stop.abort();
    assert.equal(await done, 0);
    assert.equal(monitor.listeners.size === 0 || await (async () => { await until(() => monitor.listeners.size === 0); return true; })(), true);
  });
});

test('autos watch reconnects after the connection drops and resumes from the last event', async () => {
  const { options, monitor } = setup(); const app = await createController(options); const base = await listen(app);
  const dir = await mkdtemp(join(tmpdir(), 'autos-monitor-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical);
    const seenAfter: Array<string | undefined> = []; const original = options.workflow.events;
    options.workflow.events = async (query) => { seenAfter.push(String(query.after)); return original(query); };
    const out: string[] = []; const err: string[] = []; const stop = new AbortController();
    const done = main(['--config', configPath, 'watch', '--url', base], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, signal: stop.signal, stdout: (l) => out.push(l), stderr: (l) => err.push(l), reconnectDelayMs: 20 });
    await until(() => out.length >= 3);
    // Drop all server-side connections; the client must reconnect with the last seen id.
    app.server.closeAllConnections();
    await until(() => err.some((line) => line.includes('watch_reconnecting')));
    await until(() => monitor.listeners.size === 1);
    monitor.emit(makeEvent(4, { type: 'job_finished' }));
    await until(() => out.length >= 4);
    assert.match(out[3]!, /job_finished/); assert.equal(seenAfter.at(-1), '3');
    assert.equal(out.length, 4);
    stop.abort(); assert.equal(await done, 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('formatStatus tolerates an idle controller', () => {
  assert.match(formatStatusForTest({ controller: { version: '0.1.0', started_at: now, uptime_s: 3700, poll_interval_s: 60, poll_loop: { running: false, next_poll_at: null, consecutive_failures: 0, auto_poll: true, last_discovery_at: null } }, runner: { status: 'unreachable' }, activity: emptyActivity, active_jobs: [] }), /up 1h01m[\s\S]*Runner: WARN unreachable[\s\S]*idle[\s\S]*Jobs: none/);
});

const second = { job_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', issue_key: 'SAMPLE-2', state: 'QA' as const, dry_run: false, repair_round: 0, stage: 'qa' as const, stage_started_at: new Date(Date.now() - 5_000).toISOString(), role: 'qa' as const, provider: 'codex' as const, started_at: new Date(Date.now() - 65_000).toISOString() };

function twoActive(): WorkflowActivity {
  const first = { job_id: job.job_id, issue_key: 'SAMPLE-1', state: 'IMPLEMENTING' as const, dry_run: false, repair_round: 0, stage: 'implementation' as const, stage_started_at: new Date(Date.now() - 20_000).toISOString(), role: 'swe' as const, provider: 'claude' as const, started_at: new Date(Date.now() - 125_000).toISOString() };
  return { ...withActive(first, { IMPLEMENTING: 1, QA: 1 }, 4, [second]), slots: { max_parallel: 2, in_use: 2, max_concurrent_checks: 1, checks_in_use: 1 } };
}

test('status exposes every active job with per-job elapsed times and slots', async () => {
  const { options, monitor } = setup(); monitor.activityValue = twoActive();
  const app = await createController(options);
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/status', headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.activity.slots, { max_parallel: 2, in_use: 2, max_concurrent_checks: 1, checks_in_use: 1 });
    assert.equal(body.activity.active_jobs.length, 2); assert.equal(body.active_jobs.length, 2);
    assert.deepEqual(body.active_jobs.map((j: { issue_key: string }) => j.issue_key), ['SAMPLE-1', 'SAMPLE-2']);
    assert.ok(body.active_jobs[0].active_elapsed_s >= 125 && body.active_jobs[0].stage_elapsed_s >= 20);
    assert.ok(body.active_jobs[1].active_elapsed_s >= 65 && body.active_jobs[1].active_elapsed_s < 80 && body.active_jobs[1].stage_elapsed_s >= 5 && body.active_jobs[1].stage_elapsed_s < 20);
    assert.equal(body.active_elapsed_s, body.active_jobs[0].active_elapsed_s); assert.equal(body.stage_elapsed_s, body.active_jobs[0].stage_elapsed_s);
  } finally { await app.close(); }
});

test('autos status lists slots and one line per active job; --json carries the new fields', async () => {
  await withCli({}, async ({ env, monitor, configPath, dir }) => {
    monitor.activityValue = twoActive();
    const out: string[] = [];
    assert.equal(await main(['--config', configPath, 'status'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: () => undefined }), 0);
    const text = out.join('\n');
    assert.match(text, /Slots: 2\/2 \(checks 1\/1\)/);
    assert.match(text, /Active: SAMPLE-1 IMPLEMENTING stage=implementation swe\/claude round 0.*job 2m/);
    assert.match(text, /Active: SAMPLE-2 QA stage=qa qa\/codex round 0.*job 1m/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'status'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: () => undefined }), 0);
    const json = JSON.parse(out[0]!);
    assert.equal(json.activity.active_jobs.length, 2); assert.equal(json.activity.slots.max_parallel, 2); assert.equal(json.active_jobs[1].issue_key, 'SAMPLE-2');
  });
});
