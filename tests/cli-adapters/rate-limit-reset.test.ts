import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter, extractRateLimitReset } from '../../packages/cli-adapters/src/index.js';
import { providerResultSchema, type Provider, type ProviderRequest } from '@autos/contracts';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(provider: Provider, script: string) {
  const root = await mkdtemp(join(tmpdir(), 'autos-ratelimit-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'private-artifacts');
  await mkdir(workspace);
  await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md');
  await writeFile(prompt, 'Test request', { mode: 0o600 });
  const binary = join(root, 'fake-cli');
  await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const request: ProviderRequest = {
    job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role: 'swe',
    cwd: workspace, prompt_path: prompt, transcript_path: join(artifacts, 'transcript.log'),
    timeout_ms: 2000, source_access: 'write', auth_profile: 'fixture',
  };
  return { request, adapter: new CliProviderAdapter(provider, { binaries: { [provider]: binary }, now: () => NOW }) };
}

const emit = (lines: string[]) => `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}`;
const claudeRateLimited = '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"Usage limit reached"}';

test('claude rate_limit_event resetsAt (rejected) becomes retry_at on a RATE_LIMIT failure', async () => {
  const reset = NOW_S + 3600;
  const f = await setup('claude', `${emit([
    '{"type":"system","subtype":"init"}',
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${reset},"rateLimitType":"five_hour"}}`,
    claudeRateLimited,
  ])}; exit 1`);
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'RATE_LIMIT');
  assert.equal(result.retry_at, iso(3600));
  assert.doesNotThrow(() => providerResultSchema.parse(result));
  assert.equal(Object.keys(result).includes('stdout'), false);
});

test('zero-exit claude envelope failure also carries retry_at', async () => {
  const f = await setup('claude', emit([
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${NOW_S + 600}}}`,
    claudeRateLimited,
  ]));
  const result = await f.adapter.run(f.request);
  assert.equal(result.exit_code, 0);
  assert.equal(result.error_code, 'RATE_LIMIT');
  assert.equal(result.retry_at, iso(600));
});

test('codex error with resets_in_seconds yields now + N', async () => {
  const f = await setup('codex', `${emit([
    '{"type":"thread.started"}',
    '{"type":"turn.failed","error":{"message":"You have hit your usage limit","code":"usage_limit_reached","resets_in_seconds":1800}}',
  ])}; exit 1`);
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'RATE_LIMIT');
  assert.equal(result.retry_at, iso(1800));
});

test('codex zero-exit error event with ISO resets_at', async () => {
  const f = await setup('codex', emit([
    '{"type":"thread.started"}',
    `{"type":"error","message":"rate limit exceeded","resets_at":"${iso(900)}"}`,
  ]));
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'RATE_LIMIT');
  assert.equal(result.retry_at, iso(900));
});

test('accepts epoch seconds, epoch milliseconds, ISO strings and relative seconds fields', () => {
  const ms = NOW.getTime() + 120_000;
  assert.equal(extractRateLimitReset('codex', `{"type":"error","message":"x","error":{"resets_at":${ms}}}`, NOW), iso(120));
  assert.equal(extractRateLimitReset('codex', `{"type":"error","message":"x","error":{"resets_at":${NOW_S + 60}}}`, NOW), iso(60));
  assert.equal(extractRateLimitReset('codex', `{"type":"error","error":{"resets_at":"${NOW_S + 61}"}}`, NOW), iso(61));
  assert.equal(extractRateLimitReset('cursor', `{"type":"result","subtype":"error","is_error":true,"resets_at":"${iso(300)}"}`, NOW), iso(300));
  assert.equal(extractRateLimitReset('claude', '{"type":"error","error":{"type":"rate_limit_error","retry_after":42}}', NOW), iso(42));
  assert.equal(extractRateLimitReset('claude', '{"type":"result","subtype":"error","retry_after_seconds":"30"}', NOW), iso(30));
  assert.equal(extractRateLimitReset('claude', '{"type":"error","error":{"error":{"resetsAt":' + (NOW_S + 75) + '}}}', NOW), iso(75));
});

test('values in assistant narrative, agent_message text, tool results and stderr are ignored', async () => {
  const later = NOW_S + 3600;
  assert.equal(extractRateLimitReset('claude', [
    `{"type":"assistant","message":{"content":[{"type":"text","text":"limit resetsAt ${later}"}],"resetsAt":${later}}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","content":"{\\"resets_at\\":${later}}"}]},"resets_at":${later}}`,
    claudeRateLimited,
  ].join('\n'), NOW), undefined);
  assert.equal(extractRateLimitReset('codex', [
    `{"type":"item.completed","item":{"type":"agent_message","text":"resets_in_seconds: 60","resets_in_seconds":60}}`,
    '{"type":"turn.failed","error":{"message":"rate limit; try again at 3pm"}}',
  ].join('\n'), NOW), undefined);
  const f = await setup('codex', `echo 'rate limit exceeded; resets_in_seconds=60' >&2; ${emit(['{"type":"item.completed","item":{"type":"agent_message","text":"retry_after 60"}}'])}; exit 1`);
  const result = await f.adapter.run(f.request);
  assert.equal(result.error_code, 'RATE_LIMIT');
  assert.equal(result.retry_at, undefined);
  assert.equal(Object.hasOwn(result, 'retry_at'), false);
});

test('non-rejected rate_limit_event statuses are ignored', () => {
  assert.equal(extractRateLimitReset('claude', `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":${NOW_S + 60}}}`, NOW), undefined);
  assert.equal(extractRateLimitReset('claude', `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":${NOW_S + 60}}}`, NOW), undefined);
});

test('out-of-window, past and malformed values are ignored', () => {
  for (const line of [
    `{"type":"error","error":{"resets_at":${NOW_S - 10}}}`,
    `{"type":"error","error":{"resets_at":${NOW_S + 8 * 24 * 3600}}}`,
    `{"type":"error","error":{"resets_in_seconds":${8 * 24 * 3600}}}`,
    '{"type":"error","error":{"resets_in_seconds":-5}}',
    '{"type":"error","error":{"resets_at":"not a date"}}',
    '{"type":"error","error":{"resets_at":null,"retry_after":true}}',
    '{"type":"error","resets_at":',
    'resets_at 12345',
  ]) {
    assert.equal(extractRateLimitReset('codex', line, NOW), undefined, line);
  }
  assert.equal(extractRateLimitReset('codex', `{"type":"error","error":{"resets_in_seconds":${7 * 24 * 3600}}}`, NOW), iso(7 * 24 * 3600));
});

test('earliest of several valid values wins', () => {
  const text = [
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${NOW_S + 7200}}}`,
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${NOW_S + 5400}}}`,
    `{"type":"result","subtype":"error","is_error":true,"error":{"retry_after_seconds":9000},"resets_at":${NOW_S - 100}}`,
  ].join('\n');
  assert.equal(extractRateLimitReset('claude', text, NOW), iso(5400));
});

test('no retry_at for non-RATE_LIMIT failures or successes', async () => {
  const reset = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${NOW_S + 600}}}`;
  const failing = await setup('claude', `${emit([reset, '{"type":"result","subtype":"success","is_error":true,"api_error_status":529,"result":"overloaded_error"}'])}; exit 1`);
  const failed = await failing.adapter.run(failing.request);
  assert.equal(failed.error_code, 'UPSTREAM');
  assert.equal(Object.hasOwn(failed, 'retry_at'), false);
  const ok = await setup('claude', emit([reset, '{"type":"result","subtype":"success","is_error":false,"result":"done"}']));
  const succeeded = await ok.adapter.run(ok.request);
  assert.equal(succeeded.status, 'SUCCEEDED');
  assert.equal(Object.hasOwn(succeeded, 'retry_at'), false);
  assert.match(await readFile(ok.request.transcript_path, 'utf8'), /rate_limit_event/);
});

test('a non-function clock is rejected at construction', () => {
  assert.throws(() => new CliProviderAdapter('claude', { now: 'soon' as unknown as () => Date }), /clock/);
});
