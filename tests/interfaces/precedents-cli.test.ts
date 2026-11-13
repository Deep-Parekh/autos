import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { AutosError, type AutosConfig, type JobRecord, type PrecedentIndexPort, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { main, type CliDependencies, type CliRuntime } from '../../apps/cli/src/index.js';
import { deepChecks, type DeepRuntime } from '../../apps/cli/src/deep-doctor.js';
import { monitorPort } from './monitor-fake.js';
import { baseConfig, canonicalYaml, draftRecord, fakeIndex, JOB, precedentConfig, SECRET_TEXT } from './precedents-fake.js';

const TOKEN = 'precedents-cli-token-0123456789';
const NOW_MS = Date.parse('2026-11-12T12:00:00.000Z');
const job: JobRecord = { job_id: JOB, issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'READY_FOR_HUMAN', dry_run: false, repair_round: 0, created_at: '2026-11-12T10:00:00.000Z', updated_at: '2026-11-12T10:00:00.000Z' };

async function withCli(input: { config?: AutosConfig; index?: PrecedentIndexPort; draft?: WorkflowServicePort['createFixDocumentDraft']; tty?: boolean; answer?: string },
  run: (ctx: { run(...args: string[]): Promise<number>; out: string[]; err: string[]; prompts: string[] }) => Promise<void>): Promise<void> {
  const config = input.config ?? precedentConfig({ drafts: true });
  const workflow: WorkflowServicePort = { ...monitorPort(), submit: async () => job, execute: async () => job, cancel: async () => job, retry: async () => job, revise: async () => job, poll: async () => undefined, get: async () => job, list: async () => [], ...(input.draft ? { createFixDocumentDraft: input.draft } : {}) };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, onBackgroundFailure: () => undefined,
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined, ...(input.index ? { precedentIndex: input.index } : {}),
  };
  const app = await createController(options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-precedents-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, stringify({ ...config, api: { ...config.api, port } }));
    const out: string[] = []; const err: string[] = []; const prompts: string[] = [];
    const deps: CliDependencies = { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: (l) => out.push(l), stderr: (l) => err.push(l), now: () => NOW_MS, stdinIsTTY: input.tty ?? false, prompt: async (q) => { prompts.push(q); return input.answer ?? 'n'; } };
    await run({ run: (...args) => main(['--config', configPath, ...args], deps), out, err, prompts });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('autos index status prints a concise summary; --json prints the API response', async () => {
  await withCli({ index: fakeIndex() }, async ({ run, out }) => {
    assert.equal(await run('index', 'status'), 0);
    const text = out.join('\n');
    assert.match(text, /^Precedent index: READY \(source semantic\)/);
    assert.match(text, /Issues 120 {2}chunks 340 {2}vectors 340 {2}fixes 31 {2}projects SAMPLE, OTHER/);
    assert.match(text, /Last sync 2026-11-12 11:45Z \(15m ago\)/);
    assert.match(text, /Background loop: off \(auto_sync on, but this controller does not run the loop\)/);
    out.length = 0;
    assert.equal(await run('--json', 'index', 'status'), 0);
    const body = JSON.parse(out.join('\n')); assert.equal(body.index.issues, 120); assert.equal(body.operation, null);
  });
});

test('autos index sync starts a background sync with --full/--reconcile and reports the operation', async () => {
  const index = fakeIndex();
  await withCli({ index }, async ({ run, out, err }) => {
    assert.equal(await run('index', 'sync', '--full', '--reconcile'), 0);
    assert.match(out[0]!, /^Index sync \(full, reconcile\) started at .*autos index status/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(index.calls[0], { kind: 'sync', args: [{ full: true, reconcile: true }] });
    out.length = 0; assert.equal(await run('index', 'status'), 0);
    assert.match(out.join('\n'), /Last operation: sync \(full, reconcile\) finished/); assert.match(out.join('\n'), /MODE +UPSERTED/);
    assert.equal(await run('index', 'sync', '--bogus'), 2); assert.match(err.at(-1)!, /Usage: autos index/);
  });
});

test('autos index rebuild and purge need --yes off a terminal, prompt on a terminal, and validate the project', async () => {
  const index = fakeIndex();
  await withCli({ index }, async ({ run, out, err }) => {
    assert.equal(await run('index', 'rebuild'), 2); assert.match(err.at(-1)!, /--yes/);
    assert.equal(await run('index', 'purge', '--project', 'OTHER'), 2);
    assert.equal(await run('index', 'purge', '--yes'), 2); assert.match(err.at(-1)!, /--project KEY is required/);
    assert.equal(await run('index', 'purge', '--project', 'bad', '--yes'), 2);
    assert.equal(index.calls.length, 0);
    assert.equal(await run('index', 'purge', '--project', 'OTHER', '--yes'), 0);
    assert.match(out.at(-1)!, /Purged 12 indexed issues of OTHER\. Add OTHER to precedents\.index\.exclude_projects/);
    assert.equal(await run('index', 'rebuild', '--yes'), 0); assert.match(out.at(-1)!, /Index rebuild started/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(index.calls.map((call) => call.kind), ['purge', 'rebuild']);
  });
  const quiet = fakeIndex();
  await withCli({ index: quiet, tty: true, answer: 'n' }, async ({ run, out, prompts }) => {
    assert.equal(await run('index', 'rebuild'), 1); assert.match(prompts[0]!, /Rebuild the precedent index/); assert.equal(out.at(-1), 'Aborted; nothing changed.');
    assert.equal(quiet.calls.length, 0);
  });
  const yes = fakeIndex();
  await withCli({ index: yes, tty: true, answer: 'y' }, async ({ run }) => {
    assert.equal(await run('index', 'purge', '--project', 'OTHER'), 0); assert.deepEqual(yes.calls, [{ kind: 'purge', args: ['OTHER'] }]);
  });
});

test('autos lineage show prints nodes, fork points and unattached branches', async () => {
  await withCli({ index: fakeIndex() }, async ({ run, out }) => {
    assert.equal(await run('lineage', 'show'), 0);
    assert.match(out[0]!, /^LINEAGE +PROJECT +BRANCH +FORK POINT +FORK DATE +DEV\/SBX/);
    assert.match(out[1]!, /^core +SAMPLE +release\/sample +abcdef012345 +2021-06-01 +sample_dev \(dev, name\)/);
    assert.equal(out[2], 'Unattached branches: feature/x');
    assert.equal(await run('lineage'), 2);
  });
});

test('autos precedents search sends exactly one of --issue/--text with options and prints shown, also-reported and rejected', async () => {
  const index = fakeIndex();
  await withCli({ index }, async ({ run, out, err }) => {
    assert.equal(await run('precedents', 'search'), 2); assert.match(err.at(-1)!, /Exactly one of --issue or --text/);
    assert.equal(await run('precedents', 'search', '--issue', 'SAMPLE-1', '--text', 'abc def'), 2);
    assert.equal(await run('precedents', 'search', '--issue', 'bad'), 2);
    assert.equal(await run('precedents', 'search', '--text', 'ab'), 2);
    assert.equal(await run('precedents', 'search', '--issue', 'SAMPLE-1', '--limit', '0'), 2);
    assert.equal(index.calls.length, 0);
    assert.equal(await run('precedents', 'search', '--issue', 'SAMPLE-1', '--limit', '5', '--include-unresolved', '--no-judge', '--explain'), 0);
    assert.deepEqual(index.calls[0]!.args, [{ issue_key: 'SAMPLE-1', limit: 5, include_unresolved: true, judge: false, explain: true }]);
    const text = out.join('\n');
    assert.match(text, /^Precedents: FOUND \(3 checked, 1 shown; judge RAN\); index 120 issues/);
    assert.match(text, /FIXED_IN_RELATIVE +OTHER-881 +Done\/Fixed +0\.82 +yes 0\.86 +semantic,lineage +abcdef0123 on release\/projb \(applies\)/);
    assert.match(text, /Same bug may be open in other projects \(never given to agents\):\n.*\nALSO_REPORTED +THIRD-5/);
    assert.match(text, /Rejected: OTHER-77 \(keyword overlap only\)/);
    assert.match(text, /Explain:\n\{"issue_key":"OTHER-881"/);
    out.length = 0;
    assert.equal(await run('--json', 'precedents', 'search', '--text', SECRET_TEXT), 0);
    assert.deepEqual(index.calls[1]!.args, [{ text: SECRET_TEXT, include_unresolved: false, judge: true, explain: false }]);
    assert.equal(JSON.parse(out.join('\n')).result.outcome, 'FOUND');
  });
});

test('autos precedents show prints the index record; an unknown key shows the controller reason', async () => {
  await withCli({ index: fakeIndex() }, async ({ run, out, err }) => {
    assert.equal(await run('precedents', 'show', 'OTHER-881'), 0); assert.equal(JSON.parse(out.join('\n')).issue_key, 'OTHER-881');
    assert.equal(await run('precedents', 'show', 'OTHER-1'), 1);
    assert.deepEqual(JSON.parse(err.at(-1)!), { error: { code: 'NOT_FOUND', message: 'Controller: Issue is not in the precedent index' } });
    assert.equal(await run('precedents', 'show'), 2);
  });
});

test('autos confluence draft prints the edit link and the visibility note; refusals are explained', async () => {
  const targets: string[] = [];
  await withCli({ draft: async (target) => { targets.push(target); return draftRecord(); } }, async ({ run, out, err }) => {
    assert.equal(await run('confluence', 'draft', JOB), 0);
    assert.equal(await run('confluence', 'draft', 'SAMPLE-1'), 0);
    assert.deepEqual(targets, [JOB, 'SAMPLE-1']);
    const text = out.join('\n');
    assert.match(text, /Confluence draft for SAMPLE-1 \(job .*\): page 777, version 1/);
    assert.match(text, /Edit: https:\/\/example\.atlassian\.net\/wiki\/pages\/resumedraft\.action\?draftId=777/);
    assert.match(text, /visible only to the Atlassian account whose token the controller uses\. Review it and publish it yourself in Confluence; Autos never publishes\./);
    assert.equal(await run('confluence', 'draft', 'nope'), 2); assert.match(err.at(-1)!, /Usage: autos confluence draft/);
    assert.equal(await run('confluence', 'publish', 'SAMPLE-1'), 2);
  });
  await withCli({ draft: async () => { throw new AutosError('CONFLICT', 'Only a READY_FOR_HUMAN attempt has a fix document'); } }, async ({ run, err }) => {
    assert.equal(await run('confluence', 'draft', 'SAMPLE-1'), 1); assert.equal(JSON.parse(err.at(-1)!).error.code, 'CONFLICT');
  });
  await withCli({ config: precedentConfig() }, async ({ run, err }) => {
    assert.equal(await run('confluence', 'draft', 'SAMPLE-1'), 1);
    assert.deepEqual(JSON.parse(err.at(-1)!), { error: { code: 'NOT_FOUND', message: 'Controller: Confluence drafts are not configured (confluence.drafts.enabled)' } });
  });
});

test('new commands report a missing precedent index, an unreachable controller and a missing token clearly', async () => {
  await withCli({ config: baseConfig }, async ({ run, err }) => {
    for (const args of [['index', 'status'], ['lineage', 'show'], ['precedents', 'search', '--issue', 'SAMPLE-1']]) {
      assert.equal(await run(...args), 1); assert.match(JSON.parse(err.at(-1)!).error.message, /^Controller: Precedent index is not configured/);
    }
    assert.equal(await run('index', 'status', '--url', 'http://127.0.0.1:9'), 1); assert.match(err.at(-1)!, /not reachable/);
  });
  const dir = await mkdtemp(join(tmpdir(), 'autos-precedents-token-'));
  try {
    const configPath = join(dir, 'c.yaml'); await writeFile(configPath, canonicalYaml); const err: string[] = [];
    assert.equal(await main(['--config', configPath, 'index', 'status'], { cwd: dir, env: {}, stdout: () => undefined, stderr: (l) => err.push(l) }), 1);
    assert.match(err[0]!, /Operator token environment variable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- doctor ----

async function doctorRun(config: AutosConfig, files: (dir: string) => Promise<void> = async () => undefined): Promise<Record<string, unknown> & { warnings: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'autos-precedents-doctor-'));
  try {
    await files(dir);
    const configPath = join(dir, 'c.yaml'); await writeFile(configPath, stringify(config)); const out: string[] = [];
    await main(['--config', configPath, '--json', 'doctor'], { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: () => undefined });
    return JSON.parse(out.join('\n'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('autos doctor output is unchanged when precedents and drafts are absent', async () => {
  const result = await doctorRun(baseConfig);
  assert.deepEqual(Object.keys(result), ['config_valid', 'env_references', 'providers', 'roles', 'warnings', 'provider_checks', 'authentication', 'read_only_smoke']);
  assert.ok(result.warnings.every((warning) => !/precedent|confluence_drafts/.test(warning)));
});

test('autos doctor checks precedents offline: config, index file, lineages, embedding; missing pieces only warn', async () => {
  const missing = await doctorRun(precedentConfig({ lineage: false }));
  const checks = missing.precedents as Array<{ name: string; status: string; message: string }>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [['precedents_config', 'PASS'], ['precedents_index_file', 'WARN'], ['precedents_lineages', 'WARN'], ['precedents_embedding', 'PASS'], ['precedents_gate', 'WARN']]);
  assert.ok(missing.warnings.some((warning) => /^precedents_index_file: .*precedents\.sqlite not found/.test(warning)));
  assert.equal(missing.confluence_drafts, undefined);
  const present = await doctorRun(precedentConfig({ drafts: true }), async (dir) => {
    await mkdir(join(dir, baseConfig.storage.data_dir), { recursive: true });
    const file = join(dir, baseConfig.storage.data_dir, 'precedents.sqlite'); await writeFile(file, 'x'); await chmod(file, 0o600);
  });
  const named = new Map((present.precedents as Array<{ name: string; status: string; message: string }>).map((check) => [check.name, check]));
  assert.equal(named.get('precedents_index_file')!.status, 'PASS'); assert.equal(named.get('precedents_lineages')!.status, 'PASS');
  assert.match(named.get('precedents_embedding')!.message, /ollama model example-embed:0\.6b \(1024 dims\)/);
  assert.deepEqual((present.confluence_drafts as Array<{ status: string }>).map((check) => check.status), ['PASS']);
  const disabled = await doctorRun(precedentConfig({ enabled: false }));
  assert.equal((disabled.precedents as Array<{ status: string }>)[0]!.status, 'WARN');
});

test('autos doctor --deep adds index status and lineage summary only when precedents are configured', async () => {
  const runtime = (index?: PrecedentIndexPort) => ({ runnerHealth: async () => ({ status: 'unknown' as const }), projects: async () => [], ...(index ? { precedentIndex: index } : {}) }) as unknown as DeepRuntime;
  const deep = (config: AutosConfig, rt: DeepRuntime) => deepChecks({ config, env: {}, cwd: '/nonexistent-autos-test', runtime: rt, deps: { freeBytes: async () => 100 * 1024 ** 3 } });
  const names = (results: Array<{ name: string }>) => results.map((result) => result.name).filter((name) => name.startsWith('precedents'));
  assert.deepEqual(names(await deep(baseConfig, runtime(fakeIndex()))), []);
  const ok = await deep(precedentConfig(), runtime(fakeIndex()));
  assert.deepEqual(ok.filter((r) => r.name.startsWith('precedents')).map((r) => [r.name, r.status]), [['precedents_index', 'PASS'], ['precedents_lineage', 'PASS']]);
  assert.match(ok.find((r) => r.name === 'precedents_lineage')!.message, /1 node\(s\) across 1 lineage\(s\); 1 unattached branch\(es\)/);
  const failing = await deep(precedentConfig(), runtime(fakeIndex({ status: async () => { throw new AutosError('UPSTREAM', SECRET_TEXT); }, lineage: async () => ({ nodes: [], unattached: [], missing: ['SAMPLE'] }) })));
  assert.deepEqual(failing.filter((r) => r.name.startsWith('precedents')).map((r) => [r.name, r.status, r.message]), [['precedents_index', 'WARN', 'index status unavailable (UPSTREAM)'], ['precedents_lineage', 'WARN', '0 node(s) across 0 lineage(s); missing: SAMPLE']]);
  const absent = await deep(precedentConfig(), runtime());
  assert.deepEqual(absent.filter((r) => r.name.startsWith('precedents')).map((r) => r.status), ['WARN']);
});

test('controller start runs the index loop when configured, logs one line per tick, and stops it on shutdown', async () => {
  const index = fakeIndex(); const stop = new AbortController();
  const config = precedentConfig();
  const dir = await mkdtemp(join(tmpdir(), 'autos-precedents-start-'));
  try {
    const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise((resolve) => probe.close(resolve));
    const configPath = join(dir, 'c.yaml'); await writeFile(configPath, stringify({ ...config, api: { ...config.api, port } }));
    const workflow: WorkflowServicePort = { ...monitorPort(), submit: async () => job, execute: async () => job, cancel: async () => job, retry: async () => job, revise: async () => job, poll: async () => undefined, get: async () => job, list: async () => [], discover: async () => ({ discovered: 0, queued: 0 }), drain: async () => undefined };
    const rt: CliRuntime = { config, workflow, precedentIndex: index, artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } }, providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined };
    const err: string[] = [];
    let listening = false;
    const done = main(['--config', configPath, 'controller', 'start'], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, signal: stop.signal, runtime: async () => rt, stdout: () => undefined, stderr: (l) => err.push(l), onListening: () => { listening = true; }, indexLoop: { initialDelayMs: 1, intervalMs: 10 }, sleep: (_ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) resolve(); signal.addEventListener('abort', () => resolve(), { once: true }); }) });
    for (let i = 0; i < 200 && !listening; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(listening, err.join('\n'));
    for (let i = 0; i < 200 && index.ticks < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(index.ticks >= 2, 'ticks while the controller runs');
    stop.abort();
    assert.equal(await done, 0);
    const after = index.ticks; await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(index.ticks, after, 'loop stopped on shutdown');
    const ticks = err.filter((line) => line.includes('"event":"index_tick"'));
    assert.ok(ticks.length >= 1); assert.match(ticks[0]!, /"issues":120/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
