import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AutosError, parseConfigYaml, type CloseIssueResult, type JobRecord, type PruneWorkspacesResult, type WorkflowServicePort, type WorkspaceEntry } from '@autos/contracts';
import { createController, safeJob, type ControllerOptions } from '../../apps/controller/src/index.js';
import { formatEvent, main, type CliDependencies } from '../../apps/cli/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const TOKEN = 'closure-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const NOW_MS = Date.parse('2026-11-09T12:00:00.000Z');
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WS_A = `${JOB_A}-11111111-1111-4111-8111-111111111111`;
const WS_B = `${JOB_B}-22222222-2222-4222-8222-222222222222`;
const SECRET_NOTE = 'ZEBRA-MARKER landed after hotfix';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const jobA: JobRecord = { job_id: JOB_A, issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'BLOCKED', dry_run: false, repair_round: 0, created_at: '2026-11-07T10:00:00.000Z', updated_at: now };
const jobB: JobRecord = { ...jobA, job_id: JOB_B, state: 'READY_FOR_HUMAN', created_at: '2026-11-07T11:00:00.000Z', feature_branch: 'deep/SAMPLE-1', commit_sha: SHA, revision: 1 };
const closure = { issue_key: 'SAMPLE-1', resolution: 'MERGED' as const, closed_at: now, closed_by: 'operator', job_id: JOB_B, commit_sha: SHA, feature_branch: 'deep/SAMPLE-1' };
const entry = (name: string, jobId: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({ name, job_id: jobId, issue_key: 'SAMPLE-1', state: 'READY_FOR_HUMAN', closed_as: null, modified_at: '2026-11-07T12:00:00.000Z', size_bytes: null, removable: null, retained_because: 'awaiting_review', ...extra });
const closeResult = (dry: boolean, extra: Partial<CloseIssueResult> = {}): CloseIssueResult => ({ dry_run: dry, closure, removed: [entry(WS_A, JOB_A, { removable: 'closed', retained_because: null }), entry(WS_B, JOB_B, { removable: 'closed', retained_because: null })], failed: [], ...extra });

function setup(overrides: Partial<WorkflowServicePort> = {}) {
  const monitor = monitorPort([makeEvent(1, { job_id: JOB_B })]);
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const logs: string[] = [];
  const executed: string[] = [];
  const workflow: WorkflowServicePort = {
    ...monitor,
    submit: async () => jobA, execute: async (id) => { executed.push(id); return jobB; }, cancel: async () => jobA, retry: async () => jobA, poll: async () => undefined,
    revise: async (...args) => { calls.push({ kind: 'revise', args }); return { ...jobB, job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', state: 'QUEUED', parent_job_id: JOB_B } as JobRecord; },
    reviseIssue: async (...args) => { calls.push({ kind: 'reviseIssue', args }); return { ...jobB, job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', state: 'QUEUED', parent_job_id: JOB_B } as JobRecord; },
    closeIssue: async (...args) => { calls.push({ kind: 'closeIssue', args }); return closeResult((args[1] as { dry_run?: boolean }).dry_run === true); },
    closure: async (key) => key === 'SAMPLE-1' ? closure : null,
    workspaces: async (opts) => { calls.push({ kind: 'workspaces', args: [opts] }); return [entry(WS_A, JOB_A, { state: 'BLOCKED', removable: 'retention', retained_because: null, size_bytes: opts?.sizes ? 2048 : null }), entry(WS_B, JOB_B, { size_bytes: opts?.sizes ? 5 * 1024 * 1024 : null })]; },
    pruneWorkspaces: async (request) => { calls.push({ kind: 'prune', args: [request] }); return { dry_run: request.dry_run ?? false, removed: [entry(WS_A, JOB_A, { state: 'BLOCKED', removable: 'retention', retained_because: null, size_bytes: request.sizes ? 2048 : null })], failed: [], freed_bytes: request.sizes ? 2048 : null, remaining: 1 } satisfies PruneWorkspacesResult; },
    get: async (id) => id === JOB_A ? jobA : id === JOB_B ? jobB : null,
    list: async (limit, offset = 0) => [jobA, { ...jobB, closed_as: 'MERGED' as const }, { ...jobA, job_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', issue_key: 'OTHER-9' }].slice(offset, offset + limit),
    ...overrides,
  };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, sseHeartbeatMs: 40, runnerHealthTimeoutMs: 100,
    onBackgroundFailure: () => undefined, logStream: { write: (line) => logs.push(line) },
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
  };
  return { options, calls, logs, executed };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const post = (app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, headers, payload: payload as object });

// ---- API ----

test('all new routes require the bearer token', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    for (const [method, url, payload] of [['POST', '/v1/issues/SAMPLE-1/close', { resolution: 'MERGED' }], ['POST', '/v1/issues/SAMPLE-1/revisions', { instructions: 'x' }], ['GET', '/v1/issues/SAMPLE-1', undefined], ['GET', '/v1/workspaces', undefined], ['POST', '/v1/workspaces/prune', {}]] as const) {
      const none = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      assert.equal(none.statusCode, 401, url);
      const wrong = await app.inject({ method, url, headers: { authorization: 'Bearer wrong-token-wrong-token' }, ...(payload ? { payload } : {}) });
      assert.equal(wrong.statusCode, 401, url);
    }
    assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('POST /v1/issues/{key}/close passes request and author, returns the result, and never logs the note or paths', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const response = await post(app, '/v1/issues/SAMPLE-1/close', { resolution: 'MERGED', note: SECRET_NOTE }, { ...auth, 'x-autos-operator': 'alice@example.com' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.closure.resolution, 'MERGED'); assert.equal(body.removed.length, 2); assert.equal(body.removed[0].name, WS_A);
    assert.deepEqual(f.calls[0]!.args, ['SAMPLE-1', { resolution: 'MERGED', note: SECRET_NOTE, dry_run: false }, 'alice@example.com']);
    assert.doesNotMatch(response.body, /ZEBRA|\/workspaces\//);
    const dry = await post(app, '/v1/issues/SAMPLE-1/close', { resolution: 'ABANDONED', dry_run: true });
    assert.equal(dry.statusCode, 200); assert.deepEqual(f.calls[1]!.args, ['SAMPLE-1', { resolution: 'ABANDONED', dry_run: true }, 'operator']);
    const all = f.logs.join('');
    assert.doesNotMatch(all, /ZEBRA|closure-token/);
    assert.match(all, /"action":"issue_close"/); assert.match(all, /"actor":"alice@example.com"/);
  } finally { await app.close(); }
});

test('close validation rejects bad bodies, keys and labels with 400 and does not call the workflow', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const bad: unknown[] = [{}, { resolution: 'DONE' }, { resolution: 'merged' }, { resolution: 'MERGED', note: '' }, { resolution: 'MERGED', note: 'x'.repeat(2001) }, { resolution: 'MERGED', dry_run: 'yes' }, { resolution: 'MERGED', extra: 1 }];
    for (const payload of bad) {
      const response = await post(app, '/v1/issues/SAMPLE-1/close', payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload)); assert.equal(response.json().code, 'INVALID_INPUT');
    }
    assert.equal((await post(app, '/v1/issues/not-a-key/close', { resolution: 'MERGED' })).statusCode, 400);
    assert.equal((await post(app, '/v1/issues/SAMPLE-1/close', { resolution: 'MERGED' }, { ...auth, 'x-autos-operator': 'bad label!' })).statusCode, 400);
    assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('close maps workflow NOT_FOUND to 404 and CONFLICT to 409 without echoing the note', async () => {
  let failure: AutosError = new AutosError('NOT_FOUND', `no issue ${SECRET_NOTE}`);
  const f = setup({ closeIssue: async () => { throw failure; } }); const app = await createController(f.options);
  try {
    const missing = await post(app, '/v1/issues/SAMPLE-9/close', { resolution: 'ABANDONED', note: SECRET_NOTE });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'NOT_FOUND'); assert.doesNotMatch(missing.body, /ZEBRA/);
    failure = new AutosError('CONFLICT', `active ${SECRET_NOTE}`);
    const conflict = await post(app, '/v1/issues/SAMPLE-1/close', { resolution: 'ABANDONED', note: SECRET_NOTE });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'CONFLICT'); assert.doesNotMatch(conflict.body, /ZEBRA/);
    assert.doesNotMatch(f.logs.join(''), /ZEBRA/);
  } finally { await app.close(); }
});

test('POST /v1/issues/{key}/revisions uses reviseIssue, starts the queued job, and maps 404/409/400', async () => {
  let failure: AutosError | undefined;
  const base = setup(); const original = base.options.workflow.reviseIssue;
  base.options.workflow.reviseIssue = async (...args) => { if (failure) throw failure; return original(...args); };
  const app = await createController(base.options);
  try {
    const ok = await post(app, '/v1/issues/SAMPLE-1/revisions', { instructions: SECRET_NOTE, roles: ['swe', 'qa'] }, { ...auth, 'x-autos-operator': 'bob' });
    assert.equal(ok.statusCode, 202); assert.equal(ok.json().parent_job_id, JOB_B); assert.doesNotMatch(ok.body, /ZEBRA/);
    assert.deepEqual(base.calls[0]!.args, ['SAMPLE-1', { instructions: SECRET_NOTE, roles: ['swe', 'qa'] }, 'bob']);
    await tick(); assert.deepEqual(base.executed, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
    for (const bad of [{ instructions: '' }, { instructions: 'x', roles: ['admin'] }, { instructions: 'x', other: 1 }, {}]) assert.equal((await post(app, '/v1/issues/SAMPLE-1/revisions', bad)).statusCode, 400);
    assert.equal((await post(app, '/v1/issues/SAMPLE-1/revisions', { instructions: 'x' }, { ...auth, 'x-autos-operator': 'bad label!' })).statusCode, 400);
    failure = new AutosError('NOT_FOUND', 'none'); assert.equal((await post(app, '/v1/issues/SAMPLE-2/revisions', { instructions: SECRET_NOTE })).statusCode, 404);
    failure = new AutosError('CONFLICT', 'closed'); const conflict = await post(app, '/v1/issues/SAMPLE-1/revisions', { instructions: SECRET_NOTE });
    assert.equal(conflict.statusCode, 409); assert.doesNotMatch(conflict.body, /ZEBRA/);
    assert.doesNotMatch(base.logs.join(''), /ZEBRA/);
  } finally { await app.close(); }
});

test('GET /v1/issues/{key} returns closure and this issue\'s attempts newest first, with closed_as; 404 when unknown', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/issues/SAMPLE-1', headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.issue_key, 'SAMPLE-1'); assert.equal(body.closure.resolution, 'MERGED');
    assert.deepEqual(body.jobs.map((job: JobRecord) => job.job_id), [JOB_B, JOB_A]);
    assert.equal(body.jobs[0].closed_as, 'MERGED'); assert.equal(body.jobs[1].closed_as, undefined);
    const missing = await app.inject({ method: 'GET', url: '/v1/issues/NOPE-1', headers: auth });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'NOT_FOUND');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/issues/lowercase-1', headers: auth })).statusCode, 400);
    assert.equal(safeJob({ ...jobB, closed_as: 'ABANDONED' }).closed_as, 'ABANDONED');
  } finally { await app.close(); }
});

test('GET /v1/workspaces returns entries (names only) with the retention policy and honours sizes', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.retention_hours, config.jobs.workspace_retention_hours); assert.equal(body.auto_prune, config.jobs.auto_prune_workspaces);
    assert.equal(body.workspaces.length, 2); assert.equal(body.workspaces[0].size_bytes, null); assert.doesNotMatch(response.body, /\/workspaces|\\/);
    assert.deepEqual(f.calls[0]!.args, [{ sizes: false }]);
    const sized = await app.inject({ method: 'GET', url: '/v1/workspaces?sizes=true', headers: auth });
    assert.equal(sized.json().workspaces[0].size_bytes, 2048); assert.deepEqual(f.calls[1]!.args, [{ sizes: true }]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/workspaces?sizes=maybe', headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/workspaces?other=1', headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});

test('POST /v1/workspaces/prune validates the body, defaults fields, and audits counts only', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const ok = await post(app, '/v1/workspaces/prune', { dry_run: true, older_than_hours: 24, sizes: true });
    assert.equal(ok.statusCode, 200); assert.equal(ok.json().removed.length, 1); assert.equal(ok.json().freed_bytes, 2048); assert.equal(ok.json().remaining, 1);
    assert.deepEqual(f.calls[0]!.args, [{ dry_run: true, older_than_hours: 24, sizes: true }]);
    assert.equal((await post(app, '/v1/workspaces/prune', {})).statusCode, 200);
    assert.deepEqual(f.calls[1]!.args, [{ dry_run: false, sizes: false }]);
    for (const bad of [{ older_than_hours: -1 }, { older_than_hours: 2161 }, { older_than_hours: 1.5 }, { dry_run: 'x' }, { extra: true }]) assert.equal((await post(app, '/v1/workspaces/prune', bad)).statusCode, 400, JSON.stringify(bad));
    assert.equal(f.calls.length, 2);
    const logs = f.logs.join('');
    assert.match(logs, /"action":"workspaces_prune"/); assert.doesNotMatch(logs, new RegExp(WS_A));
  } finally { await app.close(); }
});

test('a workflow failure while pruning surfaces as a safe 500 without internals', async () => {
  const f = setup({ pruneWorkspaces: async () => { throw new Error('/secret/path token=abc'); } }); const app = await createController(f.options);
  try {
    const response = await post(app, '/v1/workspaces/prune', {});
    assert.equal(response.statusCode, 500); assert.doesNotMatch(response.body, /secret|token/); assert.doesNotMatch(f.logs.join(''), /secret|token=abc/);
  } finally { await app.close(); }
});

// ---- events ----

test('formatEvent renders issue_closed and workspaces_pruned sensibly', () => {
  assert.match(formatEvent(makeEvent(5, { type: 'issue_closed', outcome: 'MERGED', count: 2, role: undefined, provider: undefined, stage: undefined, repair_round: undefined })), /SAMPLE-1 issue closed as merged workspaces removed=2/);
  assert.match(formatEvent(makeEvent(6, { type: 'workspaces_pruned', job_id: null, issue_key: null, count: 3, role: undefined, provider: undefined, stage: undefined, repair_round: undefined })), /service workspaces pruned removed=3/);
});

// ---- CLI ----

async function withCli<T>(overrides: Partial<WorkflowServicePort>, run: (ctx: { f: ReturnType<typeof setup>; deps: CliDependencies; out: string[]; err: string[]; configPath: string }) => Promise<T>): Promise<T> {
  const f = setup(overrides); const app = await createController(f.options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-closure-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    const out: string[] = []; const err: string[] = [];
    const deps: CliDependencies = { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: (l) => out.push(l), stderr: (l) => err.push(l), now: () => NOW_MS, stdinIsTTY: false };
    return await run({ f, deps, out, err, configPath });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('autos close requires exactly one of --merged/--abandoned and a valid key', async () => {
  await withCli({}, async ({ f, deps, err, configPath }) => {
    const run = (...args: string[]) => main(['--config', configPath, 'close', ...args], deps);
    assert.equal(await run('SAMPLE-1', '--yes'), 2);
    assert.equal(await run('SAMPLE-1', '--merged', '--abandoned', '--yes'), 2);
    assert.equal(await run('bad', '--merged', '--yes'), 2);
    assert.equal(await run(), 2);
    assert.equal(await run('SAMPLE-1', '--merged', '--yes', '--bogus'), 2);
    assert.equal(await run('SAMPLE-1', '--merged', '--yes', '--note'), 2);
    assert.equal(await run('SAMPLE-1', '--merged', '--yes', '--note', '   '), 2);
    assert.equal(await run('SAMPLE-1', '--merged', '--merged', '--yes'), 2);
    assert.equal(f.calls.length, 0); assert.match(err[0]!, /Exactly one of --merged or --abandoned/);
  });
});

test('autos close refuses without --yes when stdin is not a terminal, and never calls the controller', async () => {
  await withCli({}, async ({ f, deps, err, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged'], deps), 2);
    assert.match(err[0]!, /--yes/); assert.equal(f.calls.length, 0);
  });
});

test('autos close --yes closes in one call and prints removed workspaces and the reminder; --json prints the result', async () => {
  await withCli({}, async ({ f, deps, out, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged', '--note', SECRET_NOTE, '--yes'], deps), 0);
    assert.deepEqual(f.calls.map((call) => call.kind), ['closeIssue']);
    assert.deepEqual(f.calls[0]!.args, ['SAMPLE-1', { resolution: 'MERGED', note: SECRET_NOTE, dry_run: false }, 'operator']);
    const text = out.join('\n');
    assert.match(text, /Closed SAMPLE-1 as MERGED/); assert.match(text, /Workspaces removed: 2 \(aaaaaaaa, bbbbbbbb\)/); assert.match(text, /deep\/SAMPLE-1/); assert.match(text, new RegExp(SHA));
    assert.match(text, /Artifacts \(evidence\) are kept/); assert.match(text, /Jira and Bitbucket were not changed/);
    assert.doesNotMatch(text, /ZEBRA/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'close', 'SAMPLE-1', '--abandoned', '--yes'], deps), 0);
    assert.equal(JSON.parse(out.join('\n')).closure.issue_key, 'SAMPLE-1');
  });
});

test('autos close --dry-run needs no confirmation and previews only', async () => {
  await withCli({}, async ({ f, deps, out, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--abandoned', '--dry-run'], deps), 0);
    assert.deepEqual(f.calls.map((call) => call.args[1]), [{ resolution: 'ABANDONED', dry_run: true }]);
    assert.match(out.join('\n'), /DRY RUN: nothing changed/); assert.match(out.join('\n'), /would be removed: 2/);
  });
});

test('autos close on a terminal previews with a dry run, asks, and only closes on y', async () => {
  await withCli({}, async ({ f, deps, out, configPath }) => {
    const questions: string[] = [];
    const tty = (answer: string): CliDependencies => ({ ...deps, stdinIsTTY: true, prompt: async (question) => { questions.push(question); return answer; } });
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged'], tty('n')), 1);
    assert.deepEqual(f.calls.map((call) => (call.args[1] as { dry_run: boolean }).dry_run), [true]);
    assert.match(out.join('\n'), /Aborted; nothing changed/); assert.match(questions[0]!, /cannot be undone.*\[y\/N\]/);
    out.length = 0; f.calls.length = 0;
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged'], tty('')), 1);
    assert.equal(f.calls.length, 1);
    f.calls.length = 0;
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged'], tty('y')), 0);
    assert.deepEqual(f.calls.map((call) => (call.args[1] as { dry_run: boolean }).dry_run), [true, false]);
  });
});

test('autos close exits 1 on removal failures and maps conflict/not-found errors', async () => {
  await withCli({ closeIssue: async () => closeResult(false, { failed: [{ name: WS_A, job_id: JOB_A, code: 'INTERNAL' }] }) }, async ({ deps, out, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged', '--yes'], deps), 1);
    assert.match(out.join('\n'), /could not be removed: 1 \(aaaaaaaa INTERNAL\)/);
  });
  await withCli({ closeIssue: async () => { throw new AutosError('CONFLICT', 'active'); } }, async ({ deps, err, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-1', '--merged', '--yes'], deps), 1); assert.match(err[0]!, /CONFLICT/);
  });
  await withCli({ closeIssue: async () => { throw new AutosError('NOT_FOUND', 'none'); } }, async ({ deps, err, configPath }) => {
    assert.equal(await main(['--config', configPath, 'close', 'SAMPLE-9', '--merged', '--yes'], deps), 1); assert.match(err[0]!, /NOT_FOUND/);
  });
});

test('autos revise resolves an issue key through the issue endpoint and a job id through the job endpoint', async () => {
  await withCli({}, async ({ f, deps, out, err, configPath }) => {
    assert.equal(await main(['--config', configPath, '--json', 'revise', 'SAMPLE-1', '--note', SECRET_NOTE, '--roles', 'swe,qa'], deps), 0);
    assert.deepEqual(f.calls[0], { kind: 'reviseIssue', args: ['SAMPLE-1', { instructions: SECRET_NOTE, roles: ['swe', 'qa'] }, 'operator'] });
    assert.equal(JSON.parse(out.join('\n')).parent_job_id, JOB_B);
    assert.equal(await main(['--config', configPath, '--json', 'revise', JOB_B, '--note', 'x'], deps), 0);
    assert.equal(f.calls[1]!.kind, 'revise'); assert.equal(f.calls[1]!.args[0], JOB_B);
    assert.equal(await main(['--config', configPath, 'revise', 'not-a-target', '--note', 'x'], deps), 2);
    assert.equal(await main(['--config', configPath, 'revise', 'SAMPLE-1'], deps), 2);
    assert.doesNotMatch(out.join('') + err.join(''), /ZEBRA/);
    assert.equal(f.calls.length, 2);
  });
});

test('autos show prints closure and an attempts table with the closed marker; --json prints the body', async () => {
  await withCli({}, async ({ deps, out, err, configPath }) => {
    assert.equal(await main(['--config', configPath, 'show', 'SAMPLE-1'], deps), 0);
    const text = out.join('\n');
    assert.match(text, /SAMPLE-1 closed as MERGED/); assert.match(text, /READY_FOR_HUMAN \(merged\)/); assert.match(text, /BLOCKED/); assert.match(text, new RegExp(JOB_B));
    assert.ok(text.indexOf(JOB_B) < text.indexOf(JOB_A.slice(0, 8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'newest attempt first');
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'show', 'SAMPLE-1'], deps), 0);
    assert.equal(JSON.parse(out.join('\n')).jobs.length, 2);
    assert.equal(await main(['--config', configPath, 'show', 'NOPE-1'], deps), 1); assert.match(err.at(-1)!, /NOT_FOUND/);
    assert.equal(await main(['--config', configPath, 'show', 'bad'], deps), 2);
  });
});

test('autos workspaces prints the table with age, size and decision; --sizes and --json work', async () => {
  await withCli({}, async ({ f, deps, out, configPath }) => {
    assert.equal(await main(['--config', configPath, 'workspaces'], deps), 0);
    const text = out.join('\n');
    assert.match(text, /WORKSPACE\s+ISSUE\s+STATE\s+AGE\s+SIZE\s+DECISION/);
    assert.match(text, /aaaaaaaa\s+SAMPLE-1\s+BLOCKED\s+2d00h\s+-\s+remove \(retention\)/);
    assert.match(text, /bbbbbbbb\s+SAMPLE-1\s+READY_FOR_HUMAN\s+2d00h\s+-\s+keep \(awaiting_review\)/);
    assert.match(text, /Retention: 72h/); assert.match(text, /auto-prune ON/);
    assert.doesNotMatch(text, new RegExp(WS_A));
    out.length = 0;
    assert.equal(await main(['--config', configPath, 'workspaces', '--sizes'], deps), 0);
    assert.match(out.join('\n'), /2\.0 KiB/); assert.match(out.join('\n'), /5\.0 MiB/);
    assert.deepEqual(f.calls.map((call) => call.args[0]), [{ sizes: false }, { sizes: true }]);
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'workspaces'], deps), 0);
    assert.equal(JSON.parse(out.join('\n')).workspaces.length, 2);
    assert.equal(await main(['--config', configPath, 'workspaces', '--bogus'], deps), 2);
  });
});

test('autos workspaces prune sends the right request, validates --older-than, and prints a summary', async () => {
  await withCli({}, async ({ f, deps, out, err, configPath }) => {
    assert.equal(await main(['--config', configPath, 'workspaces', 'prune', '--dry-run', '--older-than', '24', '--sizes'], deps), 0);
    assert.deepEqual(f.calls[0]!.args, [{ dry_run: true, sizes: true, older_than_hours: 24 }]);
    const text = out.join('\n');
    assert.match(text, /DRY RUN: nothing removed/); assert.match(text, /would be removed: 1 \(aaaaaaaa\)/); assert.match(text, /Would remain: 1 workspace directory; would free 2\.0 KiB/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, 'workspaces', 'prune'], deps), 0);
    assert.deepEqual(f.calls[1]!.args, [{ dry_run: false, sizes: false }]); assert.match(out.join('\n'), /Prune finished/);
    out.length = 0;
    assert.equal(await main(['--config', configPath, '--json', 'workspaces', 'prune', '--dry-run'], deps), 0);
    assert.equal(JSON.parse(out.join('\n')).remaining, 1);
    for (const bad of [['--older-than'], ['--older-than', 'abc'], ['--older-than', '2161'], ['--older-than', '-1'], ['--nope']]) assert.equal(await main(['--config', configPath, 'workspaces', 'prune', ...bad], deps), 2, bad.join(' '));
    assert.equal(f.calls.length, 3); assert.ok(err.length >= 5);
  });
  await withCli({ pruneWorkspaces: async () => ({ dry_run: false, removed: [], failed: [{ name: WS_A, job_id: JOB_A, code: 'INTERNAL' }], freed_bytes: null, remaining: 1 }) }, async ({ deps, configPath }) => {
    assert.equal(await main(['--config', configPath, 'workspaces', 'prune'], deps), 1);
  });
});

test('help documents the new commands', async () => {
  const out: string[] = [];
  assert.equal(await main(['--help'], { stdout: (l) => out.push(l), stderr: () => undefined }), 0);
  for (const text of [/close ISSUE-123 --merged\|--abandoned/, /show ISSUE-123/, /workspaces prune/, /revise JOB_ID\|ISSUE-123/]) assert.match(out[0]!, text);
});
