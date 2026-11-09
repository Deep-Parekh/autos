import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter } from '../../packages/cli-adapters/src/index.js';
import type { Provider, ProviderRequest } from '@autos/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const ok: Record<Provider, string> = {
  claude: `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'`,
  cursor: `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'`,
  codex: `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2}}'`,
};
/** Runs the adapter against a fake CLI that records its argv (one argument per line) and returns them. */
async function argv(provider: Provider, extra: Partial<ProviderRequest>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'autos-effort-')); roots.push(root);
  const workspace = join(root, 'workspace'); const artifacts = join(root, 'private'); await mkdir(workspace); await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt.md'); await writeFile(prompt, 'Test', { mode: 0o600 });
  const out = join(root, 'argv.txt'); const binary = join(root, 'fake-cli');
  await writeFile(binary, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${out}'; done\n${ok[provider]}\n`, { mode: 0o700 });
  const adapter = new CliProviderAdapter(provider, { binaries: { [provider]: binary } });
  const result = await adapter.run({ job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role: 'swe', cwd: workspace, prompt_path: prompt, transcript_path: join(artifacts, 'transcript.log'), timeout_ms: 5000, source_access: 'write', auth_profile: 'fixture', ...extra } as ProviderRequest);
  assert.equal(result.status, 'SUCCEEDED');
  return (await readFile(out, 'utf8')).split('\n').filter(Boolean);
}
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('claude receives --model and --effort as separate argv elements', async () => {
  const args = await argv('claude', { model: 'opus', effort: 'max' });
  assert.equal(after(args, '--model'), 'opus');
  assert.equal(after(args, '--effort'), 'max');
});

test('codex receives the model and a model_reasoning_effort config override', async () => {
  const args = await argv('codex', { model: 'gpt-6-luna', effort: 'xhigh' });
  assert.equal(after(args, '--model'), 'gpt-6-luna');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(args[args.indexOf('model_reasoning_effort="xhigh"') - 1], '-c');
  assert.equal(args.at(-1), '-'); // prompt still on stdin
});

test('no effort means no effort flag (CLI default)', async () => {
  const claude = await argv('claude', { model: 'sonnet' });
  assert.equal(claude.includes('--effort'), false);
  const codex = await argv('codex', {});
  assert.equal(codex.some((a) => a.startsWith('model_reasoning_effort')), false);
});

test('effort the provider does not accept is refused before launch', async () => {
  await assert.rejects(() => argv('cursor', { effort: 'high' }));
  await assert.rejects(() => argv('claude', { effort: 'minimal' }));
});
