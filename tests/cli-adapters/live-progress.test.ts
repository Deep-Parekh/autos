import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter } from '../../packages/cli-adapters/src/index.js';
import { progressFromLine, type ProviderRequest } from '@autos/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('streams complete stdout lines in order and filters narrative from progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-progress-')); roots.push(root);
  const cwd = join(root, 'workspace'); const artifacts = join(root, 'artifacts');
  await mkdir(cwd); await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt'); const transcript = join(artifacts, 'transcript');
  await writeFile(prompt, 'test');
  const binary = join(root, 'fake-cli');
  const action = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/workspace/src/a.ts' } }] } });
  const narrative = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'private agent narrative' }] } });
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
  // Split the first JSON event across writes, then delay between events to prove callbacks run before process exit.
  await writeFile(binary, `#!/bin/sh\nprintf '%s' '${action.slice(0, 35)}'\nsleep 0.08\nprintf '%s\\n' '${action.slice(35)}'\nprintf '%s\\n' '${narrative}'\nsleep 0.08\nprintf '%s' '${resultLine}'\n`, { mode: 0o700 });
  const request: ProviderRequest = { job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider: 'claude', role: 'swe', cwd, prompt_path: prompt, transcript_path: transcript, timeout_ms: 3000, source_access: 'write', auth_profile: 'fake' };
  const adapter = new CliProviderAdapter('claude', { binaries: { claude: binary } });
  const lines: string[] = []; const progress: string[] = []; const seen = new Set<string>();
  let callbackBeforeExit = false;
  const result = await adapter.run(request, undefined, (line) => {
    lines.push(line);
    if (lines.length < 3) callbackBeforeExit = true;
    for (const action of progressFromLine(line, seen)) progress.push(action.label);
  });
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(lines, [action, narrative, resultLine]);
  assert.equal(callbackBeforeExit, true);
  assert.deepEqual(progress, ['src/a.ts']);
});

test('drops oversized stream lines and ignores throwing callbacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autos-progress-')); roots.push(root);
  const cwd = join(root, 'workspace'); const artifacts = join(root, 'artifacts');
  await mkdir(cwd); await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt'); const transcript = join(artifacts, 'transcript');
  await writeFile(prompt, 'test');
  const binary = join(root, 'fake-cli');
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
  await writeFile(binary, `#!/bin/sh\nhead -c 1048577 /dev/zero | tr '\\000' x\nprintf '\\n%s' '${resultLine}'\n`, { mode: 0o700 });
  const request: ProviderRequest = { job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider: 'claude', role: 'swe', cwd, prompt_path: prompt, transcript_path: transcript, timeout_ms: 3000, source_access: 'write', auth_profile: 'fake' };
  const adapter = new CliProviderAdapter('claude', { binaries: { claude: binary }, maxOutputBytes: 2_000_000 });
  const lines: string[] = [];
  const result = await adapter.run(request, undefined, (line) => { lines.push(line); throw new Error('progress consumer failed'); });
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(lines, [resultLine]);
});
