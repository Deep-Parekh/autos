import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { AgentRole, Provider, ProviderRequest } from '@autos/contracts';
import { CliProviderAdapter, DEFAULT_MAX_PROMPT_BYTES, DEFAULT_SWE_BASH_PREFIXES, buildInvocation, describeInvocation } from '../../packages/cli-adapters/src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const SWE_ALLOWED = 'Read,Grep,Glob,Edit,Write,' + ['npm', 'npx', 'node', 'pnpm', 'yarn', 'make', 'mvn', './mvnw', 'gradle', './gradlew', 'java', 'javac', 'ls', 'mkdir', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'git status', 'git diff', 'git log', 'git show', 'git ls-files'].map((p) => `Bash(${p}:*)`).join(',');

function request(provider: Provider, role: AgentRole, extra: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role, cwd: '/workspace',
    prompt_path: '/p/prompt.md', transcript_path: '/p/t.log', timeout_ms: 1000,
    source_access: role === 'swe' ? 'write' : 'read', auth_profile: 'x', ...extra,
  };
}

const expected: [Provider, AgentRole, string[], string | undefined][] = [
  ['claude', 'swe', ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--tools', 'Read,Grep,Glob,Edit,Write,Bash', '--allowedTools', SWE_ALLOWED, '--disallowedTools', 'WebFetch,WebSearch,Bash(git push:*),Bash(git commit:*),Bash(curl:*),Bash(wget:*)'], 'PROMPT'],
  ...(['qa', 'reviewer'] as const).map((role): [Provider, AgentRole, string[], string | undefined] => ['claude', role, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch'], 'PROMPT']),
  ['codex', 'swe', ['exec', '--json', '--ephemeral', '--cd', '/workspace', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-'], 'PROMPT'],
  ...(['qa', 'reviewer'] as const).map((role): [Provider, AgentRole, string[], string | undefined] => ['codex', role, ['exec', '--json', '--ephemeral', '--cd', '/workspace', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-'], 'PROMPT']),
  ['cursor', 'swe', ['-p', '--output-format', 'stream-json', '--model', 'auto', '--force', '--', 'PROMPT'], undefined],
  ...(['qa', 'reviewer'] as const).map((role): [Provider, AgentRole, string[], string | undefined] => ['cursor', role, ['-p', '--output-format', 'stream-json', '--model', 'auto', '--', 'PROMPT'], undefined]),
];

test('exact argv and prompt channel per provider and role', () => {
  for (const [provider, role, args, stdin] of expected) {
    const inv = buildInvocation(provider, role, request(provider, role), 'PROMPT', {});
    assert.deepEqual(inv.args, args, `${provider}/${role}`);
    assert.equal(inv.stdin, stdin, `${provider}/${role} stdin`);
    if (stdin) assert.ok(!inv.args.includes('PROMPT'));
  }
});

test('no blanket bypass flags and read-only roles never get write tools or --force', () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    for (const role of ['swe', 'qa', 'reviewer'] as const) {
      const args = buildInvocation(provider, role, request(provider, role), 'P', {}).args.join(' ');
      assert.ok(!/dangerously|bypass|--yolo|bypassPermissions/i.test(args), `${provider}/${role}`);
      if (role !== 'swe') {
        assert.ok(!args.includes('--force'));
        assert.ok(!/--allowedTools Read,Grep,Glob,Edit|workspace-write/.test(args));
      }
    }
  }
});

test('claude model flag is appended after permission flags', () => {
  const args = buildInvocation('claude', 'qa', request('claude', 'qa', { model: 'sonnet' }), 'P', {}).args;
  assert.deepEqual(args.slice(-2), ['--model', 'sonnet']);
});

test('describeInvocation omits prompt and reports channel and env opt-outs', () => {
  const claude = describeInvocation('claude', 'swe');
  assert.equal(claude.prompt_delivery, 'stdin');
  assert.ok(!claude.args.includes('<prompt>'));
  assert.deepEqual(claude.env_opt_outs, ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY']);
  const cursor = describeInvocation('cursor', 'qa');
  assert.equal(cursor.prompt_delivery, 'argv');
  assert.ok(!cursor.args.includes('<prompt>'));
  assert.equal(cursor.args.at(-1), '--');
  assert.deepEqual(describeInvocation('codex', 'reviewer').env_opt_outs, []);
});

async function setup(provider: Provider, script: string, options: ConstructorParameters<typeof CliProviderAdapter>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'autos-headless-'));
  roots.push(root);
  const workspace = join(root, 'ws');
  const artifacts = join(root, 'art');
  await mkdir(workspace);
  await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md');
  await writeFile(prompt, 'x');
  const binary = join(root, 'fake');
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o700);
  const req = request(provider, 'swe', { cwd: workspace, prompt_path: prompt, transcript_path: join(artifacts, 't.log'), auth_profile: 'x' });
  return { root, prompt, req, adapter: new CliProviderAdapter(provider, { binaries: { [provider]: binary }, ...options }) };
}

test('large prompt is delivered whole on stdin and env opt-outs reach the child', async () => {
  const f = await setup('claude', 'true');
  const out = join(f.root, 'env.txt');
  const inFile = join(f.root, 'stdin.bytes');
  await writeFile(join(f.root, 'fake'), `#!/bin/sh\nwc -c > '${inFile}'\nenv > '${out}'\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"ok"}'\n`);
  const big = 'a'.repeat(200_000);
  await writeFile(f.prompt, big);
  const result = await f.adapter.run(f.req);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal((await readFile(inFile, 'utf8')).trim(), String(big.length));
  const env = await readFile(out, 'utf8');
  for (const line of ['DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1']) assert.ok(env.split('\n').includes(line), line);
});

test('maxPromptBytes defaults to 256 KiB and is configurable', async () => {
  assert.equal(DEFAULT_MAX_PROMPT_BYTES, 262_144);
  const f = await setup('claude', 'true');
  await writeFile(f.prompt, 'a'.repeat(DEFAULT_MAX_PROMPT_BYTES + 1));
  await assert.rejects(() => f.adapter.run(f.req), /size limit/);
  const small = await setup('claude', 'true', { maxPromptBytes: 10 });
  await writeFile(small.prompt, 'a'.repeat(11));
  await assert.rejects(() => small.adapter.run(small.req), /size limit/);
});

const billing: [string, string][] = [
  ['claude', 'Credit balance is too low'],
  ['claude', 'insufficient credits remaining'],
  ['claude', 'Billing error: payment required'],
  ['claude', 'Usage limit reached'],
  ['codex', 'unexpected status 402 Payment Required'],
];
test('billing and quota exhaustion classify as RATE_LIMIT without leaking narrative', async () => {
  for (const [provider, message] of billing) {
    const script = provider === 'claude'
      ? `printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"result":"${message}"}'; exit 1`
      : `printf '%s\\n' '{"type":"error","message":"${message}"}'; exit 1`;
    const f = await setup(provider as Provider, script);
    const result = await f.adapter.run(f.req);
    assert.equal(result.error_code, 'RATE_LIMIT', message);
    assert.equal(result.result, null);
  }
  const http = await setup('claude', `printf '%s\\n' '{"type":"result","subtype":"error","api_error_status":402,"result":"x"}'; exit 1`);
  assert.equal((await http.adapter.run(http.req)).error_code, 'RATE_LIMIT');
});

test('SWE Bash prefixes are configurable, exposed, validated, and deny rules persist', () => {
  assert.ok(['mvn', './mvnw', 'gradle', './gradlew', 'java', 'javac'].every((p) => DEFAULT_SWE_BASH_PREFIXES.includes(p)));
  const custom = describeInvocation('claude', 'swe', { sweBashPrefixes: ['mvn', 'ant'] });
  assert.deepEqual(custom.bash_prefixes, ['mvn', 'ant']);
  assert.equal(custom.args[custom.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Edit,Write,Bash(mvn:*),Bash(ant:*)');
  assert.ok(custom.args[custom.args.indexOf('--disallowedTools') + 1]?.includes('Bash(git push:*)'));
  assert.equal(describeInvocation('claude', 'qa').bash_prefixes, undefined);
  const inv = buildInvocation('claude', 'swe', request('claude', 'swe'), 'P', {}, ['mvn']);
  assert.ok(inv.args.includes('Read,Grep,Glob,Edit,Write,Bash(mvn:*)'));
  for (const bad of [[], ['mvn)'], ['a,b'], ['x; rm']]) assert.throws(() => new CliProviderAdapter('claude', { sweBashPrefixes: bad }), /Bash prefixes/);
});
