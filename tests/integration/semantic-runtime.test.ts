import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, parseConfigYaml, type AtlassianReadPort, type RunnerPort } from '@autos/contracts';
import { createRuntime } from '@autos/controller';
import { judgeEntries } from '../../apps/controller/src/runtime.js';

const atlassian: AtlassianReadPort = {
  getSavedFilter: async () => ({ id: '12345', name: 'Synthetic', jql: 'key = SAMPLE-1' }),
  listIssueKeys: async () => [], listIssues: async () => [], getIssue: async () => { throw new Error('not used'); }, getBranchMap: async () => [],
};
const runner: RunnerPort = {
  runRole: async () => { throw new Error('not used'); }, runChecks: async () => { throw new Error('not used'); }, stop: async () => undefined,
};

async function exampleConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(parseConfigYaml(await readFile('config/config.example.yaml', 'utf8')))) as Record<string, unknown>;
}

async function withRuntime(config: Record<string, unknown>, body: (runtime: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-semantic-runtime-')));
  const configPath = join(root, 'config.yaml');
  await writeFile(configPath, JSON.stringify(config));
  const runtime = await createRuntime({ cwd: root, configPath, env: {}, atlassian, runner, precedents: { findPrecedents: async () => ({ outcome: 'NO_MATCH' as const, items: [] }) } });
  try { await body(runtime); } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}

test('without precedents or drafts config the runtime exposes no new services (legacy behaviour)', async () => {
  await withRuntime(await exampleConfig(), async (runtime) => {
    assert.equal((runtime as { precedentIndex?: unknown }).precedentIndex, undefined);
    assert.equal(runtime.workflow.createFixDocumentDraft, undefined);
  });
});

test('legacy source builds the index for evaluation but jobs keep the legacy lookup; disabled builds nothing', async () => {
  const config = await exampleConfig();
  config.precedents = { enabled: true, source: 'legacy', index: { auto_sync: false } };
  await withRuntime(config, async (runtime) => {
    const index = (runtime as { precedentIndex?: { status(): Promise<{ source: string; ready: boolean }> } }).precedentIndex;
    assert.ok(index);
    assert.equal((await index.status()).source, 'legacy');
  });
  config.precedents = { enabled: false, source: 'semantic' };
  await withRuntime(config, async (runtime) => {
    assert.equal((runtime as { precedentIndex?: unknown }).precedentIndex, undefined);
  });
});

test('semantic source wires an index that reports not-ready without any network call', async () => {
  const config = await exampleConfig();
  config.precedents = { enabled: true, source: 'semantic', index: { auto_sync: false } };
  await withRuntime(config, async (runtime) => {
    const index = (runtime as { precedentIndex?: { status(): Promise<{ ready: boolean; source: string; issues: number }> } }).precedentIndex;
    assert.ok(index, 'precedentIndex is exposed');
    const status = await index.status();
    assert.equal(status.ready, false);
    assert.equal(status.source, 'semantic');
    assert.equal(status.issues, 0);
  });
});

test('confluence drafts config exposes the draft command; missing credentials fail only when used', async () => {
  const config = await exampleConfig();
  (config.confluence as Record<string, unknown>).drafts = { enabled: true, space_key: 'ENG', parent_page_id: '42' };
  await withRuntime(config, async (runtime) => {
    assert.equal(typeof runtime.workflow.createFixDocumentDraft, 'function');
  });
});

test('config validation: lineage repositories must be allowlisted, ollama needs model and dimensions, judge tier must exist', async () => {
  const base = await exampleConfig();
  const bad = (precedents: unknown) => { const c = { ...base, precedents }; assert.throws(() => parseConfig(c), /precedents/); };
  bad({ enabled: true, source: 'semantic', lineages: [{ id: 'core', repository: { workspace: 'nobody', repository_slug: 'unknown' }, root_branch: 'main' }] });
  bad({ enabled: true, source: 'semantic', embedding: { provider: 'ollama' } });
  bad({ enabled: true, source: 'semantic', embedding: { provider: 'ollama', model: 'qwen3-embedding:0.6b' } });
  bad({ enabled: true, source: 'semantic', judge: { tier: 'missing' } });
  const ok = parseConfig({ ...base, precedents: { enabled: true, source: 'semantic', embedding: { provider: 'ollama', model: 'qwen3-embedding:0.6b', dimensions: 1024 } } });
  assert.equal(ok.precedents?.index.window_weeks, 104);
  assert.deepEqual(ok.precedents?.prompt.roles, []);
  assert.deepEqual(ok.precedents?.lineages, []);
});

test('judge uses the cheapest model: configured tier, else reviewer lowest ladder tier, else reviewer chain, at low effort', async () => {
  const base = await exampleConfig();
  const plain = parseConfig({ ...base, precedents: { enabled: true, source: 'semantic' } });
  const chain = judgeEntries(plain);
  assert.equal(chain[0]!.provider, plain.agents.reviewer.provider);
  for (const entry of chain) if (entry.provider !== 'cursor') assert.equal(entry.effort, 'low');

  const tiered = parseConfig({ ...base,
    model_tiers: { sm: [{ provider: 'claude', model: 'claude-haiku-5-5' }], lg: [{ provider: 'claude', model: 'claude-opus-5-5' }] },
    precedents: { enabled: true, source: 'semantic', judge: { tier: 'sm' } } });
  assert.deepEqual(judgeEntries(tiered).map((e) => [e.model, e.effort]), [['claude-haiku-5-5', 'low']]);
  const pinned = parseConfig({ ...base,
    model_tiers: { sm: [{ provider: 'claude', model: 'claude-haiku-5-5' }] },
    precedents: { enabled: true, source: 'semantic', judge: { tier: 'sm:medium' } } });
  assert.equal(judgeEntries(pinned)[0]!.effort, 'medium');
});
