import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseConfigYaml, type JobEvent } from '@autos/contracts';
import { formatEvent, main, type CliDependencies } from '../../apps/cli/src/index.js';
import { createController, listProviders, type ControllerOptions } from '../../apps/controller/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');

async function setup(agents: Record<string, unknown>, binaries: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'autos-fallback-'));
  const raw = parse(canonical) as { agents: unknown };
  raw.agents = agents;
  const path = join(dir, 'autos.yaml');
  await writeFile(path, stringify(raw));
  const bin = join(dir, 'bin');
  await import('node:fs/promises').then((fs) => fs.mkdir(bin));
  for (const name of binaries) { await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, name), 0o755); }
  const config = parseConfigYaml(stringify(raw));
  const env: NodeJS.ProcessEnv = { PATH: bin };
  for (const name of [config.jira.username_env, config.jira.token_env, config.confluence.username_env, config.confluence.token_env, config.api.operator_token_env, ...(config.bitbucket.read_token_env ? [config.bitbucket.read_token_env] : [])]) env[name] = 'x';
  const out: string[] = [];
  const dependencies: CliDependencies = { cwd: dir, stdout: (line) => out.push(line), stderr: () => undefined, env };
  return { dir, path, out, dependencies, config };
}

const chains = {
  swe: { provider: 'claude', fallbacks: [{ provider: 'codex' }, { provider: 'cursor' }] },
  qa: { provider: 'codex', fallbacks: [{ provider: 'claude' }] },
  reviewer: { provider: 'claude', fallbacks: [] },
};

test('doctor reports role chains; a missing fallback binary is a warning, not a failure', async () => {
  const t = await setup(chains, ['claude', 'codex']); // cursor-agent missing
  try {
    assert.equal(await main(['doctor', '--config', t.path, '--json'], t.dependencies), 0);
    const result = JSON.parse(t.out[0]!);
    assert.equal(result.read_only_smoke, 'NOT_RUN');
    const swe = result.roles.find((r: { role: string }) => r.role === 'swe');
    assert.equal(swe.available, true);
    assert.equal(swe.summary, 'swe: claude → codex → cursor(auto) [missing]');
    assert.deepEqual(swe.chain.map((c: { provider: string; model: string | null; binary_present: boolean }) => [c.provider, c.model, c.binary_present]), [['claude', null, true], ['codex', null, true], ['cursor', 'auto', false]]);
    assert.ok(result.warnings.some((w: string) => /swe: fallback provider cursor/.test(w)));
    const cursor = result.providers.find((p: { provider: string }) => p.provider === 'cursor');
    assert.equal(cursor.binary_present, false);
    assert.deepEqual(cursor.roles, [{ role: 'swe', chain_index: 2 }]);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('doctor fails when a role has no present provider at all', async () => {
  const t = await setup(chains, ['codex']); // reviewer chain is claude only
  try {
    assert.equal(await main(['doctor', '--config', t.path, '--json'], t.dependencies), 1);
    const result = JSON.parse(t.out[0]!);
    assert.equal(result.roles.find((r: { role: string }) => r.role === 'reviewer').available, false);
    assert.equal(result.roles.find((r: { role: string }) => r.role === 'swe').available, true);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('doctor warns when a role starts from a fallback because the primary is missing', async () => {
  const t = await setup(chains, ['codex', 'cursor-agent']);
  try {
    assert.equal(await main(['doctor', '--config', t.path, '--json'], t.dependencies), 1); // reviewer: claude only, missing
    assert.ok(JSON.parse(t.out[0]!).warnings.some((w: string) => /swe: primary provider claude binary not found/.test(w)));
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('GET /v1/providers maps roles and chain positions and pins cursor to auto', async () => {
  const t = await setup(chains, []);
  try {
    const diagnostics = (['claude', 'codex', 'cursor'] as const).map((provider) => ({ provider, binary_present: true, authenticated: null, read_only_smoke: 'NOT_RUN' as const, message: 'm' }));
    const options = { config: t.config, workflow: { ...monitorPort() }, operatorToken: 'test-token-that-is-long-enough', artifacts: {}, providers: async () => diagnostics, projects: async () => [], testProviders: async () => [], close: async () => undefined } as unknown as ControllerOptions;
    const app = await createController(options);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: 'Bearer test-token-that-is-long-enough' } });
      assert.equal(response.statusCode, 200);
      const { providers } = response.json() as { providers: Array<{ provider: string; model?: string; roles: Array<{ role: string; chain_index: number }> }> };
      const by = Object.fromEntries(providers.map((p) => [p.provider, p]));
      assert.deepEqual(by.claude!.roles, [{ role: 'swe', chain_index: 0 }, { role: 'qa', chain_index: 1 }, { role: 'reviewer', chain_index: 0 }]);
      assert.deepEqual(by.codex!.roles, [{ role: 'swe', chain_index: 1 }, { role: 'qa', chain_index: 0 }]);
      assert.deepEqual(by.cursor!.roles, [{ role: 'swe', chain_index: 2 }]);
      assert.equal(by.cursor!.model, 'auto');
      assert.equal('model' in by.claude!, false);
    } finally { await app.close(); }
    assert.equal(listProviders(t.config, diagnostics).length, 3);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('autos providers lists role usage through the runtime', async () => {
  const t = await setup(chains, []);
  try {
    const diagnostics = (['claude', 'codex', 'cursor'] as const).map((provider) => ({ provider, binary_present: true, authenticated: null, read_only_smoke: 'NOT_RUN' as const, message: 'm' }));
    const runtime = { config: t.config, providers: async () => diagnostics, close: async () => undefined } as never;
    assert.equal(await main(['providers', '--config', t.path, '--json'], { ...t.dependencies, runtime: async () => runtime }), 0);
    const parsed = JSON.parse(t.out[0]!) as { providers: Array<{ provider: string; model?: string }> };
    assert.equal(parsed.providers.find((p) => p.provider === 'cursor')!.model, 'auto');
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('watch/events render provider_fallback clearly', () => {
  const event: JobEvent = makeEvent(7, { type: 'provider_fallback', role: 'qa', provider: 'claude', code: 'RATE_LIMIT', from_provider: 'codex', message: 'provider fallback', repair_round: 1 });
  assert.equal(formatEvent(event), '12:01:07 SAMPLE-1 QA fallback → claude after codex RATE_LIMIT (round 1)');
  assert.equal(formatEvent(makeEvent(8, { type: 'provider_fallback', role: 'swe', provider: 'cursor', code: 'TIMEOUT', repair_round: undefined } as never)), '12:01:08 SAMPLE-1 SWE fallback → cursor after TIMEOUT');
});
