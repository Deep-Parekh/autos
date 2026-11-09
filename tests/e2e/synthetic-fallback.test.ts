// Per-role provider fallbacks end to end: REAL adapters over fake provider executables, real workflow/GitRunner,
// controller HTTP. Failures are injected through a behaviour file the harness keeps outside the workspace (never via
// ticket text) or by pointing a binary at a missing path. Fakes are not provider certification.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createController, createRuntime } from '@autos/controller';
import { createSyntheticScenario, type SyntheticScenarioOptions } from '../fixtures/synthetic/index.js';

const token = 'synthetic-operator-token-0123456789';
const auth = { authorization: `Bearer ${token}` };
const terminal = new Set(['PLANNED', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED']);
type Job = { job_id: string; state: string; blocked_code?: string };
type Attempt = { role: string; provider: string; chain_index: number; status: string; error_code: string | null; fell_back: boolean };
type Event = { type: string; provider?: string; from_provider?: string; code?: string; role?: string };

async function run(options: SyntheticScenarioOptions) {
  const scenario = await createSyntheticScenario(options);
  const runtime = await createRuntime(scenario.runtimeOptions);
  const app = await createController({ ...runtime, operatorToken: token });
  try {
    const queued = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-123', dry_run: false } });
    assert.equal(queued.statusCode, 202, queued.body);
    const id = (queued.json() as Job).job_id;
    let job: Job;
    for (const deadline = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 100))) {
      job = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: auth })).json() as Job;
      if (terminal.has(job.state)) break;
      assert.ok(Date.now() < deadline, `stuck in ${job.state}`);
    }
    const events = ((await app.inject({ method: 'GET', url: `/v1/events?job_id=${id}&limit=500`, headers: auth })).json() as { events: Event[] }).events;
    const jobDirectory = join(runtime.config.storage.artifacts_dir, id);
    const rounds = JSON.parse(await readFile(join(jobDirectory, 'rounds.json'), 'utf8')) as { rounds: Array<{ provider_attempts?: Attempt[] }> };
    const attempts = rounds.rounds.flatMap((round) => round.provider_attempts ?? []);
    const summary = await readFile(join(jobDirectory, 'summary.md'), 'utf8');
    const invocations = (await scenario.providerInvocations()).map((entry) => `${entry.role}:${entry.provider}`);
    return { scenario, job, events, attempts, summary, invocations, workspace: scenario.workspaces.get(id)?.directory };
  } finally { await app.close(); await runtime.close(); }
}
// RATE_LIMIT and UPSTREAM are retryable: the workflow retries the same provider (3 spawns in total, fresh session each)
// before it moves down the chain. Non-retryable codes (UNAVAILABLE, INVALID_OUTPUT) fall back immediately.
const times = (n: number, entry: string) => Array<string>(n).fill(entry);
const fallbackEvents = (events: Event[]) => events.filter((event) => event.type === 'provider_fallback').map((event) => `${event.role}:${event.from_provider}->${event.provider}:${event.code}`);

test('(a) SWE primary with a missing binary falls back to codex with an untouched workspace', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { swe: { provider: 'claude', fallbacks: ['codex'] } }, missingBinaries: ['claude'] });
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    assert.deepEqual(r.invocations, ['swe:codex', 'qa:codex', 'reviewer:cursor'], 'the missing claude binary never spawned a process');
    assert.deepEqual(fallbackEvents(r.events), ['swe:claude->codex:UNAVAILABLE']);
    assert.deepEqual(r.attempts.filter((a) => a.role === 'swe').map((a) => [a.provider, a.chain_index, a.status, a.error_code, a.fell_back]), [['claude', 0, 'FAILED', 'UNAVAILABLE', true], ['codex', 1, 'SUCCEEDED', null, false]]);
    assert.match(r.summary, /SWE: codex \(fallback after claude UNAVAILABLE\)/);
  } finally { await r.scenario.cleanup(); }
});

test('(b) rate-limited QA primary falls back to claude and the fallback is visible in events, rounds and summary', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { qa: { provider: 'codex', fallbacks: ['claude'] } }, providerBehavior: { codex: { qa: 'rate_limit' } } });
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    assert.deepEqual(r.invocations, ['swe:claude', ...times(3, 'qa:codex'), 'qa:claude', 'reviewer:cursor'], 'exact provider order (retryable rate limit retried before fallback)');
    assert.deepEqual(fallbackEvents(r.events), ['qa:codex->claude:RATE_LIMIT']);
    const qa = r.attempts.filter((a) => a.role === 'qa');
    assert.deepEqual(qa.map((a) => [a.provider, a.status, a.error_code, a.fell_back]), [['codex', 'FAILED', 'RATE_LIMIT', true], ['claude', 'SUCCEEDED', null, false]]);
    assert.match(r.summary, /QA: claude \(fallback after codex RATE_LIMIT\)/);
  } finally { await r.scenario.cleanup(); }
});

test('(c) SWE that edited the workspace and then hit an upstream error continues with a handoff (retries, then codex)', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { swe: { provider: 'claude', fallbacks: ['codex'] } }, providerBehavior: { claude: { swe: 'edit_then_upstream' } } });
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    // UPSTREAM is retryable (3 claude spawns) and a handoff code: codex then continues from the partial work.
    assert.deepEqual(r.invocations, [...times(3, 'swe:claude'), 'swe:codex', 'qa:codex', 'reviewer:cursor']);
    assert.deepEqual(fallbackEvents(r.events), ['swe:claude->codex:UPSTREAM']);
    assert.deepEqual(r.attempts.filter((a) => a.role === 'swe').map((a) => [a.provider, a.error_code, a.fell_back]), [['claude', 'UPSTREAM', true], ['codex', null, false]]);
    assert.deepEqual((await r.scenario.sweActions()).map((a) => [a.provider, a.action]), [['claude', 'partial'], ['claude', 'partial'], ['claude', 'partial'], ['codex', 'completed_pending']]);
  } finally { await r.scenario.cleanup(); }
});

test('(c2) AUTH after SWE edits still blocks: no fallback, codex never invoked', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { swe: { provider: 'claude', fallbacks: ['codex'] } }, providerBehavior: { claude: { swe: 'edit_then_auth' } } });
  try {
    assert.equal(r.job.state, 'BLOCKED', JSON.stringify(r.job));
    assert.equal(r.job.blocked_code, 'AUTH');
    assert.deepEqual(r.invocations, ['swe:claude']);
    assert.deepEqual(fallbackEvents(r.events), []);
    assert.deepEqual(r.attempts.filter((a) => a.role === 'swe').map((a) => [a.provider, a.error_code, a.fell_back]), [['claude', 'AUTH', false]]);
    assert.ok((await readFile(join(r.workspace!, 'src/main/java/example/tasks/TaskService.java'), 'utf8')).includes('task.setStatus("RESOLVED");'), 'the partial edit is still in the workspace');
  } finally { await r.scenario.cleanup(); }
});

test('(d) reviewer cursor emitting malformed output falls back to claude; cursor always ran with --model auto', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { reviewer: { provider: 'cursor', fallbacks: ['claude'] } }, providerBehavior: { cursor: { reviewer: 'malformed' } } });
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    assert.deepEqual(r.invocations, ['swe:claude', 'qa:codex', 'reviewer:cursor', 'reviewer:claude']);
    assert.deepEqual(fallbackEvents(r.events), ['reviewer:cursor->claude:INVALID_OUTPUT']);
    assert.match(r.summary, /Reviewer: claude \(fallback after cursor INVALID_OUTPUT\)/);
    const cursor = (await r.scenario.providerInvocations()).find((entry) => entry.provider === 'cursor')!;
    assert.deepEqual(cursor.argv.slice(cursor.argv.indexOf('--model'), cursor.argv.indexOf('--model') + 2), ['--model', 'auto']);
  } finally { await r.scenario.cleanup(); }
});

test('(e) a chain where every provider fails with a non-capacity mix blocks with the last code and records all attempts', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { qa: { provider: 'codex', fallbacks: ['claude'] } }, providerBehavior: { codex: { qa: 'rate_limit' }, claude: { qa: 'auth' } } });
  try {
    assert.equal(r.job.state, 'BLOCKED', JSON.stringify(r.job));
    assert.equal(r.job.blocked_code, 'AUTH');
    assert.deepEqual(r.invocations, ['swe:claude', ...times(3, 'qa:codex'), 'qa:claude']);
    assert.deepEqual(r.attempts.filter((a) => a.role === 'qa').map((a) => [a.provider, a.chain_index, a.error_code, a.fell_back]), [['codex', 0, 'RATE_LIMIT', true], ['claude', 1, 'AUTH', false]]);
    assert.deepEqual(fallbackEvents(r.events), ['qa:codex->claude:RATE_LIMIT']);
    assert.ok(!r.invocations.includes('reviewer:cursor'), 'review never started');
  } finally { await r.scenario.cleanup(); }
});

test('(f) a QA chain limited at every provider pauses instead of blocking: visible in job, status and events, then cancellable', { timeout: 300_000 }, async () => {
  const scenario = await createSyntheticScenario({ roleChains: { qa: { provider: 'codex', fallbacks: ['claude'] } }, providerBehavior: { codex: { qa: 'rate_limit' }, claude: { qa: 'upstream' } } });
  const runtime = await createRuntime(scenario.runtimeOptions);
  const app = await createController({ ...runtime, operatorToken: token });
  try {
    const queued = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-123', dry_run: false } });
    const id = (queued.json() as Job).job_id;
    let job: Job & { resume_at?: string; paused_role?: string; pause_code?: string; base_sha?: string };
    for (const deadline = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 100))) {
      job = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: auth })).json() as typeof job;
      if (job.state === 'PAUSED' || terminal.has(job.state)) break;
      assert.ok(Date.now() < deadline, `stuck in ${job.state}`);
    }
    assert.equal(job.state, 'PAUSED', JSON.stringify(job));
    assert.equal(job.paused_role, 'qa'); assert.equal(job.pause_code, 'RATE_LIMIT'); assert.ok(job.resume_at && Date.parse(job.resume_at) > Date.now());
    const status = (await app.inject({ method: 'GET', url: '/v1/status', headers: auth })).json() as { activity: { slots: { in_use: number }; paused_jobs: Array<{ job_id: string; role: string }> } };
    assert.equal(status.activity.slots.in_use, 0); assert.deepEqual(status.activity.paused_jobs.map((p) => [p.job_id, p.role]), [[id, 'qa']]);
    const events = ((await app.inject({ method: 'GET', url: `/v1/events?job_id=${id}&limit=500`, headers: auth })).json() as { events: Array<Event & { resume_at?: string }> }).events;
    const paused = events.find((e) => e.type === 'job_paused'); assert.ok(paused?.resume_at); assert.equal(paused.code, 'RATE_LIMIT');
    const cancelled = await app.inject({ method: 'POST', url: `/v1/jobs/${id}/cancel`, headers: auth });
    assert.equal((cancelled.json() as Job).state, 'CANCELLED', cancelled.body);
  } finally { await app.close(); await runtime.close(); await scenario.cleanup(); }
});
