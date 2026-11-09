import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AutosError, parseConfigYaml, type JobRecord, type OperatorNoteRequest, type WorkflowServicePort } from '@autos/contracts';
import { createController, safeJob, type ControllerOptions } from '../../apps/controller/src/index.js';
import { main } from '../../apps/cli/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const TOKEN = 'revision-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET_NOTE = 'ZEBRA-MARKER handle the empty list';
const parent: JobRecord = { job_id: PARENT, issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'READY_FOR_HUMAN', dry_run: true, repair_round: 0, created_at: now, updated_at: now, base_branch: 'develop' };
const child = { ...parent, job_id: CHILD, state: 'QUEUED', parent_job_id: PARENT, revision: 1 } as JobRecord;

function setup(reviseImpl?: WorkflowServicePort['revise']) {
  const monitor = monitorPort([makeEvent(1, { job_id: CHILD })]);
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const executed: string[] = [];
  const stderrLines: string[] = [];
  let childState: JobRecord['state'] = 'QUEUED';
  const workflow: WorkflowServicePort = {
    submit: async (...args) => { calls.push({ kind: 'submit', args }); return { ...child, parent_job_id: undefined, revision: undefined } as unknown as JobRecord; },
    revise: reviseImpl ?? (async (...args) => { calls.push({ kind: 'revise', args }); return child; }),
    execute: async (id) => { executed.push(id); childState = 'READY_FOR_HUMAN'; monitor.emit(makeEvent(2, { job_id: CHILD, type: 'job_finished', state: 'READY_FOR_HUMAN' })); return { ...child, state: 'READY_FOR_HUMAN' }; },
    cancel: async () => parent, retry: async () => parent, poll: async () => undefined, list: async () => [parent],
    get: async (id) => id === PARENT ? parent : id === CHILD ? { ...child, state: childState } : null,
    ...monitor,
  };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, sseHeartbeatMs: 40, runnerHealthTimeoutMs: 100,
    onBackgroundFailure: (event) => stderrLines.push(JSON.stringify(event)),
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
  };
  return { options, calls, executed, monitor, stderrLines };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const post = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = auth, id = PARENT) => app.inject({ method: 'POST', url: `/v1/jobs/${id}/revisions`, headers, payload: payload as object });

test('revisions route requires the bearer token', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    assert.equal((await post(app, { instructions: 'x' }, {})).statusCode, 401);
    assert.equal((await post(app, { instructions: 'x' }, { authorization: 'Bearer wrong-token-wrong-token' })).statusCode, 401);
    assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('revision returns 202 with parent/revision, defaults the author, and starts background execution', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const response = await post(app, { instructions: SECRET_NOTE, roles: ['swe', 'qa'] });
    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.equal(body.job_id, CHILD); assert.equal(body.parent_job_id, PARENT); assert.equal(body.revision, 1); assert.equal(body.state, 'QUEUED');
    assert.doesNotMatch(response.body, /ZEBRA/);
    await tick();
    assert.deepEqual(f.executed, [CHILD]);
    assert.deepEqual(f.calls[0]!.args, [PARENT, { instructions: SECRET_NOTE, roles: ['swe', 'qa'] }, 'operator']);
    const defaulted = await post(app, { instructions: 'plain' }, { ...auth, 'x-autos-operator': 'alice@example.com' });
    assert.equal(defaulted.statusCode, 202);
    assert.deepEqual(f.calls[1]!.args, [PARENT, { instructions: 'plain', roles: ['swe'] }, 'alice@example.com']);
    assert.equal((await post(app, { instructions: 'x' }, { ...auth, 'x-autos-operator': 'bad label!' })).statusCode, 400);
    assert.equal(f.calls.length, 2);
  } finally { await app.close(); }
});

test('revision validation rejects empty, oversized, unknown roles, and extra fields without echoing input', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const bad: unknown[] = [
      { instructions: '' }, { instructions: '   ' }, { instructions: 'x'.repeat(4001) }, { instructions: 'ok', roles: ['admin'] },
      { instructions: 'ok', roles: [] }, { instructions: 'ok', extra: SECRET_NOTE }, { roles: ['swe'] }, { instructions: 'ok', roles: ['swe', 'swe'] },
    ];
    for (const payload of bad) {
      const response = await post(app, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 60));
      assert.equal(response.json().code, 'INVALID_INPUT'); assert.doesNotMatch(response.body, /ZEBRA|xxxx/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await post(app, { instructions: 'x'.repeat(4000) })).statusCode, 202);
  } finally { await app.close(); }
});

test('revision maps unknown job to 404 and workflow rejection to 409 without leaking the note', async () => {
  const f = setup(async () => { throw new AutosError('CONFLICT', `not latest ${SECRET_NOTE}`); }); const app = await createController(f.options);
  try {
    const missing = await post(app, { instructions: SECRET_NOTE }, auth, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'NOT_FOUND'); assert.doesNotMatch(missing.body, /ZEBRA/);
    const conflict = await post(app, { instructions: SECRET_NOTE });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'CONFLICT'); assert.doesNotMatch(conflict.body, /ZEBRA/);
    await tick(); assert.deepEqual(f.executed, []);
  } finally { await app.close(); }
});

test('notes never appear in job output, events, or background-failure logs', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    await post(app, { instructions: SECRET_NOTE }); await tick();
    for (const url of [`/v1/jobs/${CHILD}`, `/v1/jobs/${CHILD}/events`, '/v1/events', '/v1/queue']) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      assert.equal(response.statusCode, 200, url); assert.doesNotMatch(response.body, /ZEBRA/, url);
    }
    assert.equal(JSON.stringify(safeJob(child)).includes('ZEBRA'), false);
    const shown = safeJob(child) as JobRecord & { parent_job_id?: string; revision?: number }; assert.equal(shown.parent_job_id, PARENT); assert.equal(shown.revision, 1);
    assert.equal(f.stderrLines.join('').includes('ZEBRA'), false);
  } finally { await app.close(); }
});

test('POST /v1/jobs passes optional notes to submit and rejects invalid or excess notes', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const notes: OperatorNoteRequest[] = [{ instructions: 'one' }, { instructions: 'two', roles: ['qa'] }];
    const ok = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1', dry_run: true, notes } });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(f.calls[0]!.args, ['SAMPLE-1', true, [{ instructions: 'one', roles: ['swe'] }, { instructions: 'two', roles: ['qa'] }]]);
    await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1' } });
    assert.equal(f.calls[1]!.args.length, 2);
    for (const bad of [Array.from({ length: 6 }, () => ({ instructions: 'n' })), [{ instructions: '' }], [{ instructions: 'x', roles: ['root'] }], [{ instructions: 'x', other: 1 }]]) {
      const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-1', notes: bad } });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(f.calls.length, 2);
  } finally { await app.close(); }
});

// ---- CLI ----

async function withCli<T>(reviseImpl: WorkflowServicePort['revise'] | undefined, run: (ctx: { f: ReturnType<typeof setup>; env: NodeJS.ProcessEnv; configPath: string; dir: string; base: string }) => Promise<T>): Promise<T> {
  const f = setup(reviseImpl); const app = await createController(f.options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-revise-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    return await run({ f, env: { [config.api.operator_token_env]: TOKEN }, configPath, dir, base: `http://127.0.0.1:${port}` });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('autos revise posts to the running controller, supports --note-file and --roles, and prints the new job', async () => {
  await withCli(undefined, async ({ f, env, configPath, dir }) => {
    const out: string[] = []; const err: string[] = [];
    const deps = { cwd: dir, env, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
    await writeFile(join(dir, 'note.txt'), 'from file\n');
    assert.equal(await main(['--config', configPath, '--json', 'revise', PARENT, '--note', 'inline', '--note-file', 'note.txt', '--roles', 'swe,reviewer'], deps), 0);
    const printed = JSON.parse(out.join('\n'));
    assert.equal(printed.job_id, CHILD); assert.equal(printed.parent_job_id, PARENT);
    assert.deepEqual(f.calls[0]!.args, [PARENT, { instructions: 'inline\n\nfrom file', roles: ['swe', 'reviewer'] }, 'operator']);
    assert.doesNotMatch(out.join('') + err.join(''), /inline|from file|revision-token/);
    await tick(); assert.deepEqual(f.executed, [CHILD]);
  });
});

test('autos revise validates arguments locally and maps controller errors', async () => {
  await withCli(async () => { throw new AutosError('CONFLICT', 'nope'); }, async ({ f, env, configPath, dir }) => {
    const err: string[] = []; const deps = { cwd: dir, env, stdout: () => undefined, stderr: (l: string) => err.push(l) };
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(4001)); await writeFile(join(dir, 'empty.txt'), '  \n');
    const run = (...args: string[]) => main(['--config', configPath, 'revise', ...args], deps);
    assert.equal(await run('not-a-uuid', '--note', 'x'), 2);
    assert.equal(await run(PARENT), 2);
    assert.equal(await run(PARENT, '--note', ''), 2);
    assert.equal(await run(PARENT, '--note', 'x'.repeat(4001)), 2);
    assert.equal(await run(PARENT, '--note', 'x', '--roles', 'swe,admin'), 2);
    assert.equal(await run(PARENT, '--note', 'x', '--roles', 'swe,swe'), 2);
    assert.equal(await run(PARENT, '--note-file', 'big.txt'), 2);
    assert.equal(await run(PARENT, '--note-file', 'empty.txt'), 2);
    assert.equal(await run(PARENT, '--note-file', 'missing.txt'), 2);
    assert.equal(await run(PARENT, '--note', 'x', '--bogus', 'y'), 2);
    assert.equal(f.calls.length, 0);
    err.length = 0;
    assert.equal(await run(PARENT, '--note', 'x'), 1);
    assert.match(err[0]!, /CONFLICT/);
    assert.equal(await main(['--config', configPath, 'revise', PARENT, '--note', 'x'], { ...deps, env: {} }), 1);
    assert.match(err.at(-1)!, /INVALID_CONFIG/);
    assert.equal(await main(['--config', configPath, 'revise', PARENT, '--note', 'x'], { ...deps, env: { [config.api.operator_token_env]: 'wrong-token-wrong-token' } }), 1);
    assert.match(err.at(-1)!, /AUTH/);
  });
});

test('autos revise --wait follows the new job and exits 0 only on READY_FOR_HUMAN', async () => {
  await withCli(undefined, async ({ env, configPath, dir }) => {
    const out: string[] = [];
    assert.equal(await main(['--config', configPath, 'revise', PARENT, '--note', 'x', '--wait'], { cwd: dir, env, stdout: (l) => out.push(l), stderr: () => undefined, reconnectDelayMs: 10 }), 0);
    assert.match(out.join('\n'), /job_finished .*state=READY_FOR_HUMAN/); assert.match(out.join('\n'), /READY_FOR_HUMAN/);
  });
  // A blocked outcome exits non-zero.
  const blocked = setup(); const original = blocked.options.workflow.execute;
  blocked.options.workflow.execute = async (id, signal) => { await original(id, signal); blocked.monitor.store[blocked.monitor.store.length - 1] = makeEvent(2, { job_id: CHILD, type: 'job_finished', state: 'BLOCKED' }); return { ...child, state: 'BLOCKED' }; };
  blocked.options.workflow.get = async (id) => id === PARENT ? parent : { ...child, state: 'BLOCKED' };
  const app = await createController(blocked.options); await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-revise-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    assert.equal(await main(['--config', configPath, '--json', 'revise', PARENT, '--note', 'x', '--wait'], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: () => undefined, stderr: () => undefined, reconnectDelayMs: 10 }), 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('autos run --note passes repeatable notes to submit and enforces the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-run-note-'));
  try {
    const path = join(dir, 'autos.yaml'); await writeFile(path, canonical);
    const submitted: unknown[][] = [];
    const base = monitorPort();
    const queued: JobRecord = { ...parent, state: 'QUEUED' };
    const runtime = {
      config,
      workflow: { submit: async (...args: unknown[]) => { submitted.push(args); return queued; }, revise: async () => queued, execute: async () => ({ ...queued, state: 'PLANNED' }), cancel: async () => queued, retry: async () => queued, get: async () => queued, list: async () => [queued], poll: async () => undefined, ...base },
      artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
      providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
    };
    const deps = { cwd: dir, env: {}, runtime: async () => runtime as never, stdout: () => undefined, stderr: () => undefined };
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-1', '--dry-run', '--note', 'first', '--note', 'second'], deps), 0);
    assert.deepEqual(submitted[0], ['SAMPLE-1', true, [{ instructions: 'first' }, { instructions: 'second' }]]);
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-1'], deps), 0);
    assert.equal(submitted[1]!.length, 2);
    const six = Array.from({ length: 6 }, (_, i) => ['--note', `n${i}`]).flat();
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-1', ...six], deps), 2);
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-1', '--note'], deps), 2);
    assert.equal(submitted.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
