import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutosConfig, ArtifactManifest, JobRecord, ProjectMapping } from '@autos/contracts';
import { AutosError, parseConfigYaml } from '@autos/contracts';
import { readFile } from 'node:fs/promises';
import { createController, createDocsPreview, generateOpenApi, type ControllerOptions } from '../../apps/controller/src/index.js';
import type { WorkflowServicePort } from '@autos/contracts';
import { makeEvent, monitorPort } from './monitor-fake.js';

const config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
const now = '2026-11-07T12:00:00.000Z';
const job: JobRecord = { job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'QUEUED', dry_run: true, repair_round: 0, created_at: now, updated_at: now };
const manifest: ArtifactManifest = { schema_version: 1, job_id: job.job_id, issue_key: job.issue_key, status: job.state, candidate_digest: null, base_sha: null, commit_sha: null, feature_branch: null, push_status: 'NOT_ATTEMPTED', files: [] };

function fixture() {
  const calls: string[] = [];
  const submittedDryRuns: boolean[] = [];
  const listCalls: Array<{ limit: number; offset?: number }> = [];
  const secondJob: JobRecord = { ...job, job_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', issue_key: 'SAMPLE-2' };
  const jobs = [job, secondJob];
  let jobState: JobRecord | null = { ...job };
  let executeResolve: (() => void) | undefined;
  const monitor = monitorPort([makeEvent(1), makeEvent(2, { type: 'role_finished', outcome: 'SUCCEEDED' }), makeEvent(3, { job_id: null, issue_key: null, type: 'poll_finished', count: 2, stage: undefined, role: undefined, provider: undefined, repair_round: undefined })]);
  const workflow: WorkflowServicePort = {
    submit: async (_key, dryRun) => { calls.push('submit'); submittedDryRuns.push(dryRun); return { ...job, dry_run: dryRun }; },
    execute: async (_id, signal) => { calls.push('execute'); await new Promise<void>((resolve) => { executeResolve = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); }); return { ...job, state: 'PLANNED' }; },
    cancel: async () => { calls.push('cancel'); return { ...job, state: 'CANCELLED' }; },
    retry: async () => ({ ...job }),
    revise: async () => ({ ...job }),
    get: async () => jobState,
    list: async (limit, offset) => { listCalls.push({ limit, ...(offset === undefined ? {} : { offset }) }); return jobs.slice(offset ?? 0, (offset ?? 0) + limit); },
    poll: async () => undefined,
    ...monitor,
  };
  const options: ControllerOptions = { config, workflow, operatorToken: 'test-token-that-is-long-enough', artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'prompt', transcript_path: 'transcript' }), manifest: async () => manifest }, providers: async () => [], projects: async (): Promise<ProjectMapping[]> => [], testProviders: async () => [], close: async () => undefined };
  return { options, monitor, calls, submittedDryRuns, listCalls, setJob: (value: JobRecord | null) => { jobState = value; }, finish: () => executeResolve?.() };
}

test('health is minimal and public; operator routes require bearer auth', async () => {
  const f = fixture(); const app = await createController(f.options);
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200); assert.deepEqual(health.json(), { status: 'ok' });
    const denied = await app.inject({ method: 'GET', url: '/v1/queue', headers: { 'x-request-id': 'secret-token-like-untrusted-id' } });
    assert.equal(denied.statusCode, 401); assert.match(denied.json().request_id, /^[0-9a-f-]{36}$/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/not-a-route' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/queue', headers: { authorization: 'Bearer test-token-that-is-long-enough' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/queue?limit=1000', headers: { authorization: 'Bearer test-token-that-is-long-enough' } })).statusCode, 400);
    const unknown = await app.inject({ method: 'GET', url: '/v1/not-a-route', headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(unknown.statusCode, 404); assert.equal(unknown.json().code, 'NOT_FOUND');
  } finally { f.finish(); await app.close(); }
});

test('job submit responds 202 and starts one background execution; cancel aborts it', async () => {
  const f = fixture(); const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: 'Bearer test-token-that-is-long-enough' }, payload: { issue_key: 'SAMPLE-1', dry_run: true } });
    assert.equal(response.statusCode, 202); assert.equal(response.json().state, 'QUEUED');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, ['submit', 'execute']);
    const canceled = await app.inject({ method: 'POST', url: `/v1/jobs/${job.job_id}/cancel`, headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(canceled.statusCode, 200); assert.equal(canceled.json().state, 'CANCELLED');
  } finally { f.finish(); await app.close(); }
});

test('queue cursor forwards bounded SQL offset and returns the next cursor', async () => {
  const f = fixture(); const app = await createController(f.options);
  try {
    const first = await app.inject({ method: 'GET', url: '/v1/jobs?limit=1', headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(first.statusCode, 200); assert.deepEqual(first.json().jobs.map((item: { issue_key: string }) => item.issue_key), ['SAMPLE-1']);
    assert.equal(first.json().next_cursor, '1');
    const second = await app.inject({ method: 'GET', url: '/v1/jobs?limit=1&cursor=1', headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(second.statusCode, 200); assert.deepEqual(second.json().jobs.map((item: { issue_key: string }) => item.issue_key), ['SAMPLE-2']);
    assert.equal(second.json().next_cursor, null);
    assert.deepEqual(f.listCalls, [{ limit: 2, offset: 0 }, { limit: 2, offset: 1 }]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/jobs?cursor=1000000', headers: { authorization: 'Bearer test-token-that-is-long-enough' } })).statusCode, 400);
  } finally { await app.close(); }
});

test('missing jobs and artifacts return stable safe errors; manifest omits bodies', async () => {
  const f = fixture(); const app = await createController(f.options);
  try {
    const artifacts = await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}/artifacts`, headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(artifacts.statusCode, 200); assert.deepEqual(artifacts.json().files, []); assert.equal(JSON.stringify(artifacts.json()).includes('source'), false);
    f.setJob(null);
    const missing = await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}`, headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'NOT_FOUND');
  } finally { await app.close(); }
});

test('upstream exception details and operator tokens are never returned', async () => {
  const f = fixture();
  f.options.providers = async () => { throw new Error('upstream body AUTOS_TOKEN=do-not-leak'); };
  const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json().code, 'INTERNAL');
    assert.equal(response.body.includes('do-not-leak'), false);
    assert.equal(response.body.includes('test-token-that-is-long-enough'), false);
  } finally { await app.close(); }
});

test('background execution failures are visible through a safe event after HTTP 202', async () => {
  const f = fixture(); const failures: Array<{ job_id: string; code: string }> = [];
  f.options.onBackgroundFailure = (event) => failures.push(event);
  f.options.workflow.execute = async () => { throw new Error('token=must-not-be-logged'); };
  const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: 'Bearer test-token-that-is-long-enough' }, payload: { issue_key: 'SAMPLE-1' } });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(f.submittedDryRuns, [true]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, [{ job_id: job.job_id, code: 'INTERNAL' }]);
  } finally { f.finish(); await app.close(); }
});

test('generated OpenAPI includes authenticated operators and PLANNED', async () => {
  const f = fixture(); const spec = await generateOpenApi(f.options);
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.servers, [{ url: 'http://127.0.0.1:8787', description: 'Local controller' }]);
  const paths = spec.paths as Record<string, Record<string, { security?: unknown[]; summary?: string; operationId?: string; responses?: Record<string, unknown> }>>;
  assert.ok(paths['/v1/jobs']); assert.ok(paths['/health']);
  assert.deepEqual(paths['/v1/queue']?.get?.security, [{ bearerAuth: [] }]);
  assert.deepEqual(paths['/health']?.get?.security, []);
  const operationIds = Object.values(paths).flatMap((path) => Object.values(path).map((operation) => {
    assert.ok(operation.summary); assert.ok(operation.operationId); return operation.operationId;
  }));
  assert.equal(new Set(operationIds).size, operationIds.length);
  const expectedErrors = ['400', '401', '403', '404', '409', '422', '429', '500'];
  for (const [path, methods] of Object.entries(paths)) if (path.startsWith('/v1/')) for (const operation of Object.values(methods)) {
    for (const status of expectedErrors) assert.ok(operation.responses?.[status], `${path} must document ${status}`);
  }
  const serialized = JSON.stringify(spec); assert.ok(serialized.includes('PLANNED')); assert.ok(serialized.includes('SAMPLE-123')); assert.ok(serialized.includes('dry_run'));
});

test('docs preview serves a local reference and OpenAPI without exposing controller routes', async () => {
  const f = fixture(); const app = await createDocsPreview(f.options);
  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /swagger-ui/);
    assert.doesNotMatch(page.body, /https:\/\/cdn\./);
    const specResponse = await app.inject({ method: 'GET', url: '/json' });
    assert.equal(specResponse.statusCode, 200);
    assert.equal(specResponse.json().openapi, '3.1.0');
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 404);
  } finally { await app.close(); }
});

test('job details expose operator fields and push outcome, scrubbed of paths, URLs, and tokens', async () => {
  const f = fixture();
  f.setJob({ ...job, state: 'BLOCKED', repository_id: 'repo-1', base_sha: 'a'.repeat(40), repair_round: 2, blocked_code: 'CHECK_FAILED', feature_branch: 'deep/SAMPLE-1', commit_sha: 'c'.repeat(40),
    blocked_reason: 'failed in /var/lib/autos/workspaces/x/File.java via https://u:p@host.example/repo?token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
  const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}`, headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.state, 'BLOCKED'); assert.equal(body.repair_round, 2); assert.equal(body.feature_branch, 'deep/SAMPLE-1'); assert.equal(body.push_status, 'NOT_ATTEMPTED');
    assert.doesNotMatch(response.body, /\/var\/lib|host\.example|ABCDEFGH|u:p@/);
  } finally { await app.close(); }
});

test('a queued job that loses the claim to the poll loop is deferred silently, not reported as a failure', async () => {
  const f = fixture(); const failures: unknown[] = [];
  f.options.onBackgroundFailure = (event) => failures.push(event);
  f.options.workflow.execute = async () => { throw new AutosError('CONFLICT', 'Another workflow job is active'); };
  const app = await createController(f.options);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: 'Bearer test-token-that-is-long-enough' }, payload: { issue_key: 'SAMPLE-1' } })).statusCode, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, []);
  } finally { await app.close(); }
});

test('cancel of an unknown job returns a stable 404 with a request id', async () => {
  const f = fixture(); f.setJob(null); const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/jobs/${job.job_id}/cancel`, headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
    assert.equal(response.statusCode, 404); assert.match(response.json().request_id, /^[0-9a-f-]{36}$/);
  } finally { await app.close(); }
});

test('a job that loses the claim while the previous job settles runs afterwards without any poll', async () => {
  const f = fixture(); const auth = { authorization: 'Bearer test-token-that-is-long-enough' };
  const jobA = { ...job, job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', issue_key: 'SAMPLE-1' };
  const jobB = { ...job, job_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', issue_key: 'SAMPLE-2' };
  const executed: string[] = []; let polls = 0; let releaseA!: () => void; let leaseHeld = true; let bAttempts = 0;
  const submitQueue = [jobA, jobB];
  f.options.workflow.submit = async () => submitQueue.shift()!;
  f.options.workflow.poll = async () => { polls++; };
  f.options.workflow.get = async (id) => (id === jobB.job_id ? { ...jobB, state: executed.includes(id) ? 'PLANNED' : 'QUEUED' } : jobA);
  f.options.workflow.execute = async (id) => {
    if (id === jobA.job_id) {
      executed.push(id);
      await new Promise<void>((resolve) => { releaseA = resolve; });
      leaseHeld = false; // terminal in the database but the lease is released only after A resolves its work
      return { ...jobA, state: 'PLANNED' };
    }
    bAttempts++;
    if (leaseHeld) throw new AutosError('CONFLICT', 'Another workflow job is active');
    executed.push(id);
    return { ...jobB, state: 'PLANNED' };
  };
  const app = await createController(f.options);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1' } })).statusCode, 202);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-2' } })).statusCode, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bAttempts, 1); assert.deepEqual(executed, [jobA.job_id]);
    releaseA();
    for (let i = 0; i < 50 && !executed.includes(jobB.job_id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(executed, [jobA.job_id, jobB.job_id]); assert.equal(polls, 0);
  } finally { await app.close(); }
});

test('a deferred job cancelled before the retry does not run', async () => {
  const f = fixture(); const auth = { authorization: 'Bearer test-token-that-is-long-enough' };
  let attempts = 0;
  f.options.workflow.execute = async () => { attempts++; throw new AutosError('CONFLICT', 'Another workflow job is active'); };
  const app = await createController(f.options);
  try {
    await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    f.setJob({ ...job, state: 'CANCELLED' });
    assert.equal((await app.inject({ method: 'POST', url: `/v1/jobs/${job.job_id}/cancel`, headers: auth })).statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(attempts, 1);
  } finally { await app.close(); }
});

test('deferred jobs are retried in FIFO order, up to the free slots, when a slot frees', async () => {
  const f = fixture(); const auth = { authorization: 'Bearer test-token-that-is-long-enough' };
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
  const jobs = ids.map((id, i) => ({ ...job, job_id: id, issue_key: `SAMPLE-${i + 1}` }));
  const submitQueue = [...jobs]; const started: string[] = []; const releases = new Map<string, () => void>(); let inUse = 0; const maxParallel = 2;
  f.options.workflow.submit = async () => submitQueue.shift()!;
  f.options.workflow.get = async (id) => ({ ...jobs.find((j) => j.job_id === id)!, state: 'QUEUED' });
  f.options.workflow.execute = async (id) => {
    if (inUse >= maxParallel) throw new AutosError('CONFLICT', 'No free slot');
    inUse++; started.push(id);
    await new Promise<void>((resolve) => { releases.set(id, resolve); });
    inUse--;
    return { ...jobs.find((j) => j.job_id === id)!, state: 'PLANNED' };
  };
  const app = await createController(f.options);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    for (let i = 1; i <= 4; i++) assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: `SAMPLE-${i}` } })).statusCode, 202);
    await settle();
    assert.deepEqual(started, [ids[0], ids[1]]);
    // Free both slots at once: two deferred jobs start concurrently, a further one would stay deferred.
    releases.get(ids[0]!)!(); releases.get(ids[1]!)!();
    for (let i = 0; i < 100 && started.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(started, ids);
    assert.equal(inUse, 2);
    releases.get(ids[2]!)!(); releases.get(ids[3]!)!(); await settle();
  } finally { for (const release of releases.values()) release(); await app.close(); }
});

test('two deferred jobs start concurrently when two slots are free and the third stays deferred until another frees', async () => {
  const f = fixture(); const auth = { authorization: 'Bearer test-token-that-is-long-enough' };
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
  const jobs = ids.map((id, i) => ({ ...job, job_id: id, issue_key: `SAMPLE-${i + 1}` }));
  const submitQueue = [...jobs]; const started: string[] = []; const releases = new Map<string, () => void>(); let inUse = 0; let capacity = 1;
  f.options.workflow.submit = async () => submitQueue.shift()!;
  f.options.workflow.get = async (id) => ({ ...jobs.find((j) => j.job_id === id)!, state: 'QUEUED' });
  f.options.workflow.execute = async (id) => {
    if (inUse >= capacity) throw new AutosError('CONFLICT', 'No free slot');
    inUse++; started.push(id);
    await new Promise<void>((resolve) => { releases.set(id, resolve); });
    inUse--;
    return { ...jobs.find((j) => j.job_id === id)!, state: 'PLANNED' };
  };
  const app = await createController(f.options);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
  try {
    for (let i = 1; i <= 4; i++) await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: `SAMPLE-${i}` } });
    await settle();
    assert.deepEqual(started, [ids[0]]); // B, C, D deferred behind the single slot
    capacity = 2; releases.get(ids[0]!)!(); // A settles: B and C are retried in FIFO order and run together
    await until(() => started.length >= 3); await settle();
    assert.deepEqual(started, [ids[0], ids[1], ids[2]]); assert.equal(inUse, 2);
    releases.get(ids[1]!)!(); // a slot frees: D finally starts
    await until(() => started.length >= 4);
    assert.deepEqual(started, ids);
    for (const id of ids.slice(2)) releases.get(id)?.(); await settle();
  } finally { for (const release of releases.values()) release(); await app.close(); }
});
