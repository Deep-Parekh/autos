import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter, buildInvocation } from '../../packages/cli-adapters/src/index.js';
import type { Provider, ProviderRequest } from '@autos/contracts';
import type { spawn } from 'node:child_process';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(provider: Provider, script: string | undefined, options: ConstructorParameters<typeof CliProviderAdapter>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'autos-fallback-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'private-artifacts');
  await mkdir(workspace);
  await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md');
  await writeFile(prompt, 'Test request', { mode: 0o600 });
  const binary = join(root, 'fake-cli');
  if (script !== undefined) await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const request: ProviderRequest = {
    job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role: 'swe',
    cwd: workspace, prompt_path: prompt, transcript_path: join(artifacts, 'transcript.log'),
    timeout_ms: 2000, source_access: 'write', auth_profile: 'fixture',
  };
  return { root, binary, request, adapter: new CliProviderAdapter(provider, { binaries: { [provider]: binary }, ...options }) };
}

const emit = (lines: string[]) => `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}`;
const claudeErr = (fields: string) => emit([`{"type":"result","subtype":"success","is_error":true,${fields}}`]);
const codexErr = (event: string) => emit(['{"type":"thread.started"}', event]);

const exitCases: [string, Provider, string, string][] = [
  // [label, provider, script, expected code]
  ['claude prompt too long', 'claude', `${claudeErr('"api_error_status":400,"result":"Prompt is too long"')}; exit 1`, 'CONTEXT'],
  ['claude context via exit 0 envelope', 'claude', claudeErr('"result":"Prompt is too long"'), 'CONTEXT'],
  ['cursor context length envelope', 'cursor', `${claudeErr('"result":"context_length_exceeded"')}; exit 1`, 'CONTEXT'],
  ['codex context window event', 'codex', `${codexErr('{"type":"error","message":"Your input exceeds the context window of this model."}')}; exit 1`, 'CONTEXT'],
  ['codex turn.failed context code', 'codex', codexErr('{"type":"turn.failed","error":{"message":"x","code":"context_length_exceeded"}}'), 'CONTEXT'],
  ['claude overloaded 529', 'claude', `${claudeErr('"api_error_status":529,"result":"API Error: 529 overloaded_error"')}; exit 1`, 'UPSTREAM'],
  ['claude 500 status field only', 'claude', claudeErr('"api_error_status":500,"result":"failed"'), 'UPSTREAM'],
  ['cursor 503 stderr', 'cursor', `echo 'HTTP 503 Service Unavailable' >&2; exit 1`, 'UPSTREAM'],
  ['cursor network stderr', 'cursor', `echo 'fetch failed: ECONNRESET' >&2; exit 1`, 'UPSTREAM'],
  ['codex server error event', 'codex', `${codexErr('{"type":"error","message":"stream error: 502 Bad Gateway"}')}; exit 1`, 'UPSTREAM'],
  ['codex status field 500', 'codex', codexErr('{"type":"turn.failed","error":{"message":"failed","status":500}}'), 'UPSTREAM'],
  ['claude 429 envelope', 'claude', `${claudeErr('"api_error_status":429,"result":"slow down"')}; exit 1`, 'RATE_LIMIT'],
  ['codex rate limit event', 'codex', `${codexErr('{"type":"error","message":"Rate limit reached for requests"}')}; exit 1`, 'RATE_LIMIT'],
  ['claude invalid key', 'claude', `${claudeErr('"result":"Invalid API key. Please run /login"')}; exit 1`, 'AUTH'],
  ['claude 401 status', 'claude', claudeErr('"api_error_status":401,"result":"denied"'), 'AUTH'],
  ['codex 401 event', 'codex', `${codexErr('{"type":"error","message":"unexpected status 401 Unauthorized"}')}; exit 1`, 'AUTH'],
  ['cursor not logged in', 'cursor', `echo 'Not logged in' >&2; exit 1`, 'AUTH'],
  ['claude generic tool error', 'claude', claudeErr('"result":"tool crashed"'), 'TOOL'],
  ['codex generic error', 'codex', `${codexErr('{"type":"error","message":"sandbox denied"}')}; exit 1`, 'TOOL'],
  ['cursor malformed output', 'cursor', 'echo not-json', 'INVALID_OUTPUT'],
  ['claude malformed output', 'claude', 'printf "{"', 'INVALID_OUTPUT'],
  ['codex malformed output', 'codex', 'echo not-json', 'INVALID_OUTPUT'],
];

test('classifies provider failure envelopes into distinct fallback-relevant codes', async () => {
  for (const [label, provider, script, code] of exitCases) {
    const f = await setup(provider, script);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'FAILED', label);
    assert.equal(result.error_code, code, label);
    assert.equal(result.result, null, label);
  }
});

test('assistant narrative on a failing exit does not drive classification', async () => {
  const f = await setup('codex', `${emit(['{"type":"item.completed","item":{"type":"agent_message","text":"HTTP 429 rate limit, prompt is too long, unauthorized"}}'])}; exit 1`);
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'TOOL');
});

test('timeout and cancellation stay outside the other codes', async () => {
  const f = await setup('claude', 'sleep 10');
  const result = await f.adapter.run({ ...f.request, timeout_ms: 40 });
  assert.equal(result.error_code, 'TIMEOUT');
  const c = await setup('claude', 'sleep 10');
  const controller = new AbortController();
  const running = c.adapter.run(c.request, controller.signal);
  setTimeout(() => controller.abort(), 30);
  assert.equal((await running).error_code, 'CANCELLED');
});

test('missing binary is UNAVAILABLE for every provider without leaking text', async () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    const f = await setup(provider, undefined);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error_code, 'UNAVAILABLE');
    assert.equal(result.result, null);
    const transcript = await readFile(f.request.transcript_path, 'utf8');
    assert.ok(!transcript.includes(f.binary));
  }
});

test('non-executable and non-binary files are UNAVAILABLE', async () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    const f = await setup(provider, 'true');
    await chmod(f.binary, 0o600);
    const result = await f.adapter.run(f.request);
    assert.equal(result.error_code, 'UNAVAILABLE');
  }
  const bad = await setup('claude', undefined);
  await writeFile(bad.binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]), { mode: 0o700 });
  const result = await bad.adapter.run(bad.request);
  assert.equal(result.error_code, 'UNAVAILABLE');
});

test('other spawn failures remain TOOL', async () => {
  const f = await setup('claude', undefined, {
    spawnProcess: (() => { throw Object.assign(new Error('spawn failed'), { code: 'EMFILE' }); }) as unknown as typeof spawn,
  });
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'TOOL');
});

test('cursor always runs with --model auto before the prompt separator', async () => {
  const f = await setup('cursor', 'true');
  const seen = join(f.root, 'args.txt');
  await writeFile(f.binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\n${emit(['{"type":"result","subtype":"success","result":"done"}'])}\n`, { mode: 0o700 });
  for (const model of [undefined, 'auto']) {
    const request = model === undefined ? f.request : { ...f.request, model };
    const result = await f.adapter.run({ ...request, transcript_path: join(f.root, `t-${model ?? 'none'}.log`) });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.model, 'auto');
    const args = (await readFile(seen, 'utf8')).split('\n');
    const at = args.indexOf('--model');
    assert.equal(args[at + 1], 'auto');
    assert.ok(at < args.indexOf('--'));
    assert.equal(args.filter((arg) => arg === '--model').length, 1);
  }
  assert.deepEqual(buildInvocation('cursor', 'swe', { ...f.request, model: 'auto' }, 'p', {}).args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--model', 'auto']);
});

test('cursor rejects any other model before spawning', async () => {
  let spawns = 0;
  const f = await setup('cursor', 'true', { spawnProcess: (() => { spawns += 1; throw new Error('must not spawn'); }) as unknown as typeof spawn });
  await assert.rejects(() => f.adapter.run({ ...f.request, model: 'gpt-5' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT');
  assert.equal(spawns, 0);
});
