import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, type GitWorkspace, type IssueSnapshot, type JobRecord, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const issue = (key: string, over: Partial<IssueSnapshot> = {}): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', ...over } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');

interface Script {
  keys: string[];
  issues: Map<string, IssueSnapshot>;
  mappings: ProjectMapping[];
  base: string;
  /** Digest the fake candidate currently has; SWE runs bump it so each round is a new candidate. */
  digestIndex: number;
  calls: string[];
  prompts: { role: string; text: string; path: string }[];
  running: number; maxRunning: number;
  review: (round: number, digest: string) => unknown;
  qa: (round: number, digest: string) => unknown;
  checks: (digest: string, commands: { executable: string; args: string[]; required: boolean }[]) => unknown;
  role?: (role: string) => ProviderResult | undefined;
  filterError?: Error;
  pushThrows?: boolean;
  sweRuns: number;
}
const newScript = (keys: string[]): Script => ({
  keys, issues: new Map(keys.map((k) => [k, issue(k)])), mappings: [mapping], base: BASE, digestIndex: 1, calls: [], prompts: [], running: 0, maxRunning: 0, sweRuns: 0,
  review: (_r, d) => ({ schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] }),
  qa: (_r, d) => ({ schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['Acceptance criteria checked'] }),
  checks: (d, commands) => ({ schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) }),
});

function deps(script: Script, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  const digest = () => sha(script.digestIndex);
  const workspace = (req: { job_id: string; issue_key: string }): GitWorkspace => ({ job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory: join(root, 'workspace'), base_sha: script.base, development_branch: 'develop', feature_branch: `deep/${req.issue_key}` });
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { if (script.filterError) throw script.filterError; return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { if (script.filterError) throw script.filterError; return [...script.keys]; },
      async listIssues() { return [...script.issues.values()]; },
      async getIssue(key: string) { const found = script.issues.get(key); if (!found) throw new AutosError('NOT_FOUND', 'Issue not found'); return found; },
      async getBranchMap() { return script.mappings; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { script.calls.push('resolveBase'); return { base_sha: script.base, development_branch: 'develop' }; },
      async prepare(req) { script.calls.push(`prepare:${req.issue_key}`); return workspace(req); },
      async inspectCandidate() { return { digest: digest(), paths: ['src/Fix.java'], diff: `+ fixed v${script.digestIndex}` }; },
      async commit(req) { script.calls.push(`commit:${req.workspace.issue_key}`); return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { script.calls.push('push'); if (script.pushThrows) throw new Error('remote said no'); return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        script.running++; script.maxRunning = Math.max(script.maxRunning, script.running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          script.calls.push(`role:${req.role}`); script.prompts.push({ role: req.role, text: await readFile(req.prompt_path, 'utf8'), path: req.prompt_path });
          const override = script.role?.(req.role); if (override) return override;
          const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
          if (req.role === 'swe') { script.sweRuns++; script.digestIndex++; return { ...base, result: 'Implemented.' }; }
          const round = script.prompts.filter((p) => p.role === 'swe').length - 1;
          return { ...base, result: req.role === 'qa' ? script.qa(round, digest()) : script.review(round, digest()) };
        } finally { script.running--; }
      },
      async runChecks(_ws, candidateDigest, commands) { script.calls.push('checks'); return script.checks(candidateDigest, commands) as never; },
      async stop() { script.calls.push('stop'); },
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-lifecycle-'));
  await mkdir(join(root, 'workspace'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (script: Script, file = 'jobs.sqlite') => {
  const store = new SqliteJobStore(join(root, file)); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, artifacts, service: new WorkflowService(deps(script, store, artifacts)) };
};
const readJson = async (jobId: string, name: string) => JSON.parse(await readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8')) as Record<string, any>;

describe('poll semantics: one job at a time, queue drains within a poll', () => {
  it('discovers, dedupes, drains all eligible tickets serially, and a blocked ticket does not stop the queue', async () => {
    const script = newScript(['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3', 'OTHER-9', 'SAMPLE-5']);
    script.issues.set('OTHER-9', issue('OTHER-9', { project_key: 'OTHER' })); // disallowed project
    script.issues.delete('SAMPLE-3'); // hydration failure
    const { store, service } = open(script);
    await service.poll();
    const byKey = new Map((await store.list(50)).map((j) => [j.issue_key, j]));
    assert.equal(byKey.size, 5);
    assert.equal(byKey.get('SAMPLE-1')?.state, 'READY_FOR_HUMAN');
    assert.equal(byKey.get('SAMPLE-2')?.state, 'READY_FOR_HUMAN');
    assert.equal(byKey.get('SAMPLE-3')?.state, 'BLOCKED'); assert.equal(byKey.get('SAMPLE-3')?.blocked_code, 'NOT_FOUND');
    assert.equal(byKey.get('OTHER-9')?.state, 'BLOCKED'); assert.equal(byKey.get('OTHER-9')?.blocked_code, 'POLICY');
    assert.equal(byKey.get('SAMPLE-5')?.state, 'READY_FOR_HUMAN');
    assert.equal(script.maxRunning, 1);
    assert.deepEqual(script.calls.filter((c) => c.startsWith('commit:')), ['commit:SAMPLE-1', 'commit:SAMPLE-2', 'commit:SAMPLE-5']);
    const before = script.calls.length; await service.poll();
    assert.equal(script.calls.length, before, 'second poll must not rerun any ticket'); assert.equal((await store.list(50)).length, 5);
    store.close();
  });

  it('drains tickets discovered across successive polls (controller loop usage)', async () => {
    const script = newScript(['SAMPLE-1']); const { store, service } = open(script);
    await service.poll(); script.keys.push('SAMPLE-2'); script.issues.set('SAMPLE-2', issue('SAMPLE-2')); await service.poll();
    assert.deepEqual((await store.list(10)).map((j) => j.state), ['READY_FOR_HUMAN', 'READY_FOR_HUMAN']);
    store.close();
  });

  it('blocks tickets with disabled or missing or ambiguous mappings and continues', async () => {
    const script = newScript(['SAMPLE-1']);
    for (const [name, mappings] of [['disabled', [{ ...mapping, enabled: false }]], ['missing', []], ['ambiguous', [mapping, { ...mapping, repository_slug: 'other-app' }]]] as const) {
      script.mappings = [...mappings]; const { store, service } = open(script, `${name}.sqlite`);
      const blocked = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
      assert.equal(blocked.state, 'BLOCKED', name); assert.equal(blocked.blocked_code, 'MAPPING', name); assert.equal(script.calls.includes('prepare:SAMPLE-1'), false);
      store.close();
    }
  });

  it('does not treat a filter read failure as an empty filter and does not touch tickets', async () => {
    const script = newScript(['SAMPLE-1']); const { store, service } = open(script);
    await service.poll(); // SAMPLE-1 completed
    script.filterError = new AutosError('UPSTREAM', 'Jira down'); script.keys.push('SAMPLE-2'); script.issues.set('SAMPLE-2', issue('SAMPLE-2'));
    await assert.rejects(() => service.poll(), { code: 'UPSTREAM' });
    const rows = await store.list(10); assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'READY_FOR_HUMAN');
    delete script.filterError; await service.poll(); assert.equal((await store.list(10)).length, 2);
    store.close();
  });
});

describe('repair loop and evidence currency', () => {
  const finding = { severity: 'HIGH', file: 'src/Fix.java', line: 3, issue: 'Null dereference on empty input', suggested_fix: 'Guard the null case' };

  it('feeds reviewer findings to a fresh SWE session, reruns checks/QA/review on the new candidate, and ties evidence to the commit', async () => {
    const script = newScript(['SAMPLE-1']);
    script.review = (round, d) => round === 0 ? { schema_version: 1, candidate_digest: d, status: 'FAIL', findings: [finding] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] };
    const { store, service } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', job.blocked_reason); assert.equal(job.repair_round, 1);
    const swePrompts = script.prompts.filter((p) => p.role === 'swe'); assert.equal(swePrompts.length, 2);
    assert.match(swePrompts[1]!.text, /Null dereference on empty input/); assert.match(swePrompts[1]!.text, /Guard the null case/);
    assert.notEqual(swePrompts[0]!.path, swePrompts[1]!.path, 'each role invocation gets a fresh private session directory');
    assert.deepEqual(script.calls.filter((c) => c !== 'prepare:SAMPLE-1'), ['checks', 'role:swe', 'checks', 'role:qa', 'role:reviewer', 'role:swe', 'checks', 'role:qa', 'role:reviewer', 'checks', 'commit:SAMPLE-1']);
    const rounds = await readJson(job.job_id, 'rounds.json');
    assert.equal(rounds.rounds.length, 2); assert.notEqual(rounds.rounds[0].candidate_digest, rounds.rounds[1].candidate_digest);
    assert.equal(rounds.rounds[0].gate.ready, false); assert.equal(rounds.rounds[0].review.findings[0].issue, finding.issue); assert.equal(rounds.rounds[1].gate.ready, true);
    const finalDigest = sha(script.digestIndex);
    for (const name of ['qa.json', 'review.json', 'checks.json']) assert.equal((await readJson(job.job_id, name)).candidate_digest, finalDigest, name);
    const manifest = await readJson(job.job_id, 'manifest.json');
    assert.equal(manifest.candidate_digest, finalDigest); assert.equal(manifest.commit_sha, 'c'.repeat(40)); assert.equal(manifest.status, 'READY_FOR_HUMAN'); assert.equal(manifest.base_sha, BASE);
    assert.match(await readFile(join(config.storage.artifacts_dir, job.job_id, 'summary.md'), 'utf8'), /Repair rounds used: 1/);
    store.close();
  });

  it('never reuses a PASS for an older candidate and blocks when repairs are exhausted', async () => {
    const script = newScript(['SAMPLE-1']); const stale = sha(1);
    script.review = () => ({ schema_version: 1, candidate_digest: stale, status: 'PASS', findings: [] }); // always claims the first candidate
    const { store, service } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'CHECK_FAILED'); assert.match(job.blocked_reason ?? '', /STALE_REVIEW/); assert.equal(job.repair_round, 2);
    assert.equal(script.calls.some((c) => c.startsWith('commit')), false);
    store.close();
  });

  it('blocks instead of finalizing with NOT_RUN or timed-out checks, and on timed-out or failed role output', async () => {
    const notRun = newScript(['SAMPLE-1']); const passing = notRun.checks; let n = 0;
    // The first (baseline) run passes; every candidate run reports its first required check NOT_RUN.
    notRun.checks = (d, commands) => {
      if (++n === 1) return passing(d, commands);
      return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c, i) => ({ name: c.executable, command: [c.executable, ...c.args], status: i === 0 ? 'NOT_RUN' : 'PASS', exit_code: i === 0 ? null : 0, timed_out: false, required: c.required, report_paths: [] })) };
    };
    const a = open(notRun, 'a.sqlite'); const blockedA = await a.service.execute((await a.service.submit('SAMPLE-1', false)).job_id);
    assert.equal(blockedA.state, 'BLOCKED'); assert.equal(notRun.calls.some((c) => c.startsWith('commit')), false); a.store.close();

    const timedOut = newScript(['SAMPLE-2']);
    timedOut.role = (role) => role === 'reviewer' ? { provider: 'claude', role: 'reviewer', status: 'TIMED_OUT', exit_code: null, elapsed_ms: 1, transcript_path: join(root, 't.jsonl'), result: null } : undefined;
    const b = open(timedOut, 'b.sqlite'); const blockedB = await b.service.execute((await b.service.submit('SAMPLE-2', false)).job_id);
    assert.equal(blockedB.state, 'BLOCKED'); assert.equal(blockedB.blocked_code, 'TIMEOUT'); assert.equal(timedOut.calls.some((c) => c.startsWith('commit')), false); b.store.close();

    const malformed = newScript(['SAMPLE-3']); malformed.review = () => ({ schema_version: 1, status: 'PASS' });
    const c = open(malformed, 'c.sqlite'); const blockedC = await c.service.execute((await c.service.submit('SAMPLE-3', false)).job_id);
    assert.equal(blockedC.state, 'BLOCKED'); assert.equal(blockedC.blocked_code, 'INVALID_OUTPUT'); c.store.close();
  });

  it('records a push failure without discarding the local commit', async () => {
    config.bitbucket.push_feature_branch = true;
    const script = newScript(['SAMPLE-1']); script.pushThrows = true; const { store, service } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.equal(job.commit_sha, 'c'.repeat(40));
    assert.equal((await readJson(job.job_id, 'manifest.json')).push_status, 'FAILED'); assert.equal(script.sweRuns, 1);
    store.close(); config.bitbucket.push_feature_branch = false;
  });
});

describe('evidence packet', () => {
  it('writes the full packet, hashes public files, and keeps private prompts out of the manifest', async () => {
    const script = newScript(['SAMPLE-1']); const { store, service } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    const manifest = await readJson(job.job_id, 'manifest.json'); const names = manifest.files.map((f: { name: string }) => f.name).sort();
    for (const required of ['issue.json', 'branch-map.json', 'base.json', 'precedents.md', 'implementation.md', 'baseline-checks.json', 'checks.json', 'qa.json', 'review.json', 'rounds.json', 'summary.md']) assert.ok(names.includes(required), `missing ${required}`);
    assert.ok(!names.some((n: string) => n.includes('prompt') || n.includes('transcript')) && !names.includes('_private'));
    for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await readJson(job.job_id, 'branch-map.json')).source.page_id, '67890'); assert.equal((await readJson(job.job_id, 'branch-map.json')).source.version, 7);
    assert.equal((await readJson(job.job_id, 'base.json')).base_sha, BASE);
    assert.match(await readFile(join(config.storage.artifacts_dir, job.job_id, 'precedents.md'), 'utf8'), /NO_MATCH/);
    assert.ok((await readdir(join(config.storage.artifacts_dir, job.job_id))).includes('_private'));
    store.close();
  });

  it('writes a dry-run packet (no implementation sessions) and honours a non-default artifacts root', async () => {
    const script = newScript(['SAMPLE-1']); const store = new SqliteJobStore(join(root, 'jobs.sqlite')); const alt = join(root, 'alt-artifacts');
    const service = new WorkflowService(deps(script, store, new FileArtifactStore(alt)));
    const job = await service.execute((await service.submit('SAMPLE-1', true)).job_id); assert.equal(job.state, 'PLANNED');
    const manifest = JSON.parse(await readFile(join(alt, job.job_id, 'manifest.json'), 'utf8'));
    for (const required of ['issue.json', 'branch-map.json', 'base.json', 'precedents.md', 'implementation.md', 'summary.md']) assert.ok(manifest.files.some((f: { name: string }) => f.name === required), required);
    assert.deepEqual(script.calls, ['resolveBase']); store.close();
  });

  it('keeps SWE notes in implementation.md when the artifact root differs from config', async () => {
    const script = newScript(['SAMPLE-1']); const store = new SqliteJobStore(join(root, 'jobs.sqlite')); const alt = join(root, 'alt-artifacts');
    const service = new WorkflowService(deps(script, store, new FileArtifactStore(alt)));
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.match(await readFile(join(alt, job.job_id, 'implementation.md'), 'utf8'), /## SWE notes/); store.close();
  });
});

describe('restart recovery on a real SQLite file', () => {
  const past = '2000-01-01T00:00:00.000Z';
  it('marks an interrupted IMPLEMENTING job BLOCKED after reopen, records it, and never recreates the branch', async () => {
    const script = newScript(['SAMPLE-1']); const path = join(root, 'durable.sqlite');
    const first = new SqliteJobStore(path); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
    const service1 = new WorkflowService(deps(script, first, artifacts));
    const job = await service1.submit('SAMPLE-1', false);
    assert.equal(await first.claim(job.job_id, 'crashed-controller', past), true);
    assert.equal(await first.transition(job.job_id, 'INVESTIGATING', 'IMPLEMENTING', { repository_id: 'example/sample-app', base_sha: BASE, feature_branch: 'deep/SAMPLE-1' }), true);
    first.close(); // simulated crash: lease is expired and never released

    const second = new SqliteJobStore(path); const service2 = new WorkflowService(deps(script, second, new FileArtifactStore(config.storage.artifacts_dir)));
    assert.equal(await service2.recover(), 1); assert.ok(script.calls.includes('stop'));
    const recovered = await second.get(job.job_id); assert.equal(recovered?.state, 'BLOCKED'); assert.equal(recovered?.blocked_code, 'CONFLICT'); assert.equal(recovered?.feature_branch, 'deep/SAMPLE-1');
    assert.equal((await readJson(job.job_id, 'manifest.json')).status, 'BLOCKED');
    assert.match(await readFile(join(config.storage.artifacts_dir, job.job_id, 'summary.md'), 'utf8'), /Interrupted by controller restart[\s\S]*deep\/SAMPLE-1/);
    await service2.poll(); // blocked attempts stay deduped; nothing silently reruns
    assert.equal(script.calls.some((c) => c.startsWith('prepare')), false); assert.equal((await second.history('SAMPLE-1')).length, 1);

    // Explicit retry goes back through trusted Git, which owns branch-collision refusal.
    const retryDeps = deps(script, second, new FileArtifactStore(config.storage.artifacts_dir));
    retryDeps.git.prepare = async () => { throw new AutosError('BRANCH_COLLISION', 'Feature branch already exists'); };
    const retryService = new WorkflowService(retryDeps); const retry = await retryService.retry(job.job_id);
    const collided = await retryService.execute(retry.job_id); assert.equal(collided.state, 'BLOCKED'); assert.equal(collided.blocked_code, 'BRANCH_COLLISION');
    second.close();
  });

  it('does not recover a job whose lease is still live and does not rerun READY_FOR_HUMAN when the base advances', async () => {
    const script = newScript(['SAMPLE-1']); const path = join(root, 'durable.sqlite');
    const first = new SqliteJobStore(path); const service1 = new WorkflowService(deps(script, first, new FileArtifactStore(config.storage.artifacts_dir)));
    const ready = await service1.execute((await service1.submit('SAMPLE-1', false)).job_id); assert.equal(ready.state, 'READY_FOR_HUMAN'); first.close();

    script.base = 'e'.repeat(40); script.calls.length = 0;
    const second = new SqliteJobStore(path); const service2 = new WorkflowService(deps(script, second, new FileArtifactStore(config.storage.artifacts_dir)));
    await service2.poll(); assert.deepEqual(script.calls, []); assert.equal((await second.history('SAMPLE-1')).length, 1);
    await assert.rejects(() => service2.submit('SAMPLE-1', false), { code: 'CONFLICT' });
    assert.equal((await second.get(ready.job_id))?.base_sha, BASE);
    second.close();
  });
});

describe('cancellation', () => {
  it('cancels an active checks stage, stops the runner, and never commits', async () => {
    const script = newScript(['SAMPLE-1']); const { store, artifacts } = open(script);
    const d = deps(script, store, artifacts); let calls = 0;
    d.runner.runChecks = async (_ws, digest, commands, signal) => {
      if (++calls === 1) return script.checks(digest, commands) as never;
      script.calls.push('checks-hang');
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const service = new WorkflowService(d); const job = await service.submit('SAMPLE-1', false); const run = service.execute(job.job_id);
    for (let i = 0; i < 200 && !script.calls.includes('checks-hang'); i++) await new Promise((r) => setTimeout(r, 5));
    const cancelled = await service.cancel(job.job_id); await run;
    assert.equal(cancelled.state, 'CANCELLED'); assert.ok(script.calls.includes('stop')); assert.equal(script.calls.some((c) => c.startsWith('commit')), false);
    assert.equal((await readJson(job.job_id, 'manifest.json')).status, 'CANCELLED');
    store.close();
  });

  it('cancel of a queued job leaves other queued jobs runnable and cancel of a terminal job is a no-op', async () => {
    const script = newScript(['SAMPLE-1', 'SAMPLE-2']); const { store, service } = open(script);
    const a = await service.submit('SAMPLE-1', false); const b = await service.submit('SAMPLE-2', false);
    assert.equal((await service.cancel(a.job_id)).state, 'CANCELLED');
    await service.poll();
    assert.equal((await store.get(b.job_id))?.state, 'READY_FOR_HUMAN'); assert.equal((await store.get(a.job_id))?.state, 'CANCELLED');
    assert.equal((await service.cancel(b.job_id)).state, 'READY_FOR_HUMAN');
    store.close();
  });
});

describe('synthetic three-ticket scenario', () => {
  it('fixes SAMPLE-123, repairs after one reviewer FAIL, and blocks a ticket without stopping the queue', async () => {
    const script = newScript(['SAMPLE-123', 'SAMPLE-124', 'SAMPLE-125']);
    script.issues.set('SAMPLE-125', issue('SAMPLE-125', { project_key: 'DISALLOWED' }));
    let failedOnce = false;
    script.review = (_round, d) => {
      const current = script.prompts.at(-1)?.text ?? '';
      if (!failedOnce && current.includes('SAMPLE-124')) { failedOnce = true; return { schema_version: 1, candidate_digest: d, status: 'FAIL', findings: [{ severity: 'HIGH', file: 'src/Fix.java', line: 1, issue: 'Missing regression assertion', suggested_fix: 'Add assertion' }] }; }
      return { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] };
    };
    const { store, service } = open(script); await service.poll();
    const states = Object.fromEntries((await store.list(10)).map((j) => [j.issue_key, [j.state, j.repair_round]]));
    assert.deepEqual(states, { 'SAMPLE-123': ['READY_FOR_HUMAN', 0], 'SAMPLE-124': ['READY_FOR_HUMAN', 1], 'SAMPLE-125': ['BLOCKED', 0] });
    store.close();
  });
});
