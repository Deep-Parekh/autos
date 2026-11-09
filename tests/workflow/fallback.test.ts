import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfigYaml, type GitPrepareRequest, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
let issueOverride: Partial<IssueSnapshot> = {};
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', ...issueOverride } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');

type Fail = { code: string; status?: 'FAILED' | 'TIMED_OUT' | 'CANCELLED'; edit?: boolean; times?: number };
interface Script {
  digest: number; fails: Map<string, Fail[]>; outputs: Map<string, unknown[]>; requests: Array<{ provider: string; role: string; model?: string; auth_profile: string; prompt_path: string }>; commits: number;
}
const newScript = (): Script => ({ digest: 1, fails: new Map(), outputs: new Map(), requests: [], commits: 0 });
const failWith = (s: Script, key: string, ...fails: Fail[]) => s.fails.set(key, fails);
const outputWith = (s: Script, key: string, ...outs: unknown[]) => s.outputs.set(key, outs);

function deps(script: Script, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return ['SAMPLE-1']; },
      async listIssues() { return [issue('SAMPLE-1')]; },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}` } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digest), paths: ['src/Fix.java'], diff: `+ fixed v${script.digest}` }; },
      async commit(req) { script.commits++; return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        script.requests.push({ provider: req.provider, role: req.role, ...(req.model ? { model: req.model } : {}), auth_profile: req.auth_profile, prompt_path: req.prompt_path });
        const key = `${req.provider}:${req.role}`;
        const base = { provider: req.provider, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        const fails = script.fails.get(key); const next = fails?.[0];
        if (next) {
          if (next.times !== undefined && --next.times <= 0) fails!.shift();
          if (next.edit) script.digest++;
          return { ...base, status: next.status ?? 'FAILED', exit_code: 1, error_code: next.code } as unknown as ProviderResult;
        }
        if (req.role === 'swe') { script.digest++; return { ...base, result: 'Implemented.' } as ProviderResult; }
        const queued = script.outputs.get(key); if (queued?.length) return { ...base, result: queued.shift() } as ProviderResult;
        const d = sha(script.digest);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-fallback-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
  config.agents.swe = { ...config.agents.swe, provider: 'claude', fallbacks: [{ provider: 'codex' }, { provider: 'cursor', model: 'auto' }] };
  config.agents.qa = { ...config.agents.qa, provider: 'codex', fallbacks: [{ provider: 'claude' }, { provider: 'cursor', model: 'auto' }] };
  config.agents.reviewer = { ...config.agents.reviewer, provider: 'cursor', model: 'auto', fallbacks: [{ provider: 'claude' }, { provider: 'codex' }] };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (script: Script, file = 'jobs.sqlite') => {
  const store = new SqliteJobStore(join(root, file)); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, service: new WorkflowService(deps(script, store, artifacts)) };
};
const readJson = async (jobId: string, name: string) => JSON.parse(await readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8')) as Record<string, any>;
const run = async (script: Script) => { const { store, service } = open(script); const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id); const events = await service.events({ job_id: job.job_id, limit: 500 }); store.close(); return { job, events }; };
const providers = (s: Script, role: string) => s.requests.filter((r) => r.role === role).map((r) => r.provider);
const fallbackEvents = (events: Array<{ type: string }>) => events.filter((e) => e.type === 'provider_fallback') as Array<Record<string, any>>;
const attemptsOf = (rounds: Record<string, any>) => (rounds.rounds as Array<Record<string, any>>).flatMap((r) => r.provider_attempts as Array<Record<string, any>>);

describe('per-role provider fallbacks', () => {
  it('QA rate limit exhausts same-provider retries, then falls back to claude and finishes READY_FOR_HUMAN', async () => {
    const s = newScript(); failWith(s, 'codex:qa', { code: 'RATE_LIMIT' });
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(providers(s, 'qa'), ['codex', 'codex', 'codex', 'claude']);
    const fb = fallbackEvents(events); assert.equal(fb.length, 1);
    assert.equal(fb[0]!.role, 'qa'); assert.equal(fb[0]!.provider, 'claude'); assert.equal(fb[0]!.from_provider, 'codex'); assert.equal(fb[0]!.code, 'RATE_LIMIT'); assert.equal(fb[0]!.stage, 'qa'); assert.equal(fb[0]!.repair_round, 0);
    assert.ok(!/codex|claude/.test(String(fb[0]!.message)));
    const started = events.filter((e) => e.type === 'role_started' && (e as any).role === 'qa').map((e) => (e as any).provider);
    assert.deepEqual(started, ['codex', 'claude']); // one role_started per provider attempt; same-provider retries stay inside it
    const attempts = attemptsOf(await readJson(job.job_id, 'rounds.json')).filter((a) => a.role === 'qa');
    assert.deepEqual(attempts.map((a) => [a.provider, a.chain_index, a.status, a.error_code, a.fell_back]), [['codex', 0, 'FAILED', 'RATE_LIMIT', true], ['claude', 1, 'SUCCEEDED', null, false]]);
    const summary = await readFile(join(config.storage.artifacts_dir, job.job_id, 'summary.md'), 'utf8');
    assert.match(summary, /QA: claude \(fallback after codex RATE_LIMIT\)/); assert.match(summary, /SWE: claude\n/); assert.match(summary, /Reviewer: cursor\n/);
  });

  it('SWE UNAVAILABLE with an untouched workspace falls back to codex with its own auth profile', async () => {
    const s = newScript(); failWith(s, 'claude:swe', { code: 'UNAVAILABLE' });
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.deepEqual(providers(s, 'swe'), ['claude', 'codex']);
    assert.equal(s.requests.find((r) => r.provider === 'codex' && r.role === 'swe')!.auth_profile, config.providers.codex.auth_profile);
    const prompts = s.requests.filter((r) => r.role === 'swe').map((r) => r.prompt_path); assert.equal(new Set(prompts).size, 2, 'fresh private prompt per attempt');
    const fb = fallbackEvents(events); assert.equal(fb.length, 1); assert.equal(fb[0]!.role, 'swe'); assert.equal(fb[0]!.provider, 'codex'); assert.equal(fb[0]!.from_provider, 'claude'); assert.equal(fb[0]!.code, 'UNAVAILABLE');
    const attempts = attemptsOf(await readJson(job.job_id, 'rounds.json')).filter((a) => a.role === 'swe');
    assert.deepEqual(attempts.map((a) => [a.provider, a.status, a.error_code, a.fell_back]), [['claude', 'FAILED', 'UNAVAILABLE', true], ['codex', 'SUCCEEDED', null, false]]);
  });

  it('SWE failure after editing the workspace blocks without falling back', async () => {
    const s = newScript(); failWith(s, 'claude:swe', { code: 'UNAVAILABLE', edit: true });
    const { job, events } = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'UNAVAILABLE'); assert.match(job.blocked_reason ?? '', /fallback refused/);
    assert.deepEqual(providers(s, 'swe'), ['claude']); assert.equal(fallbackEvents(events).length, 0); assert.equal(s.commits, 0);
    const attempts = attemptsOf(await readJson(job.job_id, 'rounds.json'));
    assert.deepEqual(attempts.map((a) => [a.provider, a.status, a.fell_back]), [['claude', 'FAILED', false]]);
  });

  it('reviewer malformed output counts as INVALID_OUTPUT and falls back; cursor runs with model auto', async () => {
    const s = newScript(); outputWith(s, 'cursor:reviewer', 'this is not json', 'still not json'); // malformed twice: one same-provider re-ask, then fallback
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.deepEqual(providers(s, 'reviewer'), ['cursor', 'cursor', 'claude']);
    assert.equal(s.requests.find((r) => r.provider === 'cursor' && r.role === 'reviewer')!.model, 'auto');
    const fb = fallbackEvents(events); assert.equal(fb.length, 1); assert.equal(fb[0]!.role, 'reviewer'); assert.equal(fb[0]!.provider, 'claude'); assert.equal(fb[0]!.from_provider, 'cursor'); assert.equal(fb[0]!.code, 'INVALID_OUTPUT');
    const summary = await readFile(join(config.storage.artifacts_dir, job.job_id, 'summary.md'), 'utf8'); assert.match(summary, /Reviewer: claude \(fallback after cursor INVALID_OUTPUT\)/);
  });

  it('a review FAIL verdict is a valid result: it triggers a repair round, not a fallback', async () => {
    const s = newScript();
    outputWith(s, 'cursor:reviewer', { schema_version: 1, candidate_digest: sha(1 + 1), status: 'FAIL', findings: [{ severity: 'HIGH', file: 'src/Fix.java', line: 1, issue: 'bug', suggested_fix: 'fix' }] });
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.equal(fallbackEvents(events).length, 0);
    assert.deepEqual(providers(s, 'reviewer'), ['cursor', 'cursor']); assert.deepEqual(providers(s, 'swe'), ['claude', 'claude']);
  });

  it('repair rounds restart each role at the primary provider', async () => {
    const s = newScript(); failWith(s, 'codex:qa', { code: 'UNAVAILABLE', times: 1 });
    outputWith(s, 'claude:qa', { schema_version: 1, candidate_digest: sha(2), status: 'FAIL', evidence: ['broken'] });
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(providers(s, 'qa'), ['codex', 'claude', 'codex']); assert.equal(fallbackEvents(events).length, 1);
    const rounds = (await readJson(job.job_id, 'rounds.json')).rounds as Array<Record<string, any>>;
    assert.equal(rounds.length, 2);
    assert.deepEqual(rounds[1]!.provider_attempts.map((a: any) => [a.role, a.provider, a.chain_index]), [['swe', 'claude', 0], ['qa', 'codex', 0], ['reviewer', 'cursor', 0]]);
  });

  it('CANCELLED never falls back', async () => {
    const s = newScript(); failWith(s, 'codex:qa', { code: 'CANCELLED', status: 'CANCELLED' });
    const { job, events } = await run(s);
    assert.notEqual(job.state, 'READY_FOR_HUMAN'); assert.deepEqual(providers(s, 'qa'), ['codex']); assert.equal(fallbackEvents(events).length, 0);
  });

  it('non-fallback codes such as TOOL stop the chain', async () => {
    const s = newScript(); failWith(s, 'codex:qa', { code: 'TOOL' });
    const { job } = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'TOOL'); assert.deepEqual(providers(s, 'qa'), ['codex']);
  });

  it('exhausting the chain blocks with the last code, records every attempt in order, and cursor gets model auto', async () => {
    const s = newScript(); failWith(s, 'codex:qa', { code: 'UNAVAILABLE' }); failWith(s, 'claude:qa', { code: 'AUTH' }); failWith(s, 'cursor:qa', { code: 'TIMEOUT', status: 'TIMED_OUT' });
    const { job, events } = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'TIMEOUT');
    assert.deepEqual(providers(s, 'qa'), ['codex', 'claude', 'cursor']); assert.equal(s.requests.find((r) => r.provider === 'cursor')!.model, 'auto');
    assert.deepEqual(fallbackEvents(events).map((e) => [e.provider, e.from_provider, e.code]), [['claude', 'codex', 'UNAVAILABLE'], ['cursor', 'claude', 'AUTH']]);
    const attempts = attemptsOf(await readJson(job.job_id, 'rounds.json')).filter((a) => a.role === 'qa');
    assert.deepEqual(attempts.map((a) => [a.provider, a.chain_index, a.status, a.error_code, a.fell_back]), [['codex', 0, 'FAILED', 'UNAVAILABLE', true], ['claude', 1, 'FAILED', 'AUTH', true], ['cursor', 2, 'TIMED_OUT', 'TIMEOUT', false]]);
    assert.equal(s.commits, 0);
  });

  it('without fallbacks behaves as a single provider', async () => {
    config.agents.qa = { ...config.agents.qa, fallbacks: [] };
    const s = newScript(); failWith(s, 'codex:qa', { code: 'UNAVAILABLE' });
    const { job, events } = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'UNAVAILABLE'); assert.deepEqual(providers(s, 'qa'), ['codex']); assert.equal(fallbackEvents(events).length, 0);
    const attempts = attemptsOf(await readJson(job.job_id, 'rounds.json')).filter((a) => a.role === 'qa');
    assert.deepEqual(attempts.map((a) => [a.provider, a.fell_back]), [['codex', false]]);
  });

  it('SWE RATE_LIMIT without edits still retries the same provider', async () => {
    const s = newScript(); failWith(s, 'claude:swe', { code: 'RATE_LIMIT', times: 2 });
    const { job, events } = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.deepEqual(providers(s, 'swe'), ['claude', 'claude', 'claude']); assert.equal(fallbackEvents(events).length, 0);
  });

  it('writes summary.md and a manifest with the final status before job_finished is emitted for every terminal outcome', async () => {
    const observed: Array<{ state: string; summary: boolean; manifest: string | undefined }> = [];
    const watch = (service: WorkflowService) => service.subscribe((event) => {
      if (event.type !== 'job_finished') return;
      const dir = join(config.storage.artifacts_dir, String(event.job_id)); // listener failures are swallowed, so record and assert afterwards
      observed.push({ state: String(event.state), summary: existsSync(join(dir, 'summary.md')), manifest: existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).status : undefined });
    });
    const s1 = newScript(); const a = open(s1); watch(a.service); await a.service.execute((await a.service.submit('SAMPLE-1', false)).job_id); a.store.close();
    const s2 = newScript(); failWith(s2, 'codex:qa', { code: 'TOOL' }); const b = open(s2, 'b.sqlite'); watch(b.service); await b.service.execute((await b.service.submit('SAMPLE-1', false)).job_id); b.store.close();
    const s3 = newScript(); const c = open(s3, 'c.sqlite'); watch(c.service); await c.service.execute((await c.service.submit('SAMPLE-1', true)).job_id); c.store.close();
    const s4 = newScript(); const d = open(s4, 'd.sqlite'); watch(d.service); const queued = await d.service.submit('SAMPLE-1', false); await d.service.cancel(queued.job_id); d.store.close();
    assert.deepEqual(observed.map((o) => o.state), ['READY_FOR_HUMAN', 'BLOCKED', 'PLANNED', 'CANCELLED']);
    for (const o of observed) { assert.equal(o.summary, true, `${o.state} summary exists at job_finished`); assert.equal(o.manifest, o.state, `${o.state} manifest status at job_finished`); }
  });

  it('cancel survives the job advancing between its read and its transition', async () => {
    const s = newScript(); const store = new SqliteJobStore(join(root, 'race.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
    const service = new WorkflowService(deps(s, store, artifacts)); const job = await service.submit('SAMPLE-1', false);
    // Concurrent progress: right after cancel reads the QUEUED job, a runner claims it and moves it on, so cancel's first transition conflicts.
    const realGet = store.get.bind(store); let raced = false;
    store.get = async (id: string) => { const row = await realGet(id); if (!raced && row?.state === 'QUEUED') { raced = true; assert.ok(await store.transition(id, 'QUEUED', 'INVESTIGATING', { updated_at: new Date().toISOString() })); } return row; };
    const cancelled = await service.cancel(job.job_id);
    assert.equal(raced, true); assert.equal(cancelled.state, 'CANCELLED');
    store.close();
  });
});
