import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, type WorkflowDependencies, type JobRecord, type IssueSnapshot, type ProjectMapping, type GitWorkspace } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'A small fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', comments: [], linked_issue_keys: [], components: [], url: `https://example.atlassian.net/browse/${key}` });
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 1, fetched_at: '2026-11-07T20:00:00.000Z' } };
const digest = 'a'.repeat(64);

function dependencies(store: SqliteJobStore, artifacts: FileArtifactStore, state: { calls: string[]; keys: string[] }): WorkflowDependencies {
  const issues = new Map(state.keys.map((key) => [key, issue(key)]));
  const atlassian = {
    async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
    async listIssueKeys() { return [...state.keys]; },
    async listIssues() { return [...issues.values()]; },
    async getIssue(key: string) { const found = issues.get(key); if (!found) throw new Error('missing issue'); return found; },
    async getBranchMap() { return [mapping]; },
  };
  const workspace = (job: JobRecord): GitWorkspace => ({ job_id: job.job_id, issue_key: job.issue_key, repository: config.bitbucket.allowed_repositories[0]!, directory: join(root, 'workspace'), base_sha: 'b'.repeat(40), development_branch: 'develop', feature_branch: `deep/${job.issue_key}` });
  const git = {
    async resolveBase() { state.calls.push('resolveBase'); return { base_sha: 'b'.repeat(40), development_branch: 'develop' }; },
    async prepare(req: {job_id:string;issue_key:string}) { state.calls.push('prepare'); return { job_id: req.job_id, issue_key: req.issue_key, repository: config.bitbucket.allowed_repositories[0]!, directory: join(root, 'workspace'), base_sha: 'b'.repeat(40), development_branch: 'develop', feature_branch: `deep/${req.issue_key}` }; },
    async inspectCandidate() { return { digest, paths: ['src/Fix.java'], diff: '+ fixed' }; },
    async commit(req: {candidate_digest:string;approved_paths:string[]}) { state.calls.push('commit'); return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
    async readInstructionFiles(ws: GitWorkspace) { const files: Array<{ path: string; blob_sha: string; content: string }> = []; for (const path of ['AGENTS.md', 'src/AGENTS.md']) { try { files.push({ path, blob_sha: 'a'.repeat(40), content: await readFile(join(ws.directory, path), 'utf8') }); } catch { /* absent */ } } return files; },
    async takeHandoff() { return null; },
    async push(_ws: GitWorkspace, sha: string) { return { status: 'DISABLED' as const, commit_sha: sha }; },
  };
  const runner = {
    async runRole(req: {role:string;source_access:string}) {
      state.calls.push(`role:${req.role}:${req.source_access}`);
      const result = req.role === 'qa' ? { schema_version: 1, candidate_digest: digest, status: 'PASS', evidence: ['Acceptance criteria checked'] }
        : req.role === 'reviewer' ? { schema_version: 1, candidate_digest: digest, status: 'PASS', findings: [] } : 'Implemented.';
      return { provider: req.role === 'qa' ? 'codex' as const : req.role === 'reviewer' ? 'cursor' as const : 'claude' as const, role: req.role as 'swe'|'qa'|'reviewer', status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 2, transcript_path: join(root, 'restricted-transcript.jsonl'), result };
    },
    async runChecks(_ws: GitWorkspace, candidate_digest: string, commands: typeof config.build_profiles[string]['checks']) {
      state.calls.push('checks'); return { schema_version: 1 as const, candidate_digest, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS' as const, exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) };
    },
    async stop() { state.calls.push('stop'); },
  };
  return { config, atlassian, precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } }, git, runner, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') } };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-workflow-'));
  await mkdir(join(root, 'workspace'));
  const yaml = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
  config = parseConfigYaml(yaml);
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('workflow persistence and queue', () => {
  it('uses SQLite transactions to exclude concurrent claims across connections', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const b = new SqliteJobStore(path);
    const job: JobRecord = { job_id: 'd3f7800e-3768-4614-b80c-0581e86bbec1', issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'QUEUED', dry_run: false, repair_round: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await a.create(job);
    const results = await Promise.all([a.claim(job.job_id, 'controller-a', '2099-01-01T00:00:00.000Z'), b.claim(job.job_id, 'controller-b', '2099-01-01T00:00:00.000Z')]);
    assert.equal(results.filter(Boolean).length, 1);
    a.close(); b.close();
  });

  it('keeps dry-run read-only, PLANNED, and permits a later real attempt', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-2'] };
    const service = new WorkflowService(dependencies(jobs, artifacts, state), { id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
    const plan = await service.submit('SAMPLE-2', true); assert.equal(plan.state, 'QUEUED');
    const planned = await service.execute(plan.job_id); assert.equal(planned.state, 'PLANNED');
    assert.deepEqual(state.calls, ['resolveBase']);
    state.calls.length = 0;
    const real = await service.submit('SAMPLE-2', false); assert.equal(real.state, 'QUEUED');
    const ready = await service.execute(real.job_id); assert.equal(ready.state, 'READY_FOR_HUMAN', ready.blocked_reason);
    assert.deepEqual(state.calls, ['prepare', 'checks', 'role:swe:write', 'checks', 'role:qa:read', 'role:reviewer:read', 'checks', 'commit']);
    await assert.rejects(() => service.submit('SAMPLE-2', false), { code: 'CONFLICT' });
  });

  it('deduplicates repeated polls and continues after one ticket blocks', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-3', 'SAMPLE-4'] };
    const deps = dependencies(jobs, artifacts, state);
    deps.atlassian.getIssue = async (key: string) => { if (key === 'SAMPLE-3') throw new Error('private upstream body'); return issue(key); };
    const service = new WorkflowService(deps);
    await service.poll(); await service.poll();
    const rows = await jobs.list(20);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((j) => j.issue_key === 'SAMPLE-3')?.state, 'BLOCKED');
    assert.equal(rows.find((j) => j.issue_key === 'SAMPLE-4')?.state, 'READY_FOR_HUMAN');
    assert.equal(rows.find((j) => j.issue_key === 'SAMPLE-3')?.blocked_reason, 'Workflow stage failed');
  });

  it('drains old queued work even when the recent history page is full of terminal jobs', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-20'] };
    await jobs.create({ job_id: 'd3f7800e-3768-4614-b80c-0581e86bbec1', issue_key: 'SAMPLE-20', repository_id: null, base_sha: null, state: 'QUEUED', dry_run: false, repair_round: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
    for (let i = 0; i < 501; i++) {
      const suffix = String(i + 1).padStart(12, '0'); const time = new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 1000).toISOString();
      await jobs.create({ job_id: `00000000-0000-4000-8000-${suffix}`, issue_key: `SAMPLE-${1000 + i}`, repository_id: null, base_sha: null, state: 'PLANNED', dry_run: true, repair_round: 0, created_at: time, updated_at: time });
    }
    const service = new WorkflowService(dependencies(jobs, artifacts, state)); await service.poll();
    assert.equal((await jobs.get('d3f7800e-3768-4614-b80c-0581e86bbec1'))?.state, 'READY_FOR_HUMAN');
    assert.equal(state.calls.includes('commit'), true);
    assert.equal((await jobs.list(500, 0)).length, 500); assert.equal((await jobs.list(10, 500)).length, 2);
  });

  it('blocks malformed independent evidence and limits repairs to two rounds', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-8'] };
    const deps = dependencies(jobs, artifacts, state);
    const original = deps.runner.runRole.bind(deps.runner);
    deps.runner.runRole = async (request, signal) => {
      if (request.role === 'qa') return { provider: 'codex', role: 'qa', status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: join(root, 'qa.jsonl'), result: '{bad json' };
      return original(request, signal);
    };
    const service = new WorkflowService(deps);
    const malformed = await service.submit('SAMPLE-8', false); const blocked = await service.execute(malformed.job_id);
    assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.blocked_code, 'INVALID_OUTPUT');

    const nextState = { calls: [] as string[], keys: ['SAMPLE-9'] }; const nextDeps = dependencies(jobs, artifacts, nextState);
    const baseRunRole = nextDeps.runner.runRole.bind(nextDeps.runner);
    nextDeps.runner.runRole = async (request, signal) => {
      const result = await baseRunRole(request, signal);
      if (request.role === 'qa') return { ...result, result: { schema_version: 1, candidate_digest: digest, status: 'FAIL', evidence: ['Acceptance is not met'] } };
      return result;
    };
    const nextService = new WorkflowService(nextDeps);
    const bounded = await nextService.execute((await nextService.submit('SAMPLE-9', false)).job_id);
    assert.equal(bounded.state, 'BLOCKED'); assert.equal(bounded.repair_round, 2);
    assert.equal(nextState.calls.filter((call) => call === 'role:swe:write').length, 3); // initial implementation plus two bounded repairs
  });

  it('cancels a queued job without running a provider', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-10'] };
    const service = new WorkflowService(dependencies(jobs, artifacts, state));
    const queued = await service.submit('SAMPLE-10', false); const cancelled = await service.cancel(queued.job_id);
    assert.equal(cancelled.state, 'CANCELLED'); assert.deepEqual(state.calls, []);
  });

  it('retries bounded retryable read failures without treating them as an empty queue', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-19'] };
    const deps = dependencies(jobs, artifacts, state); const getIssue = deps.atlassian.getIssue.bind(deps.atlassian); let reads = 0;
    deps.atlassian.getIssue = async (key: string, signal?: AbortSignal) => { reads++; if (reads === 1) throw new AutosError('UPSTREAM', 'temporary fixture outage', { retryable: true }); return getIssue(key, signal); };
    const service = new WorkflowService(deps); const result = await service.execute((await service.submit('SAMPLE-19', true)).job_id);
    assert.equal(result.state, 'PLANNED'); assert.equal(reads, 2);
  });

  it('creates a new attempt only through explicit retry and keeps prior history', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-11'] };
    const deps = dependencies(jobs, artifacts, state); deps.atlassian.getIssue = async () => { throw new Error('private service response'); };
    const service = new WorkflowService(deps);
    const first = await service.submit('SAMPLE-11', false); const blocked = await service.execute(first.job_id);
    assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.blocked_reason, 'Workflow stage failed');
    const retry = await service.retry(first.job_id); assert.notEqual(retry.job_id, first.job_id); assert.equal(retry.state, 'QUEUED');
    assert.equal((await jobs.history('SAMPLE-11')).length, 2);
  });

  it('loads nested repository instructions before SWE and blocks changed filter, snapshot, or candidate evidence', async () => {
    await mkdir(join(root, 'workspace', 'src'), { recursive: true }); await writeFile(join(root, 'workspace', 'src', 'AGENTS.md'), 'Nested rule: keep API compatibility.');
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-13'] };
    const deps = dependencies(jobs, artifacts, state); const prompts: string[] = [];
    const originalRole = deps.runner.runRole.bind(deps.runner);
    deps.runner.runRole = async (request, signal) => { if (request.role === 'swe') prompts.push(await readFile(request.prompt_path, 'utf8')); return originalRole(request, signal); };
    const originalCandidate = deps.git.inspectCandidate.bind(deps.git); let candidateCount = 0;
    deps.git.inspectCandidate = async (...args) => { candidateCount++; const candidate = await originalCandidate(...args); return candidateCount === 4 ? { ...candidate, digest: 'd'.repeat(64) } : candidate; };
    const service = new WorkflowService(deps); const job = await service.execute((await service.submit('SAMPLE-13', false)).job_id);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'STALE_CANDIDATE'); assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Nested rule: keep API compatibility/); assert.equal(state.calls.includes('commit'), false);
    jobs.close();

    for (const mode of ['filter','snapshot'] as const) {
      const store = new SqliteJobStore(join(root, `${mode}.sqlite`)); const files = new FileArtifactStore(join(root, `${mode}-artifacts`)); const local = { calls: [] as string[], keys: [mode === 'filter' ? 'SAMPLE-14' : 'SAMPLE-15'] };
      const ports = dependencies(store, files, local);
      if (mode === 'filter') { let count = 0; ports.atlassian.listIssueKeys = async () => (++count === 1 ? local.keys : []); }
      else { let count = 0; ports.atlassian.getIssue = async (key: string) => { count++; return count === 1 ? issue(key) : { ...issue(key), summary: 'Summary edited during execution' }; }; } // content change (updated_at alone no longer blocks)
      const runner = new WorkflowService(ports); const key = local.keys[0]!; const result = await runner.execute((await runner.submit(key, false)).job_id);
      assert.equal(result.state, 'BLOCKED', `${mode} changed`); assert.equal(local.calls.includes('commit'), false); store.close();
    }
  });

  it('keeps provider prompts private and refuses artifact symlinks', async () => {
    const store = new FileArtifactStore(config.storage.artifacts_dir); const id = 'd3f7800e-3768-4614-b80c-0581e86bbec1'; const invocation = 'b7f233e1-748b-49f5-a3c8-ecc8632f1c54';
    const paths = await store.prepareRole(id, 'swe', invocation, 'private prompt');
    assert.match(paths.prompt_path, /_private\/swe\/b7f233e1-748b-49f5-a3c8-ecc8632f1c54\/input\/prompt\.md$/);
    assert.match(paths.transcript_path, /_private\/swe\/b7f233e1-748b-49f5-a3c8-ecc8632f1c54\/output\/transcript\.jsonl$/);
    const job: JobRecord = { job_id: id, issue_key: 'SAMPLE-12', repository_id: null, base_sha: null, state: 'QUEUED', dry_run: false, repair_round: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await store.updateManifest(job); await store.write(id, 'issue.json', JSON.stringify(issue('SAMPLE-12')));
    const manifest = await store.manifest(id); assert.deepEqual(manifest.files.map((file) => file.name), ['issue.json']);
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'outside'); await symlink(outside, join(config.storage.artifacts_dir, id, 'summary.md'));
    await assert.rejects(() => store.write(id, 'summary.md', 'blocked'), { code: 'POLICY' });
    const escapeId = '00000000-0000-4000-8000-000000000099'; await mkdir(config.storage.artifacts_dir, { recursive: true });
    await symlink(root, join(config.storage.artifacts_dir, escapeId));
    await assert.rejects(() => store.write(escapeId, 'summary.md', 'escape'), { code: 'POLICY' });
  });

  it('cancels an active role and never reaches trusted commit', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-16'] };
    const deps = dependencies(jobs, artifacts, state);
    deps.runner.runRole = async (request, signal) => {
      state.calls.push(`role:${request.role}:${request.source_access}`);
      return await new Promise((_, reject) => { if (signal?.aborted) reject(new Error('cancelled')); else signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    };
    const service = new WorkflowService(deps); const job = await service.submit('SAMPLE-16', false); const execution = service.execute(job.job_id);
    for (let attempt = 0; attempt < 100 && !state.calls.some((call) => call.startsWith('role:')); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    const cancelled = await service.cancel(job.job_id); await execution;
    assert.equal(cancelled.state, 'CANCELLED'); assert.equal(state.calls.includes('commit'), false);
  });

  it('blocks before commit when the lease is lost during final candidate inspection', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-17'] };
    const deps = dependencies(jobs, artifacts, state); const inspect = deps.git.inspectCandidate.bind(deps.git); let count = 0;
    deps.git.inspectCandidate = async (...args) => { count++; if (count === 3) await jobs.release((args[0] as GitWorkspace).job_id, 'lease-owner'); return inspect(...args); };
    const service = new WorkflowService(deps, { owner: 'lease-owner' }); const result = await service.execute((await service.submit('SAMPLE-17', false)).job_id);
    assert.equal(result.state, 'BLOCKED'); assert.equal(result.blocked_code, 'CONFLICT'); assert.equal(state.calls.includes('commit'), false);
  });

  it('uses exactly zero, one, or two configured repair rounds', async () => {
    for (const [maxRepairs, expectedSwe] of [[0,1],[1,2],[2,3]] as const) {
      config.jobs.max_repair_rounds = maxRepairs;
      const jobs = new SqliteJobStore(join(root, `repair-${maxRepairs}.sqlite`)); const artifacts = new FileArtifactStore(join(root, `repair-${maxRepairs}-artifacts`));
      const state = { calls: [] as string[], keys: [`SAMPLE-${18 + maxRepairs}`] }; const deps = dependencies(jobs, artifacts, state); const original = deps.runner.runRole.bind(deps.runner);
      deps.runner.runRole = async (request, signal) => { const result = await original(request, signal); return request.role === 'qa' ? { ...result, result: { schema_version: 1, candidate_digest: digest, status: 'FAIL', evidence: ['Failure remains'] } } : result; };
      const service = new WorkflowService(deps); const result = await service.execute((await service.submit(state.keys[0]!, false)).job_id);
      assert.equal(result.state, 'BLOCKED'); assert.equal(result.repair_round, maxRepairs); assert.equal(state.calls.filter((call) => call === 'role:swe:write').length, expectedSwe);
      jobs.close();
    }
    config.jobs.max_repair_rounds = 2;
  });

  it('accepts variable compiler excerpts but rejects substituted commands', async () => {
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir); const state = { calls: [] as string[], keys: ['SAMPLE-21'] };
    const deps = dependencies(jobs, artifacts, state); const runChecks = deps.runner.runChecks.bind(deps.runner); let output = 0;
    deps.runner.runChecks = async (...args) => { output++; const result = await runChecks(...args); return { ...result, checks: result.checks.map((check) => ({ ...check, output_excerpt: `new log excerpt ${output}` })) }; };
    const service = new WorkflowService(deps); const ready = await service.execute((await service.submit('SAMPLE-21', false)).job_id);
    assert.equal(ready.state, 'READY_FOR_HUMAN');
    const checksArtifact = await readFile(join(config.storage.artifacts_dir, ready.job_id, 'checks.json'), 'utf8'); assert.match(checksArtifact, /new log excerpt 3/);

    const otherJobs = new SqliteJobStore(join(root, 'other.sqlite')); const otherArtifacts = new FileArtifactStore(join(root, 'other-artifacts')); const otherState = { calls: [] as string[], keys: ['SAMPLE-22'] };
    const otherDeps = dependencies(otherJobs, otherArtifacts, otherState); const correct = otherDeps.runner.runChecks.bind(otherDeps.runner); let count = 0;
    otherDeps.runner.runChecks = async (...args) => { count++; const result = await correct(...args); return count === 2 ? { ...result, checks: result.checks.map((check) => ({ ...check, command: ['sh','-c','false'] })) } : result; };
    const otherService = new WorkflowService(otherDeps); const blocked = await otherService.execute((await otherService.submit('SAMPLE-22', false)).job_id);
    assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.blocked_code, 'INVALID_OUTPUT'); assert.equal(otherState.calls.includes('commit'), false);
  });

  it('recovers only expired interrupted jobs and keeps active leases intact', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const b = new SqliteJobStore(path);
    const makeJob = (id: string, key: string, state: JobRecord['state'] = 'QUEUED'): JobRecord => ({ job_id: id, issue_key: key, repository_id: null, base_sha: null, state, dry_run: false, repair_round: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await a.create(makeJob('d3f7800e-3768-4614-b80c-0581e86bbec1', 'SAMPLE-5'));
    await a.create(makeJob('b7f233e1-748b-49f5-a3c8-ecc8632f1c54', 'SAMPLE-6'));
    await a.claim('d3f7800e-3768-4614-b80c-0581e86bbec1', 'live', '2099-01-01T00:00:00.000Z');
    await a.transition('b7f233e1-748b-49f5-a3c8-ecc8632f1c54', 'QUEUED', 'INVESTIGATING');
    const recoveryState = { calls: [] as string[], keys: [] as string[] };
    const service = new WorkflowService(dependencies(b, new FileArtifactStore(join(root, 'recovery-artifacts')), recoveryState));
    assert.equal(await service.recover(), 1); assert.deepEqual(recoveryState.calls, ['stop']);
    assert.equal((await a.get('d3f7800e-3768-4614-b80c-0581e86bbec1'))?.state, 'INVESTIGATING');
    assert.equal((await b.get('b7f233e1-748b-49f5-a3c8-ecc8632f1c54'))?.state, 'BLOCKED');
    a.close(); b.close();
  });

  it('keeps artifacts contained and terminal transitions immutable', async () => {
    const store = new FileArtifactStore(config.storage.artifacts_dir);
    await assert.rejects(() => store.manifest('d3f7800e-3768-4614-b80c-0581e86bbec1'), { code: 'NOT_FOUND' });
    await assert.rejects(() => store.write('d3f7800e-3768-4614-b80c-0581e86bbec1', '../escape.md', 'nope'));
    const job: JobRecord = { job_id: 'd3f7800e-3768-4614-b80c-0581e86bbec1', issue_key: 'SAMPLE-7', repository_id: null, base_sha: null, state: 'PLANNED', dry_run: true, repair_round: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await store.updateManifest(job); await store.write(job.job_id, 'summary.md', 'planned');
    assert.deepEqual((await store.manifest(job.job_id)).files.map((file) => file.name), ['summary.md']);
    const jobs = new SqliteJobStore(join(root, 'jobs.sqlite')); await jobs.create(job);
    assert.equal(await jobs.transition(job.job_id, 'PLANNED', 'READY_FOR_HUMAN'), false);
    jobs.close();
  });
});
