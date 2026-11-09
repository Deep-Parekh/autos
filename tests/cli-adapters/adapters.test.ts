import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter, createProviderAdapters, describeInvocation } from '../../packages/cli-adapters/src/index.js';
import type { Provider, ProviderRequest } from '@autos/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(provider: Provider, script: string, options: ConstructorParameters<typeof CliProviderAdapter>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'autos-provider-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'private-artifacts');
  await mkdir(workspace);
  await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md');
  const transcript = join(artifacts, 'transcript.log');
  await writeFile(prompt, 'Test request', { mode: 0o600 });
  const binary = join(root, 'fake-cli');
  await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const request: ProviderRequest = {
    job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider,
    role: 'swe', cwd: workspace, prompt_path: prompt, transcript_path: transcript,
    timeout_ms: 2000, source_access: 'write', auth_profile: 'fixture',
  };
  return { root, workspace, artifacts, prompt, transcript, binary, request, adapter: new CliProviderAdapter(provider, { binaries: { [provider]: binary }, ...options }) };
}

const claudeOk = `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'`;
const cursorOk = claudeOk;
const codexOk = `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2}}'`;

test('parses all provider-specific success envelopes', async () => {
  const cases: [Provider, string][] = [['claude', claudeOk], ['cursor', cursorOk], ['codex', codexOk]];
  for (const [provider, script] of cases) {
    const f = await fixture(provider, script);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.result, 'done');
    assert.equal(result.provider, provider);
    assert.equal(await readFile(f.transcript, 'utf8').then((text) => text.length > 0), true);
  }
});

test('rejects successful exit with failure envelope, malformed output, and missing terminal result', async () => {
  const cases: [Provider, string, string][] = [
    ['claude', `printf '%s' '{"type":"result","subtype":"error_during_execution","result":"secret narrative"}'`, 'TOOL'],
    ['cursor', `printf '%s' '{"type":"message","subtype":"success","result":"not a result envelope"}'`, 'INVALID_OUTPUT'],
    ['codex', `printf '%s\\n' '{"type":"thread.started"}'`, 'INVALID_OUTPUT'],
    ['codex', `printf '%s\\n' '{"type":"turn.completed","turn":{"status":"failed"}}'`, 'TOOL'],
    ['codex', `printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","status":"failed","exit_code":23}}' '{"type":"turn.completed"}' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'`, 'TOOL'],
    ['codex', `printf '%s\\n' '{"type":"error","message":"failure"}'`, 'TOOL'],
    ['codex', `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' '{"type":"turn.completed","usage":{}}' '{"type":"item.completed","item":{"type":"agent_message","text":"late"}}'`, 'INVALID_OUTPUT'],
  ];
  for (const [provider, script, code] of cases) {
    const f = await fixture(provider, script);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error_code, code);
    assert.equal(result.result, null);
  }
});

test('normalizes auth and rate-limit failures without returning process narratives', async () => {
  for (const [message, code] of [['authentication required sk-test-secret-value', 'AUTH'], ['HTTP 429 rate limit exceeded', 'RATE_LIMIT']] as const) {
    const f = await fixture('cursor', `printf '%s\\n' '${message}' >&2; exit 1`);
    const result = await f.adapter.run(f.request);
    assert.equal(result.error_code, code);
    assert.equal(result.result, null);
    const transcript = await readFile(f.transcript, 'utf8');
    assert.ok(!transcript.includes('sk-test-secret-value'));
  }
});

test('enforces request schemas, role source access, and matching adapter provider', async () => {
  const f = await fixture('claude', claudeOk);
  await assert.rejects(() => f.adapter.run({ ...f.request, role: 'qa', source_access: 'write' }), /QA and reviewer require source-read access/);
  await assert.rejects(() => f.adapter.run({ ...f.request, provider: 'codex' }), /does not match adapter/);
});

test('never inherits unrelated controller environment and keeps prompt argument atomic', async () => {
  const f = await fixture('claude', `printf '%s\\n' '{"type":"result","subtype":"success","result":"done"}'; printf '%s' "$LEAK_ME"` , {
    baseEnv: { PATH: process.env.PATH ?? '', LEAK_ME: 'controller-secret' },
  });
  await writeFile(f.prompt, '-x; touch INJECTED');
  const seen = await join(f.root, 'args.txt');
  const seenStdin = join(f.root, 'stdin.txt');
  await writeFile(f.binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\ncat > '${seenStdin}'\n${claudeOk}\nprintf '%s' "$LEAK_ME"\n`, { mode: 0o700 });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED');
  const args = await readFile(seen, 'utf8');
  assert.ok(!args.includes('touch INJECTED'));
  assert.equal(await readFile(seenStdin, 'utf8'), '-x; touch INJECTED');
  assert.ok(!await readFile(f.transcript, 'utf8').then((value) => value.includes('controller-secret')));
});

test('passes only selected auth profile variables and redacts them from transcript', async () => {
  const secret = 'x';
  const f = await fixture('claude', `printf '{"type":"result","subtype":"success","result":"%s|%s"}\\n' "$HOME" "$ANTHROPIC_API_KEY"`, {
    resolveAuth: () => ({ HOME: '/profile/scoped-home', ANTHROPIC_API_KEY: secret, UNRELATED: 'must-not-pass' }),
  });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.result, '/profile/scoped-home|[REDACTED]');
  const transcript = await readFile(f.transcript, 'utf8');
  assert.ok(transcript.includes('/profile/scoped-home'));
  assert.ok(!transcript.includes(secret));
});

test('times out and aborts the whole fake process group', async () => {
  const timeout = await fixture('cursor', 'sleep 10');
  const timeoutResult = await timeout.adapter.run({ ...timeout.request, timeout_ms: 40 });
  assert.equal(timeoutResult.status, 'TIMED_OUT');
  assert.equal(timeoutResult.error_code, 'TIMEOUT');

  const cancelled = await fixture('cursor', 'sleep 10');
  const controller = new AbortController();
  const running = cancelled.adapter.run(cancelled.request, controller.signal);
  setTimeout(() => controller.abort(), 30);
  const cancelResult = await running;
  assert.equal(cancelResult.status, 'CANCELLED');
  assert.equal(cancelResult.error_code, 'CANCELLED');
});

test('aborts when captured output exceeds configured bound', async () => {
  const f = await fixture('claude', `yes x` , { maxOutputBytes: 128 });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error_code, 'TOOL');
  assert.equal(await readFile(f.transcript, 'utf8'), '[provider output limit exceeded]');
});

test('pre-aborted requests skip prompt read, auth resolution, and spawn', async () => {
  let authCalls = 0;
  let spawnCalls = 0;
  const f = await fixture('claude', claudeOk, {
    resolveAuth: () => { authCalls += 1; return { ANTHROPIC_API_KEY: 'test-key' }; },
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('pre-aborted request must not spawn');
    }) as typeof spawn,
  });
  const controller = new AbortController();
  controller.abort();
  const result = await f.adapter.run(f.request, controller.signal);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(authCalls, 0);
  assert.equal(spawnCalls, 0);
});

test('bounds prompt reads and validates adapter limits', async () => {
  let spawnCalls = 0;
  const f = await fixture('claude', claudeOk, { maxPromptBytes: 16, spawnProcess: (() => { spawnCalls += 1; throw new Error('unexpected'); }) as typeof spawn });
  await writeFile(f.prompt, 'a'.repeat(1_000_000));
  await assert.rejects(() => f.adapter.run(f.request), /size limit/);
  assert.equal(spawnCalls, 0);
  assert.throws(() => new CliProviderAdapter('claude', { maxOutputBytes: 0 }), /positive integers/);
  assert.throws(() => new CliProviderAdapter('claude', { killGraceMs: 60_001 }), /supported bounds/);
});

test('kills signal-resistant descendants after the provider parent exits successfully', async () => {
  const f = await fixture('claude', 'true');
  const pidFile = join(f.root, 'child.pid');
  await writeFile(f.binary, `#!/bin/sh\n(trap '' TERM; exec sleep 30) &\necho $! > '${pidFile}'\n${claudeOk}\n`, { mode: 0o700 });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED');
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.throws(() => process.kill(pid, 0));
});

test('rejects prompt/transcript destinations inside workspace and symlink paths', async () => {
  const f = await fixture('claude', claudeOk);
  await assert.rejects(() => f.adapter.run({ ...f.request, transcript_path: join(f.workspace, 'transcript.log') }), /outside the ticket workspace/);
  await assert.rejects(() => f.adapter.run({ ...f.request, prompt_path: join(f.workspace, 'prompt.md') }), /outside the ticket workspace/);
  const link = join(f.root, 'prompt-link.md');
  await symlink(f.prompt, link);
  await assert.rejects(() => f.adapter.run({ ...f.request, prompt_path: link }), /symlink targets/);
  const cwdLink = join(f.root, 'workspace-link');
  await symlink(f.workspace, cwdLink);
  const insidePrompt = join(f.workspace, 'role-prompt.md');
  await writeFile(insidePrompt, 'role prompt');
  await assert.rejects(() => f.adapter.run({ ...f.request, cwd: cwdLink, prompt_path: insidePrompt }), /outside the ticket workspace/);
  const artifactAlias = join(f.root, 'artifact-alias');
  await symlink(f.workspace, artifactAlias);
  await assert.rejects(() => f.adapter.run({ ...f.request, transcript_path: join(artifactAlias, 'trace.txt') }), /outside the ticket workspace/);
});

test('constructs all three distinct adapters with injected binaries', () => {
  const adapters = createProviderAdapters({ binaries: { claude: '/fake/claude', codex: '/fake/codex', cursor: '/fake/cursor-agent' } });
  assert.deepEqual(Object.keys(adapters).sort(), ['claude', 'codex', 'cursor']);
});

test('claude subscription token reaches only the process environment, is redacted, and never shadows or is shadowed by API variables', async () => {
  const token = 'sk-ant-oat01-FIXTURE-subscription-token-0000';
  const f = await fixture('claude', `printf '%s\\n' "$@" > "$0.argv"; printf '{"type":"result","subtype":"success","result":"%s|%s|%s|%s"}\\n' "$CLAUDE_CODE_OAUTH_TOKEN" "\${ANTHROPIC_API_KEY-unset}" "\${ANTHROPIC_AUTH_TOKEN-unset}" "\${ANTHROPIC_BASE_URL-unset}"`, {
    resolveAuth: () => ({ HOME: '/home/worker', CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: 'sk-ant-api03-FIXTURE-0000', ANTHROPIC_AUTH_TOKEN: 'bearer-fixture', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }),
  });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.result, '[REDACTED]|unset|unset|unset', 'the token is delivered (then redacted from output) and every API-style variable is dropped');
  const serialized = JSON.stringify(result) + await readFile(f.transcript, 'utf8') + await readFile(`${f.binary}.argv`, 'utf8');
  assert.ok(!serialized.includes(token), 'token appears in no argv, transcript or result');
});

test('claude argv never contains --bare (it would ignore the subscription token), for every role', async () => {
  for (const role of ['swe', 'qa', 'reviewer'] as const) {
    const described = describeInvocation('claude', role);
    assert.ok(!described.args.includes('--bare'), `${role}: ${described.args.join(' ')}`);
    const f = await fixture('claude', `printf '%s\\n' "$@" > "$0.argv"; ${claudeOk}`);
    const result = await f.adapter.run({ ...f.request, role, source_access: role === 'swe' ? 'write' : 'read' });
    assert.equal(result.status, 'SUCCEEDED');
    const argv = (await readFile(`${f.binary}.argv`, 'utf8')).split('\n');
    assert.ok(!argv.some((arg) => arg === '--bare' || arg.startsWith('--bare=')), argv.join(' '));
  }
});

test('codex and cursor never receive the Claude subscription token', async () => {
  for (const provider of ['codex', 'cursor'] as const) {
    const f = await fixture(provider, `printf '{"type":"result","subtype":"success","result":"%s"}\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}"; ${provider === 'codex' ? codexOk : ''}`, {
      resolveAuth: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FIXTURE', CURSOR_API_KEY: 'cursor-fixture', OPENAI_API_KEY: 'sk-fixture-openai-0000' }),
    });
    const result = await f.adapter.run(f.request);
    const transcript = await readFile(f.transcript, 'utf8');
    assert.ok(!transcript.includes('sk-ant-oat01-FIXTURE'), provider);
    if (provider === 'cursor') assert.equal(result.result, 'unset');
  }
});
