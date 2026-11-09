import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseConfigYaml, type JobRecord } from '@autos/contracts';
import { main, pollDelayMs, validateOpenApiFile, type CliDependencies, type CliRuntime } from '../../apps/cli/src/index.js';
import { generateOpenApi } from '../../apps/controller/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const now = '2026-11-07T12:00:00.000Z';
const queued: JobRecord = { job_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', issue_key: 'SAMPLE-123', repository_id: null, base_sha: null, state: 'QUEUED', dry_run: true, repair_round: 0, created_at: now, updated_at: now };

function runtime(): CliRuntime & { calls: string[] } {
  const calls: string[] = [];
  const item: CliRuntime & { calls: string[] } = {
    calls, config,
    workflow: {
      submit: async (key, dry) => { calls.push(`submit:${key}:${dry}`); return { ...queued, issue_key: key, dry_run: dry }; },
      execute: async (id) => { calls.push(`execute:${id}`); return { ...queued, state: 'PLANNED' }; },
      cancel: async () => ({ ...queued, state: 'CANCELLED' }), revise: async () => ({ ...queued }), retry: async (id) => { calls.push(`retry:${id}`); return { ...queued }; }, get: async () => queued, list: async () => [queued], poll: async () => undefined,
      ...monitorPort(),
    },
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'prompt', transcript_path: 'transcript' }), manifest: async () => ({ schema_version: 1, job_id: queued.job_id, issue_key: queued.issue_key, status: 'PLANNED', candidate_digest: null, base_sha: null, commit_sha: null, feature_branch: null, push_status: 'NOT_ATTEMPTED', files: [] }) },
    providers: async () => [], projects: async () => [], testProviders: async () => { calls.push('testProviders'); return (['claude', 'codex', 'cursor'] as const).map((provider) => ({ provider, binary_present: true, authenticated: true, read_only_smoke: 'PASS' as const, message: 'read-only smoke passed' })); }, close: async () => { calls.push('close'); },
  };
  return item;
}

test('help and version work without configuration', async () => {
  const output: string[] = [];
  assert.equal(await main(['--help'], { stdout: (line) => output.push(line), stderr: () => undefined }), 0);
  assert.match(output[0]!, /controller start/);
  output.length = 0;
  assert.equal(await main(['--version'], { stdout: (line) => output.push(line), stderr: () => undefined }), 0);
  assert.equal(output[0], '0.1.0');
});

test('init safely writes canonical example once and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-cli-'));
  try {
    const path = join(dir, 'nested', 'autos.yaml'); const out: string[] = []; const err: string[] = [];
    assert.equal(await main(['init', '--config', path], { cwd: process.cwd(), stdout: (line) => out.push(line), stderr: (line) => err.push(line) }), 0);
    assert.equal(await readFile(path, 'utf8'), canonical);
    assert.equal(await main(['init', '--config', path], { cwd: process.cwd(), stdout: () => undefined, stderr: (line) => err.push(line) }), 1);
    assert.match(err.at(-1)!, /does not overwrite/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manual run submits once and executes only that job; doctor does not invoke providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-cli-'));
  try {
    const path = join(dir, 'autos.yaml'); await writeFile(path, canonical);
    const fake = runtime(); const output: string[] = [];
    const dependencies: CliDependencies = { cwd: dir, runtime: async () => fake, stdout: (line) => output.push(line), stderr: () => undefined, env: {} };
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-123', '--dry-run', '--json'], dependencies), 0);
    assert.deepEqual(fake.calls.slice(0, 2), ['submit:SAMPLE-123:true', `execute:${queued.job_id}`]);
    assert.ok(fake.calls.includes('close'));
    output.length = 0;
    assert.equal(await main(['doctor', '--config', path, '--json'], dependencies), 1);
    assert.match(output[0]!, /"read_only_smoke": "NOT_RUN"/);
    assert.equal(fake.calls.filter((x) => x.startsWith('submit:')).length, 1);
    assert.equal(fake.calls.includes('testProviders'), false);
    assert.equal(await main(['providers', 'test', '--all', '--config', path], dependencies), 0);
    assert.equal(fake.calls.includes('testProviders'), true);
    fake.calls.length = 0;
    assert.equal(await main(['retry', queued.job_id, '--config', path], dependencies), 0);
    assert.deepEqual(fake.calls.slice(0, 2), [`retry:${queued.job_id}`, `execute:${queued.job_id}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('docs validation loads the generated contract and reports drift', async () => {
  const fake = runtime();
  const options = { ...fake, operatorToken: 'validation-token-not-used' };
  const spec = await generateOpenApi(options);
  const dir = await mkdtemp(join(tmpdir(), 'autos-openapi-'));
  try {
    const path = join(dir, 'openapi.yaml');
    await writeFile(path, stringify(spec));
    assert.deepEqual(await validateOpenApiFile({ config: fake.config, path }), { valid: true, message: 'OpenAPI contract matches generated route schemas' });
    await writeFile(path, 'openapi: 3.0.0\n');
    assert.equal((await validateOpenApiFile({ config: fake.config, path })).valid, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('docs commands work without pilot config, credentials, or service construction', async () => {
  const output: string[] = [];
  const dependencies: CliDependencies = { cwd: process.cwd(), stdout: (line) => output.push(line), stderr: () => undefined, runtime: async () => { throw new Error('runtime must not be constructed for docs'); } };
  assert.equal(await main(['docs', 'validate', '--json'], dependencies), 0);
  assert.match(output[0]!, /"valid": true/);
});

const blocked: JobRecord = { ...queued, state: 'BLOCKED', dry_run: false, repository_id: 'repo-1', base_sha: 'a'.repeat(40), repair_round: 2, blocked_code: 'CHECK_FAILED', blocked_reason: 'checks failed in /Users/me/work/space/file.java at https://user:secret@example.com/x?token=abcdefghijklmnopqrstuvwxyz0123456789', feature_branch: 'deep/SAMPLE-123' };

test('run exits non-zero for BLOCKED with sanitized concise JSON; jobs show/cancel use the workflow service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-cli-'));
  try {
    const path = join(dir, 'autos.yaml'); await writeFile(path, canonical);
    const fake = runtime(); const output: string[] = [];
    fake.workflow.execute = async () => blocked;
    fake.workflow.get = async () => ({ ...blocked, state: 'READY_FOR_HUMAN', commit_sha: 'b'.repeat(40) });
    fake.workflow.cancel = async (id) => { fake.calls.push(`cancel:${id}`); return { ...blocked, state: 'CANCELLED' }; };
    const dependencies: CliDependencies = { cwd: dir, runtime: async () => fake, stdout: (line) => output.push(line), stderr: () => undefined, env: {} };
    assert.equal(await main(['--config', path, 'run', 'SAMPLE-123', '--json'], dependencies), 1);
    const text = output.join('\n');
    const parsed = JSON.parse(text);
    assert.equal(parsed.state, 'BLOCKED'); assert.equal(parsed.repair_round, 2); assert.equal(parsed.feature_branch, 'deep/SAMPLE-123'); assert.equal(parsed.push_status, 'NOT_ATTEMPTED');
    assert.doesNotMatch(text, /secret|abcdefghijklmnop|\/Users\/me|example\.com/);
    output.length = 0;
    assert.equal(await main(['--config', path, 'jobs', 'show', queued.job_id, '--json'], dependencies), 0);
    assert.equal(JSON.parse(output[0]!).commit_sha, 'b'.repeat(40));
    output.length = 0;
    assert.equal(await main(['--config', path, 'jobs', 'cancel', queued.job_id, '--json'], dependencies), 0);
    assert.equal(JSON.parse(output[0]!).state, 'CANCELLED'); assert.ok(fake.calls.includes(`cancel:${queued.job_id}`));
    assert.equal(await main(['--config', path, 'jobs', 'show', 'not-a-uuid'], { ...dependencies, stderr: () => undefined }), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('poll delay backs off per failure and stays bounded', () => {
  assert.equal(pollDelayMs(60, 0), 60_000); assert.equal(pollDelayMs(60, 1), 60_000); assert.equal(pollDelayMs(60, 2), 120_000);
  assert.equal(pollDelayMs(60, 50), 300_000); assert.equal(pollDelayMs(600, 5), 2_400_000);
});

test('controller start binds loopback, discovers with backoff, serves HTTP, and shuts down on abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-cli-'));
  try {
    const path = join(dir, 'autos.yaml'); await writeFile(path, canonical);
    const fake = runtime(); const stop = new AbortController(); const delays: number[] = []; const errors: string[] = [];
    fake.config = { ...config, jira: { ...config.jira, auto_poll: true }, api: { ...config.api, port: 0 } };
    let discoveries = 0; let aborted = false; let address: { host: string; port: number } | undefined;
    fake.workflow.discover = async (signal) => {
      discoveries++;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      if (discoveries <= 2) throw new Error('upstream down with secret-value');
      if (discoveries === 3) {
        const response = await fetch(`http://127.0.0.1:${address!.port}/v1/queue`, { headers: { authorization: 'Bearer integration-token-0123456789' } });
        assert.equal(response.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${address!.port}/v1/status`, { headers: { authorization: 'Bearer integration-token-0123456789' } })).json() as { controller: { poll_loop: { running: boolean; next_poll_at: string | null; consecutive_failures: number; auto_poll: boolean; last_discovery_at: string | null } } };
        assert.deepEqual(status.controller.poll_loop, { running: true, next_poll_at: null, consecutive_failures: 2, auto_poll: true, last_discovery_at: null });
        assert.equal((await fetch(`http://127.0.0.1:${address!.port}/v1/queue`)).status, 401);
        stop.abort();
      }
      return { discovered: 0, queued: 0 };
    };
    const dependencies: CliDependencies = {
      cwd: dir, runtime: async () => fake, signal: stop.signal, stdout: () => undefined, stderr: (line) => errors.push(line),
      env: { [config.api.operator_token_env]: 'integration-token-0123456789' },
      sleep: async (ms, signal, kind) => { if (kind === 'discover') delays.push(ms); else await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); }, onListening: (value) => { address = value; },
    };
    assert.equal(await main(['--config', path, 'controller', 'start'], dependencies), 0);
    assert.equal(address?.host, '127.0.0.1');
    assert.deepEqual(delays, [config.jira.poll_seconds * 1000, config.jira.poll_seconds * 2000]);
    assert.equal(discoveries, 3); assert.equal(aborted, true);
    assert.ok(fake.calls.includes('close'));
    assert.match(errors.find((line) => line.includes('poll_failed'))!, /poll_failed/); assert.doesNotMatch(errors.join(''), /secret-value|integration-token/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('controller start refuses a missing operator token with an actionable error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-cli-'));
  try {
    const path = join(dir, 'autos.yaml'); await writeFile(path, canonical); const errors: string[] = [];
    assert.equal(await main(['--config', path, 'controller', 'start'], { cwd: dir, runtime: async () => runtime(), stdout: () => undefined, stderr: (line) => errors.push(line), env: {} }), 1);
    assert.match(errors[0]!, /INVALID_CONFIG/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
