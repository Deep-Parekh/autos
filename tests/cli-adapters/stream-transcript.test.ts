import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter, DEFAULT_MAX_TRANSCRIPT_BYTES, clampText } from '../../packages/cli-adapters/src/index.js';
import type { Provider, ProviderRequest } from '@autos/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(provider: Provider, lines: string[], options: ConstructorParameters<typeof CliProviderAdapter>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'autos-stream-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'private-artifacts');
  await mkdir(workspace);
  await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md');
  await writeFile(prompt, 'Test request', { mode: 0o600 });
  const binary = join(root, 'fake-cli');
  const data = join(root, 'stdout.txt');
  await writeFile(data, lines.map((line) => `${line}\n`).join(''));
  await writeFile(binary, `#!/bin/sh\ncat '${data}'\n`, { mode: 0o700 });
  const request: ProviderRequest = {
    job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role: 'swe',
    cwd: workspace, prompt_path: prompt, transcript_path: join(artifacts, 'transcript.jsonl'),
    timeout_ms: 5000, source_access: 'write', auth_profile: 'fixture',
  };
  return { request, adapter: new CliProviderAdapter(provider, { binaries: { [provider]: binary }, ...options }) };
}

const init = '{"type":"system","subtype":"init","session_id":"s1"}';
const toolUse = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"a.ts"}}]}}';
const toolResult = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}';
const stream = (resultFields: string) => [init, toolUse, toolResult, `{"type":"result",${resultFields}}`];

for (const provider of ['claude', 'cursor'] as const) {
  test(`${provider}: stream-json success is parsed and every stream line reaches the transcript`, async () => {
    const lines = stream('"subtype":"success","is_error":false,"result":"final answer"');
    const f = await setup(provider, lines);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.result, 'final answer');
    assert.equal(await readFile(f.request.transcript_path, 'utf8'), lines.map((line) => `${line}\n`).join(''));
  });

  test(`${provider}: single-object output still parses`, async () => {
    const f = await setup(provider, ['{"type":"result","subtype":"success","is_error":false,"result":"old"}']);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.result, 'old');
  });

  test(`${provider}: stream result lines keep error classification`, async () => {
    const cases: [string, string][] = [
      ['"subtype":"success","is_error":true,"result":"Credit balance is too low","api_error_status":402', 'RATE_LIMIT'],
      ['"subtype":"success","is_error":true,"result":"Invalid API key","api_error_status":401', 'AUTH'],
      ['"subtype":"success","is_error":true,"result":"Prompt is too long"', 'CONTEXT'],
      ['"subtype":"error_during_execution","is_error":true,"result":"boom"', 'TOOL'],
    ];
    for (const [fields, code] of cases) {
      const f = await setup(provider, stream(fields));
      const result = await f.adapter.run(f.request);
      assert.equal(result.status, 'FAILED', fields);
      assert.equal(result.error_code, code, fields);
    }
  });

  test(`${provider}: a stream without a final result line is invalid output`, async () => {
    const f = await setup(provider, [init, toolUse, toolResult]);
    const result = await f.adapter.run(f.request);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error_code, 'INVALID_OUTPUT');
  });

  test(`${provider}: a mid-stream result that is not last is not accepted`, async () => {
    const f = await setup(provider, ['{"type":"result","subtype":"success","is_error":false,"result":"stale"}', toolUse]);
    const result = await f.adapter.run(f.request);
    assert.equal(result.error_code, 'INVALID_OUTPUT');
  });
}

test('tokens inside a tool_result line are redacted from the transcript', async () => {
  const secret = 'sk-ant-oat01-STREAM-FIXTURE';
  const leak = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"TOKEN=${secret}"}]}}`;
  const f = await setup('claude', [init, leak, '{"type":"result","subtype":"success","is_error":false,"result":"done"}'], {
    resolveAuth: () => ({ CLAUDE_CODE_OAUTH_TOKEN: secret }),
  });
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED');
  const transcript = await readFile(f.request.transcript_path, 'utf8');
  assert.ok(!transcript.includes(secret));
  assert.ok(transcript.includes('[REDACTED]'));
});

test('default transcript cap is 5 MiB and truncation is marked', async () => {
  assert.equal(DEFAULT_MAX_TRANSCRIPT_BYTES, 5_242_880);
  const filler = `{"type":"assistant","message":{"content":[{"type":"text","text":"${'x'.repeat(1000)}"}]}}`;
  const count = Math.ceil(5_500_000 / (filler.length + 1));
  const lines = [init, ...Array.from({ length: count }, () => filler), '{"type":"result","subtype":"success","is_error":false,"result":"done"}'];
  const f = await setup('claude', lines);
  const result = await f.adapter.run(f.request);
  assert.equal(result.status, 'SUCCEEDED', 'default output limit must accommodate a 5 MiB+ stream');
  const transcript = await readFile(f.request.transcript_path, 'utf8');
  assert.ok(Buffer.byteLength(transcript) <= 5_242_880 + 32);
  assert.ok(Buffer.byteLength(transcript) > 5_000_000);
  assert.ok(transcript.endsWith('\n[transcript truncated]'));
  const kept = transcript.split('\n').slice(0, -1);
  for (const line of kept) assert.doesNotThrow(() => JSON.parse(line));
});

test('maxTranscriptBytes stays configurable', async () => {
  const lines = [init, toolUse, toolResult, '{"type":"result","subtype":"success","is_error":false,"result":"done"}'];
  const f = await setup('claude', lines, { maxTranscriptBytes: init.length + toolUse.length - 5 });
  await f.adapter.run(f.request);
  assert.equal(await readFile(f.request.transcript_path, 'utf8'), `${init}\n[transcript truncated]`);
});

test('clampText cuts on a line boundary, keeps an exactly-fitting line and never splits UTF-8', () => {
  assert.equal(clampText('abc\ndef\n', 100), 'abc\ndef\n');
  assert.equal(clampText('aaaa\nbbbb\ncccc', 9), 'aaaa\nbbbb\n[transcript truncated]');
  assert.equal(clampText('aaaa\nbbbb\ncccc', 8), 'aaaa\n[transcript truncated]');
  assert.equal(clampText('aaaa\nbbbb\ncccc', 10), 'aaaa\nbbbb\n[transcript truncated]');
  const multibyte = '€'.repeat(10);
  for (let limit = 1; limit < 30; limit += 1) {
    const clamped = clampText(multibyte, limit);
    assert.ok(!clamped.includes('�'), `limit ${limit}`);
    assert.ok(clamped.endsWith('\n[transcript truncated]'));
  }
  assert.equal(clampText('€€€', 4), '€\n[transcript truncated]');
});
