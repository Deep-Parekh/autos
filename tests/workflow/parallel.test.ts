import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, workflowActivitySchema, type GitWorkspace, type IssueSnapshot, type JobRecord, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const sha = (n: number) => n.toString(16).padStart(64, '0');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) { if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
}

/** Keyed gates: wait() blocks until release(key) or releaseAll(); waiting is abort-aware like a real runner. */
class Gates {
  private readonly released = new Set<string>(); private all = false; private readonly waiting = new Map<string, Array<() => void>>(); readonly arrived: string[] = [];
  async wait(key: string, signal?: AbortSignal): Promise<void> {
    this.arrived.push(key);
    if (this.all || this.released.has(key)) return;
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => reject(new AutosError('CANCELLED', 'aborted'));
      if (signal?.aborted) return onAbort();
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), go]); signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  release(key: string): void { this.released.add(key); for (const go of this.waiting.get(key) ?? []) go(); this.waiting.delete(key); }
  releaseAll(): void { this.all = true; for (const key of [...this.waiting.keys()]) this.release(key); }
}

interface Probe {
  sweGate: Gates; checksGate: Gates; sweRunning: number; sweStartPeak: number; checksRunning: number; checksPeak: number;
  perIssue: Map<string, number>; perIssuePeak: number; stops: string[]; commits: number; checkDelayMs: number; badIssues: Set<string>; onChecksStart?: () => Promise<void> | void;
}
const openGates = () => { const g = new Gates(); g.releaseAll(); return g; };
const newProbe = (): Probe => ({ sweGate: new Gates(), checksGate: openGates(), sweRunning: 0, sweStartPeak: 0, checksRunning: 0, checksPeak: 0, perIssue: new Map(), perIssuePeak: 0, stops: [], commits: 0, checkDelayMs: 0, badIssues: new Set() });

function deps(probe: Probe, store: SqliteJobStore, artifacts: FileArtifactStore, keys: () => string[]): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: probe.badIssues.has(key) ? 'Epic' : 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z' } as IssueSnapshot);
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return keys(); },
      async listIssues() { return keys().map(issue); },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}-${req.job_id.slice(0, 8)}` } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(1), paths: ['src/Fix.java'], diff: '+ fixed' }; },
      async commit(req) { probe.commits++; return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req, signal) {
        const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (req.role === 'swe') {
          probe.sweRunning++; probe.sweStartPeak = Math.max(probe.sweStartPeak, probe.sweRunning);
          const n = (probe.perIssue.get(req.issue_key) ?? 0) + 1; probe.perIssue.set(req.issue_key, n); probe.perIssuePeak = Math.max(probe.perIssuePeak, n);
          try { await probe.sweGate.wait(req.issue_key, signal); } finally { probe.sweRunning--; probe.perIssue.set(req.issue_key, (probe.perIssue.get(req.issue_key) ?? 1) - 1); }
          return { ...base, result: 'Implemented.' } as ProviderResult;
        }
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: sha(1), status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: sha(1), status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(ws, d, commands, signal) {
        probe.checksRunning++; probe.checksPeak = Math.max(probe.checksPeak, probe.checksRunning);
        try {
          await probe.onChecksStart?.();
          await probe.checksGate.wait(ws.issue_key, signal);
          if (probe.checkDelayMs) await sleep(probe.checkDelayMs);
        } finally { probe.checksRunning--; }
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop(jobId) { probe.stops.push(jobId); },
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-parallel-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (probe: Probe, keys: string[], limits: { parallel?: number; checks?: number; leaseMs?: number } = {}, file = 'jobs.sqlite') => {
  config.jobs.max_parallel = limits.parallel ?? 1; if (limits.checks) config.jobs.max_concurrent_checks = limits.checks;
  const store = new SqliteJobStore(join(root, file)); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  const service = new WorkflowService(deps(probe, store, artifacts, () => keys), limits.leaseMs ? { leaseMs: limits.leaseMs } : {});
  return { store, service };
};
const byIssue = async (service: WorkflowService, key: string) => (await service.list(100)).find((j) => j.issue_key === key)!;
const stateOf = async (service: WorkflowService, key: string) => (await byIssue(service, key))?.state;
const rawJob = (id: string, key: string, state: JobRecord['state'] = 'QUEUED', createdAt = new Date().toISOString()): JobRecord => ({ job_id: id, issue_key: key, repository_id: null, base_sha: null, state, dry_run: false, repair_round: 0, created_at: createdAt, updated_at: createdAt });
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('bounded parallel workflow execution', () => {
  it('runs exactly max_parallel jobs at once, queues the rest, and never exceeds the limit', async () => {
    const probe = newProbe(); const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3'], { parallel: 2 });
    const polled = service.poll();
    await until(() => probe.sweGate.arrived.length === 2, 'two running');
    await sleep(100);
    assert.equal(probe.sweRunning, 2); assert.equal(probe.sweGate.arrived.length, 2, 'third job must wait for a slot');
    assert.equal(await stateOf(service, 'SAMPLE-3'), 'QUEUED');
    probe.sweGate.release(probe.sweGate.arrived[0]!);
    await until(() => probe.sweGate.arrived.length === 3, 'third starts when a slot frees');
    probe.sweGate.releaseAll(); await polled;
    assert.equal(probe.sweStartPeak, 2);
    for (const k of ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3']) assert.equal(await stateOf(service, k), 'READY_FOR_HUMAN');
    store.close();
  });

  it('never runs two jobs of the same issue concurrently', async () => {
    const probe = newProbe(); const { service, store } = open(probe, ['SAMPLE-1'], { parallel: 2 });
    const first = await service.submit('SAMPLE-1', false);
    const raw = new DatabaseSync(join(root, 'jobs.sqlite')); raw.exec('PRAGMA busy_timeout=5000');
    raw.prepare('INSERT INTO jobs(job_id,issue_key,state,dry_run,repair_round,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(uuid(2), 'SAMPLE-1', 'QUEUED', 0, 0, new Date(Date.now() + 1000).toISOString(), new Date().toISOString()); raw.close();
    const polled = service.poll();
    await until(() => probe.sweGate.arrived.length >= 1, 'first running');
    await sleep(150);
    assert.equal(probe.sweGate.arrived.length, 1, 'sibling attempt of the same issue must wait even though a slot is free');
    assert.equal((await store.get(uuid(2)))?.state, 'QUEUED'); assert.equal((await service.get(first.job_id))?.state, 'IMPLEMENTING');
    probe.sweGate.releaseAll(); await polled;
    assert.equal(probe.perIssuePeak, 1);
    assert.equal((await service.get(first.job_id))?.state, 'READY_FOR_HUMAN'); assert.equal((await store.get(uuid(2)))?.state, 'READY_FOR_HUMAN');
    store.close();
  });

  it('does not let a ticket that blocks immediately hold a slot', async () => {
    const probe = newProbe(); probe.badIssues.add('SAMPLE-1');
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3'], { parallel: 2 });
    const polled = service.poll();
    await until(() => probe.sweGate.arrived.length === 2, 'both good tickets run together');
    assert.equal(probe.sweRunning, 2); assert.equal(await stateOf(service, 'SAMPLE-1'), 'BLOCKED');
    probe.sweGate.releaseAll(); await polled;
    assert.equal(await stateOf(service, 'SAMPLE-2'), 'READY_FOR_HUMAN'); assert.equal(await stateOf(service, 'SAMPLE-3'), 'READY_FOR_HUMAN');
    store.close();
  });

  it('serialises runChecks with max_concurrent_checks=1 while roles overlap', async () => {
    const probe = newProbe(); probe.checkDelayMs = 20;
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2'], { parallel: 2, checks: 1 });
    let observedInUse = -1; probe.onChecksStart = async () => { observedInUse = Math.max(observedInUse, (await service.activity()).slots.checks_in_use); };
    const polled = service.poll();
    await until(() => probe.sweGate.arrived.length === 2 && probe.sweRunning === 2, 'both roles overlap');
    probe.sweGate.releaseAll(); await polled;
    assert.equal(probe.checksPeak, 1); assert.equal(probe.sweStartPeak, 2); assert.equal(observedInUse, 1);
    const events = await service.events({ limit: 500 });
    assert.ok(events.filter((e) => e.type === 'checks_started').length >= 4);
    assert.equal((await service.activity()).slots.checks_in_use, 0);
    store.close();
  });

  it('allows concurrent checks up to max_concurrent_checks=2', async () => {
    const probe = newProbe(); probe.checkDelayMs = 60; probe.sweGate.releaseAll();
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2'], { parallel: 2, checks: 2 });
    await service.poll(); assert.equal(probe.checksPeak, 2); store.close();
  });

  it('cancelling one running job leaves the other untouched', async () => {
    const probe = newProbe();
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2'], { parallel: 2 });
    const polled = service.poll();
    await until(() => probe.sweGate.arrived.length === 2, 'both running');
    const a = await byIssue(service, 'SAMPLE-1'); const b = await byIssue(service, 'SAMPLE-2');
    const cancelled = await service.cancel(a.job_id);
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal((await service.get(b.job_id))?.state, 'IMPLEMENTING'); assert.deepEqual(probe.stops.filter((id) => id === b.job_id), []);
    probe.sweGate.releaseAll(); await polled;
    assert.equal((await service.get(b.job_id))?.state, 'READY_FOR_HUMAN'); assert.equal((await service.get(a.job_id))?.state, 'CANCELLED');
    assert.equal((await service.activity()).active_jobs.length, 0);
    store.close();
  });

  it('stops a cancelled job that is waiting for a check slot without disturbing the holder', async () => {
    const probe = newProbe(); probe.sweGate.releaseAll(); probe.checksGate = new Gates();
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2'], { parallel: 2, checks: 1 });
    const polled = service.poll();
    await until(() => probe.checksGate.arrived.length === 1, 'one job holds the check slot');
    const holderKey = probe.checksGate.arrived[0]!; const waiterKey = holderKey === 'SAMPLE-1' ? 'SAMPLE-2' : 'SAMPLE-1';
    await until(async () => (await service.activity()).active_jobs.length === 2, 'both active');
    const waiter = await byIssue(service, waiterKey);
    await sleep(50);
    assert.equal(probe.checksRunning, 1);
    assert.equal((await service.cancel(waiter.job_id)).state, 'CANCELLED');
    assert.ok(!(await service.events({ job_id: waiter.job_id, limit: 500 })).some((e) => e.type === 'checks_started'), 'a job that never got a slot never started checks');
    probe.checksGate.releaseAll(); await polled;
    assert.equal(await stateOf(service, holderKey), 'READY_FOR_HUMAN'); assert.equal(probe.checksPeak, 1);
    store.close();
  });

  it('shows two active jobs with distinct stages in activity()', async () => {
    const probe = newProbe(); probe.checksGate = new Gates(); const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2'], { parallel: 2, checks: 1 });
    // SAMPLE-1 passes baseline then waits in SWE; SAMPLE-2 then sits in its baseline checks.
    const polled = service.poll();
    await until(() => probe.checksGate.arrived.length === 1, 'first job in baseline checks');
    const firstKey = probe.checksGate.arrived[0]!; probe.checksGate.release(firstKey);
    await until(() => probe.sweGate.arrived.includes(firstKey), 'first job in implementation');
    await until(() => probe.checksGate.arrived.length === 2, 'second job in baseline checks');
    const activity = await service.activity(); workflowActivitySchema.parse(activity);
    assert.equal(activity.active_jobs.length, 2); assert.equal(activity.slots.in_use, 2); assert.equal(activity.slots.max_parallel, 2);
    assert.equal(activity.slots.max_concurrent_checks, 1); assert.equal(activity.slots.checks_in_use, 1);
    assert.deepEqual(activity.active, activity.active_jobs[0]);
    assert.deepEqual(new Set(activity.active_jobs.map((j) => j.stage)), new Set(['implementation', 'baseline']));
    assert.equal(activity.active_jobs.find((j) => j.stage === 'implementation')?.role, 'swe');
    probe.checksGate.releaseAll(); probe.sweGate.releaseAll(); await polled; store.close();
  });

  it('keeps today\'s strictly serial order at max_parallel=1', async () => {
    const probe = newProbe(); probe.sweGate.releaseAll();
    const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3'], { parallel: 1 });
    await service.poll();
    assert.equal(probe.sweStartPeak, 1);
    const events = (await service.events({ limit: 500 })).filter((e) => e.type === 'job_started' || e.type === 'job_finished').map((e) => `${e.type}:${e.issue_key}`);
    assert.deepEqual(events, ['job_started:SAMPLE-1', 'job_finished:SAMPLE-1', 'job_started:SAMPLE-2', 'job_finished:SAMPLE-2', 'job_started:SAMPLE-3', 'job_finished:SAMPLE-3']);
    const act = await service.activity(); assert.equal(act.slots.max_parallel, 1); assert.deepEqual(act.active_jobs, []); assert.equal(act.active, null);
    store.close();
  });

  it('execute() reports CONFLICT when no slot is free', async () => {
    const probe = newProbe(); const { service, store } = open(probe, ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3'], { parallel: 2 });
    const jobs = [await service.submit('SAMPLE-1', false), await service.submit('SAMPLE-2', false), await service.submit('SAMPLE-3', false)];
    const running = [service.execute(jobs[0]!.job_id), service.execute(jobs[1]!.job_id)];
    await until(() => probe.sweGate.arrived.length === 2, 'two running');
    await assert.rejects(service.execute(jobs[2]!.job_id), (e: unknown) => e instanceof AutosError && e.code === 'CONFLICT');
    assert.equal((await service.get(jobs[2]!.job_id))?.state, 'QUEUED');
    probe.sweGate.releaseAll(); await Promise.all(running);
    assert.equal((await service.execute(jobs[2]!.job_id)).state, 'READY_FOR_HUMAN'); store.close();
  });
});

describe('per-job leases across connections', () => {
  it('never grants more than max_parallel leases to concurrent claimers on separate connections', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const b = new SqliteJobStore(path);
    const ids = [1, 2, 3, 4, 5, 6].map(uuid);
    for (const [i, id] of ids.entries()) await a.create(rawJob(id, `SAMPLE-${i + 1}`));
    const far = '2099-01-01T00:00:00.000Z';
    const results = await Promise.all(ids.map((id, i) => (i % 2 ? b : a).tryClaim(id, i % 2 ? 'owner-b' : 'owner-a', far, 2)));
    assert.equal(results.filter((r) => r === 'CLAIMED').length, 2); assert.equal(results.filter((r) => r === 'NO_SLOT').length, 4);
    const raw = new DatabaseSync(path); assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n, 2);
    const claimed = ids.filter((_, i) => results[i] === 'CLAIMED');
    await a.release(claimed[0]!, claimed[0] && results.indexOf('CLAIMED') % 2 ? 'owner-b' : 'owner-a');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n, 1);
    const retry = await Promise.all(ids.filter((_, i) => results[i] === 'NO_SLOT').map((id, i) => (i % 2 ? b : a).tryClaim(id, 'late', far, 2)));
    assert.equal(retry.filter((r) => r === 'CLAIMED').length, 1);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n, 2);
    raw.close(); a.close(); b.close();
  });

  it('refuses a second live lease for the same issue even with free slots', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const b = new SqliteJobStore(path); const far = '2099-01-01T00:00:00.000Z';
    await a.create(rawJob(uuid(1), 'SAMPLE-1'));
    const raw = new DatabaseSync(path); raw.prepare('INSERT INTO jobs(job_id,issue_key,state,dry_run,repair_round,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(uuid(2), 'SAMPLE-1', 'QUEUED', 0, 0, new Date().toISOString(), new Date().toISOString()); raw.close();
    assert.equal(await a.tryClaim(uuid(1), 'a', far, 4), 'CLAIMED'); assert.equal(await b.tryClaim(uuid(2), 'b', far, 4), 'ISSUE_BUSY');
    await a.release(uuid(1), 'a'); await a.transition(uuid(1), 'INVESTIGATING', 'BLOCKED');
    assert.equal(await b.tryClaim(uuid(2), 'b', far, 4), 'CLAIMED'); a.close(); b.close();
  });

  it('refuses to renew an expired lease, a foreign owner, or a terminal job', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const far = '2099-01-01T00:00:00.000Z';
    await a.create(rawJob(uuid(1), 'SAMPLE-1')); await a.create(rawJob(uuid(2), 'SAMPLE-2')); await a.create(rawJob(uuid(3), 'SAMPLE-3'));
    assert.equal(await a.claim(uuid(1), 'me', far, 3), true);
    assert.equal(await a.renew(uuid(1), 'someone-else', far), false); assert.equal(await a.renew(uuid(1), 'me', far), true);
    assert.equal(await a.claim(uuid(2), 'me', '2000-01-01T00:00:00.000Z', 3), true);
    assert.equal(await a.renew(uuid(2), 'me', far), false, 'late renew after expiry must fail');
    assert.equal(await a.claim(uuid(3), 'me', far, 3), true); await a.transition(uuid(3), 'INVESTIGATING', 'BLOCKED');
    const raw = new DatabaseSync(path); assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM leases WHERE job_id=?').get(uuid(3)) as { n: number }).n, 0, 'terminal transition drops the lease');
    raw.prepare('INSERT INTO leases(job_id,owner,lease_until) VALUES(?,?,?)').run(uuid(3), 'me', far); raw.close();
    assert.equal(await a.renew(uuid(3), 'me', far), false, 'terminal job cannot renew'); a.close();
  });

  it('never counts terminal jobs toward slots, even with a stale lease row', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const far = '2099-01-01T00:00:00.000Z';
    for (const [i, st] of (['READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED', 'PLANNED'] as const).entries()) await a.create(rawJob(uuid(i + 1), `SAMPLE-${i + 1}`, st));
    await a.create(rawJob(uuid(9), 'SAMPLE-9'));
    const raw = new DatabaseSync(path);
    for (let i = 1; i <= 4; i++) raw.prepare('INSERT INTO leases(job_id,owner,lease_until) VALUES(?,?,?)').run(uuid(i), 'ghost', far); raw.close();
    assert.equal(await a.tryClaim(uuid(9), 'me', far, 1), 'CLAIMED'); assert.equal(a.activity().active_jobs.length, 1); a.close();
  });

  it('blocks with CONFLICT and does not commit when the lease expired before commit', async () => {
    const probe = newProbe(); const { service, store } = open(probe, ['SAMPLE-1'], { parallel: 1, leaseMs: 300 });
    const job = await service.submit('SAMPLE-1', false);
    const run = service.execute(job.job_id);
    await until(() => probe.sweGate.arrived.length === 1, 'in implementation');
    await sleep(450); // lease (300ms) expires before the 1s heartbeat renews it
    probe.sweGate.releaseAll();
    const done = await run;
    assert.equal(done.state, 'BLOCKED'); assert.equal(done.blocked_code, 'CONFLICT'); assert.equal(probe.commits, 0);
    store.close();
  });

  it('does not count an expired lease toward slots and recovers only expired leases', async () => {
    const path = join(root, 'jobs.sqlite'); const a = new SqliteJobStore(path); const probe = newProbe();
    const past = '2000-01-01T00:00:00.000Z'; const far = '2099-01-01T00:00:00.000Z';
    const ids = [1, 2, 3].map(uuid);
    for (const [i, id] of ids.entries()) await a.create(rawJob(id, `SAMPLE-${i + 1}`));
    assert.equal(await a.claim(ids[0]!, 'dead-1', past, 3), true); assert.equal(await a.claim(ids[1]!, 'dead-2', past, 3), true); assert.equal(await a.claim(ids[2]!, 'live-other', far, 3), true);
    await a.transition(ids[1]!, 'INVESTIGATING', 'IMPLEMENTING');
    config.jobs.max_parallel = 3; const other = new SqliteJobStore(path);
    const service = new WorkflowService(deps(probe, other, new FileArtifactStore(config.storage.artifacts_dir), () => []));
    assert.equal(await service.recover(), 2);
    assert.deepEqual(new Set(probe.stops), new Set([ids[0]!, ids[1]!]));
    assert.equal((await a.get(ids[0]!))?.state, 'BLOCKED'); assert.equal((await a.get(ids[1]!))?.state, 'BLOCKED');
    assert.equal((await a.get(ids[2]!))?.state, 'INVESTIGATING');
    const raw = new DatabaseSync(path); assert.deepEqual((raw.prepare('SELECT job_id,owner FROM leases').all() as Array<{ job_id: string; owner: string }>).map((r) => r.owner), ['live-other']);
    assert.equal((await service.activity()).active_jobs.length, 1);
    raw.close(); a.close(); other.close();
  });
});
