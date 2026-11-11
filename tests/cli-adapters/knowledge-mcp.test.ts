import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CliProviderAdapter, type KnowledgeMcpServer } from '../../packages/cli-adapters/src/index.js';
import type { Provider, ProviderRequest } from '@autos/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const TOKEN = 'k'.repeat(43);
const server: KnowledgeMcpServer = { command: '/usr/local/bin/node', args: ['/opt/autos/docker/worker/knowledge-mcp.mjs'], env: { AUTOS_KNOWLEDGE_URL: 'http://host.docker.internal:8791', AUTOS_KNOWLEDGE_TOKEN: TOKEN } };

/** Runs a fake CLI that records its arguments (one per line) and echoes the token, and returns the recorded argv + stored transcript. */
async function invoke(provider: Provider, role: 'swe' | 'qa', knowledgeMcp?: KnowledgeMcpServer) {
  const root = await mkdtemp(join(tmpdir(), 'autos-kmcp-')); roots.push(root);
  const cwd = join(root, 'workspace'); const artifacts = join(root, 'artifacts');
  await mkdir(cwd); await mkdir(artifacts);
  const prompt = join(artifacts, 'prompt'); const transcript = join(artifacts, 'transcript'); const argsFile = join(root, 'args.txt');
  await writeFile(prompt, 'test');
  const binary = join(root, 'fake-cli');
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: `saw ${TOKEN}` });
  await writeFile(binary, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argsFile}'; done\ncat > /dev/null\nprintf '%s\\n' '${resultLine}'\n`, { mode: 0o700 });
  const request: ProviderRequest = { job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-12', provider, role, cwd, prompt_path: prompt, transcript_path: transcript, timeout_ms: 5000, source_access: role === 'swe' ? 'write' : 'read', auth_profile: 'fake' };
  await new CliProviderAdapter(provider, { binaries: { [provider]: binary }, ...(knowledgeMcp ? { knowledgeMcp } : {}) }).run(request);
  return { argv: (await readFile(argsFile, 'utf8')).split('\n').filter(Boolean), transcript: await readFile(transcript, 'utf8').catch(() => '') };
}
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? '';

test('claude gets only the Autos knowledge MCP server, allowed by name, for every role', async () => {
  for (const role of ['swe', 'qa'] as const) {
    const { argv, transcript } = await invoke('claude', role, server);
    assert.deepEqual(JSON.parse(after(argv, '--mcp-config')), { mcpServers: { autos_knowledge: server } });
    assert.ok(argv.includes('--strict-mcp-config'), 'no other MCP configuration is loaded');
    assert.match(after(argv, '--allowedTools'), /,mcp__autos_knowledge$/);
    assert.doesNotMatch(after(argv, '--tools'), /mcp__/);
    assert.doesNotMatch(transcript, new RegExp(TOKEN), 'the per-run token is redacted from the stored transcript');
  }
  const plain = await invoke('claude', 'qa');
  assert.equal(plain.argv.includes('--mcp-config'), false); assert.doesNotMatch(after(plain.argv, '--allowedTools'), /mcp__/);
});

test('codex gets -c mcp_servers overrides; cursor gets --approve-mcps; without a session neither changes', async () => {
  const codex = (await invoke('codex', 'swe', server)).argv;
  assert.ok(codex.includes('mcp_servers.autos_knowledge.command="/usr/local/bin/node"'));
  assert.ok(codex.includes('mcp_servers.autos_knowledge.args=["/opt/autos/docker/worker/knowledge-mcp.mjs"]'));
  assert.ok(codex.includes(`mcp_servers.autos_knowledge.env={AUTOS_KNOWLEDGE_URL="http://host.docker.internal:8791",AUTOS_KNOWLEDGE_TOKEN="${TOKEN}"}`));
  assert.equal(codex.at(-1), '-', 'the prompt still arrives on stdin');
  assert.equal((await invoke('codex', 'swe')).argv.some((arg) => arg.startsWith('mcp_servers.')), false);
  assert.ok((await invoke('cursor', 'qa', server)).argv.includes('--approve-mcps'));
  assert.equal((await invoke('cursor', 'qa')).argv.includes('--approve-mcps'), false);
});
