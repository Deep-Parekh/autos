import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AutosError, workflowActivitySchema, type JobEvent, parseConfigYaml, type GitWorkspace, type IssueSnapshot, type JobRecord, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
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

const open = (script: Script, file = 'jobs.sqlite', listen = true) => {
  const store = new SqliteJobStore(join(root, file)); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  const service = new WorkflowService(deps(script, store, artifacts)); const seen: JobEvent[] = [];
  if (listen) service.subscribe((e) => seen.push(e));
  return { store, artifacts, service, seen };
};
const all = async (service: WorkflowService, job_id?: string) => service.events({ ...(job_id ? { job_id } : {}), limit: 500 });
const assertMonotonic = (events: JobEvent[]) => { for (let i = 1; i < events.length; i++) assert.ok(events[i]!.event_id > events[i - 1]!.event_id); };

describe('progress events', () => {
  it('records an ordered sequence for a dry run and sets base_branch', async () => {
    const script = newScript(['SAMPLE-1']); const { service, store, seen } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', true)).job_id);
    assert.equal(job.state, 'PLANNED'); assert.equal(job.base_branch, 'develop');
    const events = await all(service, job.job_id); assertMonotonic(events);
    assert.deepEqual(events, seen);
    assert.deepEqual(events.map((e) => e.type), ['job_queued', 'job_started', 'state_changed', 'stage_started', 'stage_finished', 'stage_started', 'stage_finished', 'stage_started', 'stage_finished', 'state_changed', 'job_finished']);
    assert.deepEqual(events.filter((e) => e.type === 'stage_started').map((e) => e.stage), ['intake', 'routing', 'finalize']);
    assert.equal(events.at(-1)!.type, 'job_finished'); assert.equal(events.at(-1)!.state, 'PLANNED');
    store.close();
  });

  it('records a full run with one repair round', async () => {
    const script = newScript(['SAMPLE-1']);
    script.review = (round, d) => round === 0 ? { schema_version: 1, candidate_digest: d, status: 'FAIL', findings: [{ severity: 'HIGH', file: 'src/Fix.java', line: 3, issue: 'Null dereference', suggested_fix: 'Guard' }] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] };
    const { service, store } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.equal(job.base_branch, 'develop');
    const events = await all(service, job.job_id); assertMonotonic(events);
    assert.equal(events.at(-1)!.type, 'job_finished'); assert.equal(events.at(-1)!.state, 'READY_FOR_HUMAN');
    assert.deepEqual(events.filter((e) => e.type === 'stage_started').map((e) => e.stage), ['intake', 'routing', 'baseline', 'implementation', 'checks', 'qa', 'review', 'repair', 'checks', 'qa', 'review', 'finalize', 'push']);
    assert.deepEqual(events.filter((e) => e.type === 'role_started').map((e) => `${e.role}:${e.repair_round}`), ['swe:0', 'qa:0', 'reviewer:0', 'swe:1', 'qa:1', 'reviewer:1']);
    const finished = events.filter((e) => e.type === 'role_finished'); assert.equal(finished.length, 6);
    for (const f of finished) { assert.equal(f.outcome, 'SUCCEEDED'); assert.equal(typeof f.elapsed_ms, 'number'); assert.ok(f.provider); }
    assert.equal(events.filter((e) => e.type === 'repair_round_started').length, 1);
    assert.deepEqual(events.filter((e) => e.type === 'state_changed').map((e) => e.state), ['INVESTIGATING', 'IMPLEMENTING', 'QA', 'REVIEW', 'REVISING', 'IMPLEMENTING', 'QA', 'REVIEW', 'READY_FOR_HUMAN']);
    const checks = events.filter((e) => e.type === 'checks_finished'); assert.ok(checks.length >= 4); assert.ok(checks.every((c) => c.outcome === 'PASS' && (c.count ?? 0) > 0));
    assert.equal(events.filter((e) => e.type === 'commit_created').length, 1); assert.match(events.find((e) => e.type === 'commit_created')!.message ?? '', /cccccccccccc/);
    assert.equal(events.find((e) => e.type === 'push_finished')!.outcome, 'DISABLED');
    assert.ok(events.every((e) => e.stage === undefined || ['intake','routing','baseline','implementation','checks','qa','review','repair','finalize','push'].includes(e.stage)));
    // events are queryable by cursor and filter
    const mid = events[3]!.event_id; const rest = await service.events({ job_id: job.job_id, after: mid, limit: 2 }); assert.deepEqual(rest.map((e) => e.event_id), events.slice(4, 6).map((e) => e.event_id));
    assert.equal((await service.events({ job_id: job.job_id, limit: 0 })).length, 1); assert.equal((await service.events({ job_id: '00000000-0000-4000-8000-000000000000', limit: 5 })).length, 0);
    store.close();
  });

  it('records blocked outcomes with a code and a failed role', async () => {
    const script = newScript(['SAMPLE-1']);
    script.role = (role) => role === 'qa' ? { provider: 'claude', role: 'qa', status: 'TIMED_OUT', exit_code: 1, elapsed_ms: 5, transcript_path: '/x', error_code: 'TIMEOUT' } as ProviderResult : undefined;
    const { service, store } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'BLOCKED');
    const events = await all(service, job.job_id);
    const qa = events.find((e) => e.type === 'role_finished' && e.role === 'qa')!; assert.equal(qa.outcome, 'TIMED_OUT'); assert.equal(qa.code, 'TIMEOUT');
    const last = events.at(-1)!; assert.equal(last.type, 'job_finished'); assert.equal(last.state, 'BLOCKED'); assert.equal(last.code, 'TIMEOUT');
    assert.ok(events.some((e) => e.type === 'stage_finished' && e.stage === 'qa' && e.outcome === 'FAILED'));
    store.close();
  });

  it('records cancellation of a queued job', async () => {
    const script = newScript(['SAMPLE-1']); const { service, store } = open(script);
    const job = await service.submit('SAMPLE-1', false); await service.cancel(job.job_id);
    const events = await all(service, job.job_id);
    assert.deepEqual(events.map((e) => [e.type, e.state]), [['job_queued', 'QUEUED'], ['state_changed', 'CANCELLING'], ['state_changed', 'CANCELLED'], ['job_finished', 'CANCELLED']]);
    store.close();
  });

  it('records poll events, including a filter failure', async () => {
    const script = newScript(['SAMPLE-1', 'SAMPLE-2']); const { service, store } = open(script);
    await service.poll();
    let events = (await all(service)).filter((e) => e.type.startsWith('poll_'));
    assert.deepEqual(events.map((e) => e.type), ['poll_started', 'poll_finished']); assert.equal(events[1]!.count, 2); assert.match(events[1]!.message ?? '', /2 newly queued/); assert.equal(events[0]!.job_id, null);
    script.filterError = new AutosError('UPSTREAM', 'Jira down at https://secret.example/x?token=abc');
    await assert.rejects(() => service.poll(), { code: 'UPSTREAM' });
    events = (await all(service)).filter((e) => e.type.startsWith('poll_')); assert.deepEqual(events.map((e) => e.type), ['poll_started', 'poll_finished', 'poll_started', 'poll_failed']);
    assert.equal(events.at(-1)!.code, 'UPSTREAM'); assert.equal(JSON.stringify(await all(service)).includes('secret.example'), false);
    const activity = await service.activity(); assert.deepEqual([activity.polling.in_progress, activity.polling.last_outcome, activity.polling.last_error_code, activity.polling.last_discovered], [false, 'FAILED', 'UPSTREAM', 2]);
    store.close();
  });

  it('records restart recovery', async () => {
    const script = newScript(['SAMPLE-1']); const { service, store } = open(script);
    const job = await service.submit('SAMPLE-1', false);
    await store.claim(job.job_id, 'dead-owner', new Date(Date.now() - 1000).toISOString());
    assert.equal(await service.recover(), 1);
    assert.deepEqual((await all(service, job.job_id)).map((e) => e.type), ['job_queued', 'recovered', 'state_changed', 'job_finished']);
    store.close();
  });

  it('delivers live events to subscribers, isolates throwing ones and supports unsubscribe', async () => {
    const script = newScript(['SAMPLE-1']); const { service, store, seen } = open(script);
    service.subscribe(() => { throw new Error('listener exploded'); });
    const off = service.subscribe(() => { throw new Error('also exploded'); }); off();
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.deepEqual(seen, await all(service, job.job_id));
    const before = seen.length; const stop = service.subscribe(() => undefined); stop();
    assert.equal(seen.length, before);
    store.close();
  });

  it('derives activity mid-run from SQLite, visible to a second process', async () => {
    const script = newScript(['SAMPLE-1']); const { service, store } = open(script, 'shared.sqlite');
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void; const inRole = new Promise<void>((r) => { entered = r; });
    const inner = deps(script, store, new FileArtifactStore(config.storage.artifacts_dir));
    const blocking = new WorkflowService({ ...inner, runner: { ...inner.runner, async runRole(req, signal) { if (req.role === 'qa') { entered(); await gate; } return inner.runner.runRole(req, signal); } } });
    const job = await blocking.submit('SAMPLE-1', false); const running = blocking.execute(job.job_id);
    await inRole;
    const mid = await blocking.activity(); workflowActivitySchema.parse(mid);
    assert.equal(mid.active?.job_id, job.job_id); assert.equal(mid.active?.state, 'QA'); assert.equal(mid.active?.stage, 'qa'); assert.equal(mid.active?.role, 'qa'); assert.equal(mid.active?.provider, config.agents.qa.provider);
    assert.ok(mid.active?.stage_started_at); assert.ok(mid.active?.started_at); assert.equal(mid.counts.QA, 1); assert.ok(mid.last_event_id > 0);
    const other = new SqliteJobStore(join(root, 'shared.sqlite')); const second = new WorkflowService(deps(script, other, new FileArtifactStore(config.storage.artifacts_dir)));
    const seenElsewhere = await second.activity(); assert.deepEqual(seenElsewhere, mid);
    assert.ok((await second.events({ job_id: job.job_id, limit: 500 })).length > 5);
    release(); const done = await running; assert.equal(done.state, 'READY_FOR_HUMAN');
    const after = await second.activity(); assert.equal(after.active, null); assert.equal(after.counts.READY_FOR_HUMAN, 1); assert.equal(after.counts.QA, undefined);
    other.close(); store.close();
  });

  it('never leaks prompts, diffs, paths or tokens into events', async () => {
    const secret = 'ghp_FAKETOKEN1234567890abcdef';
    const script = newScript(['SAMPLE-1']); script.issues.set('SAMPLE-1', issue('SAMPLE-1', { description: `Please use token=${secret} and https://user:pw@example.com/repo.git` }));
    script.review = (round, d) => round === 0 ? { schema_version: 1, candidate_digest: d, status: 'FAIL', findings: [{ severity: 'HIGH', file: 'src/Fix.java', line: 3, issue: 'Null dereference', suggested_fix: 'Guard' }] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] };
    const { service, store } = open(script);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    const text = JSON.stringify(await all(service));
    for (const forbidden of [secret, 'user:pw', 'example.com/repo', '+ fixed v', 'Platform policy is authoritative', 'Acceptance criteria', 'src/Fix.java', root, 'prompt.md', 'transcript', job.feature_branch ?? 'x/y']) assert.equal(text.includes(forbidden), false, forbidden);
    assert.equal(/\/(?:[\w.-]+\/){2,}/.test(text), false);
    store.close();
  });

  it('migrates a database created without job_events or base_branch idempotently', async () => {
    const path = join(root, 'old.sqlite'); const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE jobs (job_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, repository_id TEXT, base_sha TEXT, state TEXT NOT NULL, dry_run INTEGER NOT NULL, repair_round INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, blocked_code TEXT, blocked_reason TEXT, feature_branch TEXT, commit_sha TEXT);
      CREATE TABLE leases (job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE, owner TEXT NOT NULL, lease_until TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1,'2026-01-01T00:00:00.000Z');
      INSERT INTO jobs VALUES('11111111-1111-4111-8111-111111111111','SAMPLE-9',NULL,NULL,'BLOCKED',0,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','CONFLICT','x',NULL,NULL);`);
    old.close();
    for (let i = 0; i < 2; i++) { const s = new SqliteJobStore(path); assert.equal((await s.get('11111111-1111-4111-8111-111111111111'))?.state, 'BLOCKED'); assert.deepEqual(s.events({ limit: 5 }), []); s.close(); }
    const script = newScript(['SAMPLE-1']); const store = new SqliteJobStore(path); const service = new WorkflowService(deps(script, store, new FileArtifactStore(config.storage.artifacts_dir)));
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id); assert.equal(job.base_branch, 'develop');
    assert.equal((await service.activity()).counts.BLOCKED, 1); store.close();
  });

  it('never persists invalid events and truncates over-long messages', async () => {
    const script = newScript([]); const { store } = open(script);
    const e = store.appendEvent({ type: 'poll_finished', job_id: null, issue_key: null, message: 'x'.repeat(1000) }, '2026-11-07T20:00:00.000Z'); assert.equal(e.message!.length, 300);
    assert.throws(() => store.appendEvent({ type: 'poll_finished', job_id: null, issue_key: null, outcome: 'bad value!' }, '2026-11-07T20:00:00.000Z'));
    assert.equal(store.events({ limit: 10 }).length, 1);
    store.close();
  });
});
