import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { AutosError, parseConfigYaml, type AutosConfig, type JobRecord, type ProjectMapping, type WorkflowServicePort } from '@autos/contracts';
import { readFile } from 'node:fs/promises';
import { createController, retryBlockedJobs, type ControllerOptions, type LoopStatus } from '../../apps/controller/src/index.js';
import { main, formatStatus, type CliDependencies, type CliRuntime } from '../../apps/cli/src/index.js';
import { runControllerLoop } from '../../apps/cli/src/loop.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const base = parseConfigYaml(canonical);
const TOKEN = 'operations-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = (n: number, extra: Partial<JobRecord> = {}): JobRecord => ({ job_id: id(n), issue_key: `SAMPLE-${n}`, repository_id: null, base_sha: null, state: 'QUEUED', dry_run: false, repair_round: 0, created_at: now, updated_at: now, ...extra });
const withPoll = (auto_poll: boolean): AutosConfig => ({ ...base, jira: { ...base.jira, auto_poll } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await tick();
  assert.ok(condition(), `timed out waiting for ${label}`);
}

function fakeWorkflow(overrides: Partial<WorkflowServicePort> = {}) {
  const monitor = monitorPort();
  const workflow: WorkflowServicePort = {
    submit: async (key) => job(1, { issue_key: key }), execute: async () => job(1, { state: 'PLANNED' }), cancel: async (jobId) => job(1, { job_id: jobId, state: 'CANCELLED' }),
    revise: async () => job(2, { parent_job_id: id(1), revision: 1 }), retry: async (jobId) => job(99, { issue_key: `RETRY-${jobId.slice(-2)}` }),
    get: async (jobId) => job(1, { job_id: jobId }), list: async () => [], poll: async () => undefined, ...monitor, ...overrides,
  };
  return { workflow, monitor };
}

// ---- 1. controller loop ----

function loopHarness(config: AutosConfig, workflow: WorkflowServicePort, sleepKinds: { discover: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const stop = new AbortController(); const out: string[] = []; const err: string[] = [];
  const state: LoopStatus = { running: false, next_poll_at: null, consecutive_failures: 0, auto_poll: config.jira.auto_poll, last_discovery_at: null };
  const done = runControllerLoop({
    workflow, config, signal: stop.signal, state, stdout: (line) => out.push(line), stderr: (line) => err.push(line), now: () => new Date(now),
    sleep: (ms, signal, kind) => kind === 'discover' ? sleepKinds.discover(ms, signal) : new Promise<void>((resolve) => { if (signal.aborted) resolve(); signal.addEventListener('abort', () => resolve(), { once: true }); }),
  });
  return { stop, out, err, state, done };
}

test('auto_poll false never discovers, logs one startup line, and still drains submitted work', async () => {
  let discoveries = 0; let drains = 0;
  const { workflow, monitor } = fakeWorkflow({ discover: async () => { discoveries++; return { discovered: 0, queued: 0 }; }, drain: async () => { drains++; } });
  const h = loopHarness(withPoll(false), workflow, { discover: async () => { throw new Error('discovery sleep must not run'); } });
  await until(() => drains === 1, 'first drain');
  assert.deepEqual(h.out, ['auto_poll disabled: only submitted jobs run']);
  assert.equal(h.state.auto_poll, false); assert.equal(h.state.running, true);
  // A requeued job (auto-retry) or a settled job wakes the drain without waiting poll_seconds.
  monitor.emit(makeEvent(1, { type: 'job_queued' })); await until(() => drains === 2, 'drain after job_queued');
  monitor.emit(makeEvent(2, { type: 'job_finished' })); await until(() => drains === 3, 'drain after job_finished');
  monitor.emit(makeEvent(3, { type: 'role_started' })); await tick(); await tick(); assert.equal(drains, 3);
  h.stop.abort(); await h.done;
  assert.equal(discoveries, 0); assert.equal(h.state.running, false); assert.equal(monitor.listeners.size, 0);
});

test('discovery runs on its own timer while a long drain is in flight, and queued work wakes drain', async () => {
  let discoveries = 0; let drains = 0; let releaseDrain: (() => void) | undefined; let drainRunning = false; let queuedNext = 0;
  const { workflow } = fakeWorkflow({
    discover: async () => { discoveries++; const queued = queuedNext; queuedNext = 0; return { discovered: queued, queued }; },
    drain: async (signal) => { drains++; if (drains === 2) { drainRunning = true; await new Promise<void>((resolve) => { releaseDrain = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); }); drainRunning = false; } },
  });
  let sleeps = 0; const delays: number[] = []; const gates: Array<() => void> = [];
  const h = loopHarness(withPoll(true), workflow, { discover: async (ms, signal) => {
    delays.push(ms); sleeps++;
    if (sleeps === 1) { queuedNext = 1; return; }
    await new Promise<void>((resolve) => { gates.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
  } });
  // discover #1 (nothing queued) -> sleep#1 arms queuedNext -> discover #2 queues work -> drain #2 starts and blocks.
  await until(() => drainRunning, 'long drain');
  await until(() => gates.length === 1, 'discovery waiting on its timer');
  const before = discoveries;
  gates.shift()!(); // the discovery timer fires while drain is still running
  await until(() => discoveries === before + 1, 'discovery while drain is blocked');
  assert.equal(drainRunning, true, 'drain is still running while discovery continues');
  assert.equal(h.state.last_discovery_at, now);
  assert.equal(h.out.length, 0);
  h.stop.abort(); releaseDrain?.(); await h.done;
  assert.ok(delays.every((ms) => ms === base.jira.poll_seconds * 1000));
});

test('discovery failures back off, are logged by code only, and do not stop draining', async () => {
  let discoveries = 0; let drains = 0;
  const { workflow } = fakeWorkflow({ discover: async () => { discoveries++; throw new AutosError('UPSTREAM', 'jira down at https://user:secret@example.com'); }, drain: async () => { drains++; } });
  const delays: number[] = [];
  const h = loopHarness(withPoll(true), workflow, { discover: async (ms, signal) => { delays.push(ms); if (delays.length >= 3) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); } });
  await until(() => delays.length >= 3, 'three failed discoveries');
  assert.deepEqual(delays.slice(0, 3), [60_000, 120_000, 240_000].map((ms) => ms * base.jira.poll_seconds / 60));
  assert.equal(h.state.consecutive_failures, 3); assert.equal(h.state.last_discovery_at, null);
  assert.ok(drains >= 1);
  assert.equal(h.err.length, 1); assert.match(h.err[0]!, /"event":"poll_failed".*"code":"UPSTREAM"/); assert.doesNotMatch(h.err.join(''), /secret|example\.com/);
  h.stop.abort(); await h.done; assert.equal(discoveries, 3);
});

// ---- 2. structured logging ----

async function loggedController(extra: Partial<ControllerOptions> = {}, workflowOverrides: Partial<WorkflowServicePort> = {}) {
  const lines: string[] = [];
  const { workflow } = fakeWorkflow(workflowOverrides);
  const options: ControllerOptions = {
    config: withPoll(false), workflow, operatorToken: TOKEN, logStream: { write: (line) => { lines.push(line.trim()); } },
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new AutosError('NOT_FOUND', 'none'); } },
    providers: async () => [], projects: async (): Promise<ProjectMapping[]> => [], testProviders: async () => [], close: async () => undefined, ...extra,
  };
  const app = await createController(options);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, lines, records };
}

test('request logging is one safe line per request: route pattern, status, duration; never query, headers, or tokens', async () => {
  const f = await loggedController();
  try {
    await f.app.inject({ method: 'GET', url: `/v1/jobs/${id(7)}?secret=query-secret-value`, headers: { ...auth, 'x-custom': 'header-secret-value' } });
    await f.app.inject({ method: 'GET', url: '/v1/queue?limit=1', headers: { authorization: 'Bearer wrong-token-presented-123456' } });
    await f.app.inject({ method: 'GET', url: '/v1/no-such-route?x=1', headers: auth });
    await f.app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1', notes: [{ instructions: 'note-text-secret' }], bogus: true } });
    const text = f.lines.join('\n');
    assert.doesNotMatch(text, /query-secret-value|header-secret-value|wrong-token-presented|note-text-secret|operations-token|authorization|\?limit|secret=/i);
    const requests = f.records().filter((record) => record.event === 'request');
    assert.equal(requests.length, 4);
    const first = requests[0]!;
    assert.equal(first.method, 'GET'); assert.equal(first.route, '/v1/jobs/:jobId'); assert.equal(first.status, 200);
    assert.match(String(first.request_id), /^[0-9a-f-]{36}$/); assert.equal(typeof first.duration_ms, 'number');
    const denied = f.records().find((record) => record.event === 'auth_rejected')!;
    assert.equal(denied.presented, 'bearer'); assert.equal(requests[1]!.status, 401); assert.equal(requests[1]!.route, '/v1/queue');
    assert.equal(requests[2]!.route, 'unmatched'); assert.equal(requests[2]!.status, 404);
    assert.equal(requests[3]!.status, 400);
    assert.equal(f.records().filter((record) => record.event === 'request_error').length, 1);
  } finally { await f.app.close(); }
});

test('mutations write audit lines with job id, issue key and actor label, never note text', async () => {
  const f = await loggedController({}, { get: async (jobId) => job(Number(jobId.slice(-12)), { state: jobId === id(5) ? 'READY_FOR_HUMAN' : 'QUEUED' }) });
  try {
    const headers = { ...auth, 'x-autos-operator': 'deep@laptop' };
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { issue_key: 'SAMPLE-9', dry_run: true, notes: [{ instructions: 'private-note-body' }] } })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'POST', url: `/v1/jobs/${id(5)}/revisions`, headers, payload: { instructions: 'revise-private-text', roles: ['swe', 'qa'] } })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'POST', url: `/v1/jobs/${id(3)}/cancel`, headers: auth })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, 'x-autos-operator': 'bad label!' }, payload: { issue_key: 'SAMPLE-9' } })).statusCode, 400);
    const text = f.lines.join('\n');
    assert.doesNotMatch(text, /private-note-body|revise-private-text/);
    const audits = f.records().filter((record) => record.event === 'audit');
    assert.deepEqual(audits.map((record) => record.action), ['job_submit', 'job_revise', 'job_cancel']);
    assert.equal(audits[0]!.actor, 'deep@laptop'); assert.equal(audits[0]!.issue_key, 'SAMPLE-9'); assert.equal(audits[0]!.job_id, id(1));
    assert.equal(audits[1]!.parent_job_id, id(5)); assert.deepEqual(audits[1]!.roles, ['swe', 'qa']);
    assert.equal(audits[2]!.actor, 'operator'); assert.equal(audits[2]!.job_id, id(3));
  } finally { await f.app.close(); }
});

// ---- 4. retry --all-blocked ----

test('retryBlockedJobs retries only the newest blocked attempt per issue and honors the code filter', async () => {
  const jobs: JobRecord[] = [
    job(1, { state: 'BLOCKED', blocked_code: 'UPSTREAM', created_at: '2026-11-07T10:00:00.000Z' }),
    job(2, { issue_key: 'SAMPLE-1', state: 'BLOCKED', blocked_code: 'UPSTREAM', created_at: '2026-11-07T11:00:00.000Z' }), // newer blocked attempt of SAMPLE-1
    job(3, { state: 'BLOCKED', blocked_code: 'CHECK_FAILED', created_at: '2026-11-07T09:00:00.000Z' }),
    job(4, { state: 'BLOCKED', blocked_code: 'UPSTREAM', created_at: '2026-11-07T08:00:00.000Z' }), // SAMPLE-4 already has a newer attempt
    job(5, { issue_key: 'SAMPLE-4', state: 'QUEUED', created_at: '2026-11-07T08:30:00.000Z' }),
    job(6, { state: 'READY_FOR_HUMAN' }),
    job(7, { state: 'BLOCKED', blocked_code: 'UPSTREAM', created_at: '2026-11-07T07:00:00.000Z' }), // retry throws
  ];
  const retried: string[] = [];
  const workflow = { list: async (limit: number, offset?: number) => jobs.slice(offset ?? 0, (offset ?? 0) + limit), retry: async (jobId: string) => { if (jobId === id(7)) throw new AutosError('CONFLICT', 'busy'); retried.push(jobId); return job(100 + Number(jobId.slice(-2))); } };
  const all = await retryBlockedJobs(workflow);
  assert.deepEqual({ matched: all.matched, retried: all.retried, skipped: all.skipped_newer_attempt, failed: all.failed }, { matched: 5, retried: 2, skipped: 2, failed: 1 });
  assert.deepEqual(retried, [id(2), id(3)]);
  retried.length = 0;
  const upstream = await retryBlockedJobs(workflow, { code: 'CHECK_FAILED' });
  assert.deepEqual({ matched: upstream.matched, retried: upstream.retried }, { matched: 1, retried: 1 }); assert.deepEqual(retried, [id(3)]);
});

test('POST /v1/jobs/retry-blocked validates the code, audits, and starts at most max_parallel executions', async () => {
  const blocked = [job(1, { state: 'BLOCKED', blocked_code: 'UPSTREAM' }), job(2, { state: 'BLOCKED', blocked_code: 'UPSTREAM' }), job(3, { state: 'BLOCKED', blocked_code: 'POLICY' })];
  const executed: string[] = [];
  const f = await loggedController({}, {
    list: async (limit, offset) => blocked.slice(offset ?? 0, (offset ?? 0) + limit),
    retry: async (jobId) => job(Number(jobId.slice(-12)) + 10, { issue_key: `SAMPLE-${Number(jobId.slice(-12))}` }),
    execute: async (jobId) => { executed.push(jobId); return job(1, { state: 'PLANNED' }); },
  });
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/jobs/retry-blocked', headers: auth, payload: { code: 'NOT_A_CODE' } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/jobs/retry-blocked' })).statusCode, 401);
    const response = await f.app.inject({ method: 'POST', url: '/v1/jobs/retry-blocked', headers: auth, payload: { code: 'UPSTREAM' } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual({ matched: body.matched, retried: body.retried, skipped: body.skipped_newer_attempt, failed: body.failed }, { matched: 2, retried: 2, skipped: 0, failed: 0 });
    assert.equal(body.jobs.length, 2);
    await tick(); await tick();
    assert.equal(executed.length, 1, 'only max_parallel (1) executions are started; the drain loop runs the rest');
    const audits = f.records().filter((record) => record.event === 'audit').map((record) => record.action);
    assert.deepEqual(audits, ['jobs_retry_blocked', 'job_retry', 'job_retry']);
    const empty = await f.app.inject({ method: 'POST', url: '/v1/jobs/retry-blocked', headers: auth, payload: {} });
    assert.equal(empty.statusCode, 200); assert.equal(empty.json().matched, 3);
  } finally { await f.app.close(); }
});

// ---- CLI fixtures ----

type FakeRuntime = CliRuntime & { calls: string[] };
function cliRuntime(config: AutosConfig, extra: Partial<CliRuntime> = {}, workflowOverrides: Partial<WorkflowServicePort> = {}): FakeRuntime {
  const calls: string[] = [];
  const { workflow } = fakeWorkflow(workflowOverrides);
  return {
    calls, config, workflow, providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => { calls.push('close'); },
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new AutosError('NOT_FOUND', 'none'); } }, ...extra,
  };
}
async function withConfig<T>(mutate: (config: Record<string, any>, dir: string) => void, run: (path: string, dir: string, config: AutosConfig) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autos-ops-'));
  try {
    const raw = parseConfigYaml(canonical) as unknown as Record<string, any>;
    const doc = JSON.parse(JSON.stringify(raw)) as Record<string, any>;
    mutate(doc, dir);
    const path = join(dir, 'autos.yaml'); await writeFile(path, stringify(doc));
    return await run(path, dir, parseConfigYaml(stringify(doc)));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const quietDeps = (extra: CliDependencies): { deps: CliDependencies; out: string[]; err: string[] } => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, deps: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), ...extra } };
};

test('autos retry --all-blocked [--code] prints counts, validates usage, and queues without executing', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const blocked = [job(1, { state: 'BLOCKED', blocked_code: 'UPSTREAM', created_at: '2026-11-07T10:00:00.000Z' }), job(2, { state: 'BLOCKED', blocked_code: 'TIMEOUT', created_at: '2026-11-07T09:00:00.000Z' })];
    const fake = cliRuntime(config, {}, { list: async (limit, offset) => blocked.slice(offset ?? 0, (offset ?? 0) + limit), retry: async (jobId) => job(50, { issue_key: jobId }), execute: async () => { throw new Error('must not execute locally'); } });
    const run = quietDeps({ cwd: dir, runtime: async () => fake, env: {} });
    assert.equal(await main(['--config', path, 'retry', '--all-blocked'], run.deps), 0);
    assert.match(run.out[0]!, /matched 2.*retried 2, skipped \(newer attempt exists\) 0, failed 0/);
    run.out.length = 0;
    assert.equal(await main(['--config', path, '--json', 'retry', '--all-blocked', '--code', 'TIMEOUT'], run.deps), 0);
    const result = JSON.parse(run.out[0]!); assert.deepEqual([result.matched, result.retried], [1, 1]);
    assert.equal(await main(['--config', path, 'retry', '--all-blocked', '--code', 'nope'], run.deps), 2);
    assert.equal(await main(['--config', path, 'retry', '--all-blocked', '--bogus'], run.deps), 2);
  });
});

// ---- 5. status ----

test('status shows auto_poll, last discovery, and a prominent runner WARN', () => {
  const activity = monitorPort().activityValue;
  const status = (poll_loop: Partial<LoopStatus>, runner: Parameters<typeof formatStatus>[0]['runner']) => formatStatus({ controller: { version: '0.1.0', started_at: now, uptime_s: 5, poll_interval_s: 300, poll_loop: { running: true, next_poll_at: null, consecutive_failures: 0, auto_poll: true, last_discovery_at: null, ...poll_loop } }, runner, activity, active_jobs: [] });
  const off = status({ auto_poll: false }, { status: 'unreachable' });
  assert.match(off.split('\n')[0]!, /^WARN runner not available \(unreachable\)/);
  assert.match(off, /Auto poll: OFF \(only submitted jobs run/); assert.match(off, /Runner: WARN unreachable/);
  const on = status({ last_discovery_at: '2026-11-07T12:00:00.000Z' }, { status: 'ready', version: 1, docker: 'available' });
  assert.doesNotMatch(on, /WARN/); assert.match(on, /Auto poll: ON {2}last discovery 2026-11-07T12:00:00.000Z/);
  assert.match(status({}, { status: 'ready', version: 1, docker: 'unavailable' }), /^WARN runner not available \(docker unavailable\)/);
  assert.match(status({}, { status: 'unknown' }), /^WARN runner not available \(unknown\)/);
});

// ---- 3. doctor ----

test('doctor in supervisor mode does not fail on missing controller-PATH provider binaries', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const host = quietDeps({ cwd: dir, env: { PATH: '' } });
    assert.equal(await main(['--config', path, '--json', 'doctor'], host.deps), 1); // host mode: env refs and binaries missing
    const compose = quietDeps({ cwd: dir, env: { PATH: '', AUTOS_CONTAINER_BIND_HOST: '0.0.0.0', [config.jira.username_env]: 'u', [config.jira.token_env]: 't', [config.confluence.username_env]: 'u', [config.confluence.token_env]: 't', [config.api.operator_token_env]: TOKEN } });
    assert.equal(await main(['--config', path, '--json', 'doctor'], compose.deps), 0);
    const result = JSON.parse(compose.out[0]!);
    assert.equal(result.provider_checks, 'supervisor');
    assert.ok(result.providers.every((provider: { checked: string }) => provider.checked === 'checked via supervisor: run providers test --all'));
    assert.ok(result.warnings.some((warning: string) => warning.includes('checked via supervisor: run providers test --all')));
  });
});

function deepSetup(overrides: Partial<Pick<CliRuntime, 'runnerHealth' | 'diagnostics' | 'projects'>> = {}) {
  const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: now } };
  const resolved: string[] = [];
  const extra: Partial<CliRuntime> = {
    runnerHealth: async () => ({ status: 'ready', version: 1, docker: 'available' }),
    projects: async () => [mapping],
    diagnostics: { jiraFilter: async () => ({ matching_issues: 7 }), resolveBase: async (repository, project) => { resolved.push(`${repository.workspace}/${repository.repository_slug}:${project.project_key}`); return { base_sha: 'a'.repeat(40), development_branch: project.development_branch }; } },
    ...overrides,
  };
  return { extra, resolved };
}

test('doctor --deep reports every check PASS with safe messages, and uses read-only diagnostics once', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const dataDir = join(dir, 'data'); await mkdir(dataDir, { recursive: true });
    const socket = createServer(); await new Promise<void>((resolve) => socket.listen(join(dataDir, 'runner.sock'), resolve));
    const secrets = join(dir, 'git'); await mkdir(secrets); const askpass = join(secrets, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\n'); await chmod(askpass, 0o755); await writeFile(join(secrets, 'bitbucket-token'), 'super-secret-token-value');
    try {
      const { extra, resolved } = deepSetup();
      const fake = cliRuntime(config, extra);
      const env = { PATH: '', AUTOS_CONTAINER_BIND_HOST: '0.0.0.0', AUTOS_GIT_ASKPASS_PATH: askpass, [config.jira.username_env]: 'u', [config.jira.token_env]: 't', [config.confluence.username_env]: 'u', [config.confluence.token_env]: 't', [config.api.operator_token_env]: TOKEN };
      const run = quietDeps({ cwd: dir, runtime: async () => fake, env, deepDoctor: { freeBytes: async () => 50 * 1024 ** 3 } });
      assert.equal(await main(['--config', path, '--json', 'doctor', '--deep'], run.deps), 0);
      const text = run.out.join('\n'); assert.doesNotMatch(text, /super-secret-token-value/);
      const checks = JSON.parse(text).deep_checks as Array<{ name: string; status: string; message: string }>;
      const by = (name: string) => checks.find((check) => check.name === name)!;
      assert.equal(by('supervisor_socket').status, 'PASS'); assert.equal(by('runner_health').status, 'PASS');
      assert.equal(by('runner_images').status, 'WARN');
      assert.equal(by('git_credentials').status, 'PASS');
      assert.match(by('jira_filter').message, /matches 7 issue/);
      assert.match(by('confluence_branch_map').message, /1 project mapping\(s\), 1 enabled/);
      assert.equal(by('base_branch:example/sample-app:SAMPLE').status, 'PASS'); assert.match(by('base_branch:example/sample-app:SAMPLE').message, /develop at a{12}$/);
      assert.deepEqual(resolved, ['example/sample-app:SAMPLE']);
      assert.deepEqual(['disk:data', 'disk:artifacts', 'disk:workspaces'].map((name) => by(name).status), ['PASS', 'PASS', 'PASS']);
      // Text mode prints status lines.
      const textRun = quietDeps({ cwd: dir, runtime: async () => fake, env, deepDoctor: { freeBytes: async () => 5 * 1024 ** 3 } });
      assert.equal(await main(['--config', path, 'doctor', '--deep'], textRun.deps), 0);
      assert.ok(textRun.out.some((line) => /^PASS supervisor_socket: /.test(line))); assert.ok(textRun.out.some((line) => /^WARN disk:data: 5\.0 GiB free \(below 10\.0 GiB/.test(line)));
    } finally { await new Promise((resolve) => socket.close(resolve)); }
  });
});

test('doctor --deep reports provider auth modes from supervisor health', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const env = { PATH: '', AUTOS_CONTAINER_BIND_HOST: '0.0.0.0', [config.jira.username_env]: 'u', [config.jira.token_env]: 't', [config.confluence.username_env]: 'u', [config.confluence.token_env]: 't', [config.api.operator_token_env]: TOKEN };
    const providers = ['claude', 'codex', 'cursor'] as const;
    const run = async (auth: Array<{ provider: typeof providers[number]; mode: 'subscription' | 'api' | 'local' }> | undefined) => {
      const health = { status: 'ready' as const, version: 1 as const, docker: 'available' as const, require_subscription: true, ...(auth ? { auth: auth.map((entry) => ({ ...entry, profile: config.providers[entry.provider].auth_profile })) } : {}) };
      const { extra } = deepSetup({ runnerHealth: async () => health });
      const r = quietDeps({ cwd: dir, runtime: async () => cliRuntime(config, extra), env, deepDoctor: { freeBytes: async () => 100 * 1024 ** 3 } });
      await main(['--config', path, '--json', 'doctor', '--deep'], r.deps);
      return (JSON.parse(r.out.join('\n')).deep_checks as Array<{ name: string; status: string; message: string }>).find((check) => check.name === 'provider_auth')!;
    };
    const all = await run(providers.map((provider) => ({ provider, mode: 'subscription' })));
    assert.equal(all.status, 'PASS'); assert.match(all.message, /claude=subscription, codex=subscription, cursor=subscription \(require_subscription=true\)/);
    const mixed = await run([{ provider: 'claude', mode: 'subscription' }, { provider: 'codex', mode: 'api' }, { provider: 'cursor', mode: 'subscription' }]);
    assert.equal(mixed.status, 'WARN'); assert.match(mixed.message, /codex bill per token/);
    const missing = await run([{ provider: 'claude', mode: 'subscription' }]);
    assert.equal(missing.status, 'WARN'); assert.match(missing.message, /no profile entry for codex:/);
    assert.equal((await run(undefined)).status, 'WARN');
  });
});

test('doctor --deep exits non-zero on FAIL and never leaks upstream text or tokens', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const { extra } = deepSetup({
      runnerHealth: async () => ({ status: 'ready', version: 1, docker: 'unavailable' }),
      diagnostics: { jiraFilter: async () => { throw new AutosError('AUTH', 'Basic dXNlcjpzZWNyZXQ= rejected by https://x.atlassian.net'); }, resolveBase: async () => { throw new AutosError('UPSTREAM', 'fatal: https://x-token-auth:abc123@bitbucket.org/example failed'); } },
    });
    const fake = cliRuntime(config, extra);
    const env = { PATH: '', AUTOS_CONTAINER_BIND_HOST: '0.0.0.0', AUTOS_GIT_ASKPASS_PATH: join(dir, 'missing-askpass.sh'), [config.jira.username_env]: 'u', [config.jira.token_env]: 't', [config.confluence.username_env]: 'u', [config.confluence.token_env]: 't', [config.api.operator_token_env]: TOKEN };
    const run = quietDeps({ cwd: dir, runtime: async () => fake, env, deepDoctor: { freeBytes: async (p) => { if (p.endsWith('workspaces')) throw new Error('boom'); return 1024 ** 3; } } });
    assert.equal(await main(['--config', path, '--json', 'doctor', '--deep'], run.deps), 1);
    const text = run.out.join('\n'); assert.doesNotMatch(text, /dXNlcjpzZWNyZXQ|atlassian\.net|abc123|bitbucket\.org\/example/);
    const checks = JSON.parse(text).deep_checks as Array<{ name: string; status: string; message: string }>;
    const by = (name: string) => checks.find((check) => check.name === name)!;
    assert.equal(by('supervisor_socket').status, 'FAIL'); assert.equal(by('runner_health').status, 'FAIL');
    assert.equal(by('git_credentials').status, 'FAIL');
    assert.equal(by('jira_filter').status, 'FAIL'); assert.match(by('jira_filter').message, /\(AUTH\)/);
    assert.equal(by('base_branch:example/sample-app:SAMPLE').status, 'FAIL'); assert.match(by('base_branch:example/sample-app:SAMPLE').message, /\(UPSTREAM\)/);
    assert.equal(by('disk:data').status, 'WARN'); assert.equal(by('disk:workspaces').status, 'WARN');
  });
});

test('doctor --deep reports runtime construction failure as FAIL without crashing', async () => {
  await withConfig(() => undefined, async (path, dir, config) => {
    const env = { PATH: '', AUTOS_CONTAINER_BIND_HOST: '0.0.0.0', [config.jira.username_env]: 'u', [config.jira.token_env]: 't', [config.confluence.username_env]: 'u', [config.confluence.token_env]: 't', [config.api.operator_token_env]: TOKEN };
    const run = quietDeps({ cwd: dir, runtime: async () => { throw new AutosError('INVALID_CONFIG', 'bad https://secret@host'); }, env, deepDoctor: { freeBytes: async () => 100 * 1024 ** 3 } });
    assert.equal(await main(['--config', path, '--json', 'doctor', '--deep'], run.deps), 1);
    const text = run.out.join('\n'); assert.doesNotMatch(text, /secret@host/);
    const checks = JSON.parse(text).deep_checks as Array<{ name: string; status: string; message: string }>;
    assert.match(checks.find((check) => check.name === 'runner_health')!.message, /INVALID_CONFIG/);
    assert.equal(checks.find((check) => check.name === 'jira_filter')!.status, 'FAIL');
  });
});
