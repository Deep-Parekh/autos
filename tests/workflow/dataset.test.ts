import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { datasetRecordSchema, parseConfigYaml, type GitPrepareRequest, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { exportDataset, FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

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
  root = await mkdtemp(join(tmpdir(), 'autos-dataset-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
  config.agents.swe = { ...config.agents.swe, provider: 'claude', fallbacks: [{ provider: 'codex' }, { provider: 'cursor', model: 'auto' }] };
  config.agents.qa = { ...config.agents.qa, provider: 'codex', fallbacks: [{ provider: 'claude' }, { provider: 'cursor', model: 'auto' }] };
  config.agents.reviewer = { ...config.agents.reviewer, provider: 'cursor', model: 'auto', fallbacks: [{ provider: 'claude' }, { provider: 'codex' }] };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const dbPath = () => join(config.storage.data_dir, 'autos.sqlite');
class FailingWriteStore extends FileArtifactStore { override async writeCall(): Promise<void> { throw new Error('disk full'); } }
const open = (script: Script, make: (root: string) => FileArtifactStore = (r) => new FileArtifactStore(r)) => {
  const store = new SqliteJobStore(dbPath()); const artifacts = make(config.storage.artifacts_dir);
  return { store, service: new WorkflowService(deps(script, store, artifacts)) };
};
const run = async (script: Script, make?: (root: string) => FileArtifactStore) => { const { store, service } = open(script, make); const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id); store.close(); return job; };
const collect = async (options: Parameters<typeof exportDataset>[0]['options'] = {}) => { const out = []; for await (const r of exportDataset({ config, options, now: () => new Date('2026-11-08T00:00:00.000Z') })) out.push(r); return out; };
const calls = async (jobId: string, role: string) => {
  const dir = join(config.storage.artifacts_dir, jobId, '_private', role);
  return Promise.all((await readdir(dir)).map(async (id) => JSON.parse(await readFile(join(dir, id, 'call.json'), 'utf8')) as Record<string, any>));
};

// ---- Synthetic fixtures for outcome tests: rows are inserted into a migrated database, artifacts are written by hand.
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
interface Fx { id: number; issue?: string; state?: string; dry?: boolean; parent?: number; revision?: number; created?: string; code?: string }
function seed(rows: Fx[], extra?: (db: DatabaseSync) => void) {
  new SqliteJobStore(dbPath()).close();
  const db = new DatabaseSync(dbPath());
  for (const r of rows) {
    const created = r.created ?? `2026-11-${String(r.id).padStart(2, '0')}T10:00:00.000Z`;
    db.prepare('INSERT INTO jobs(job_id,issue_key,repository_id,base_sha,state,dry_run,repair_round,created_at,updated_at,blocked_code,feature_branch,commit_sha,base_branch,parent_job_id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(uuid(r.id), r.issue ?? 'SAMPLE-1', 'example/sample-app', BASE, r.state ?? 'READY_FOR_HUMAN', r.dry ? 1 : 0, 0, created, created, r.code ?? null, `deep/${r.issue ?? 'SAMPLE-1'}`, 'c'.repeat(40), 'develop', r.parent ? uuid(r.parent) : null, r.revision ?? 0);
  }
  extra?.(db); db.close();
}
const note = (db: DatabaseSync, job: number, text: string) => db.prepare('INSERT INTO operator_notes(job_id,seq,instructions,roles,author,created_at) VALUES(?,?,?,?,?,?)').run(uuid(job), 0, text, '["swe"]', 'deep', '2026-11-05T00:00:00.000Z');
const jobDir = (n: number) => join(config.storage.artifacts_dir, uuid(n));
async function artifact(n: number, name: string, content: string) { await mkdir(jobDir(n), { recursive: true }); await writeFile(join(jobDir(n), name), content); }
async function invocation(n: number, role: string, id: number, files: { call?: unknown | string; prompt?: string; transcript?: string }) {
  const dir = join(jobDir(n), '_private', role, uuid(id)); await mkdir(join(dir, 'input'), { recursive: true }); await mkdir(join(dir, 'output'), { recursive: true });
  if (files.call !== undefined) await writeFile(join(dir, 'call.json'), typeof files.call === 'string' ? files.call : JSON.stringify(files.call));
  if (files.prompt !== undefined) await writeFile(join(dir, 'input', 'prompt.md'), files.prompt);
  if (files.transcript !== undefined) await writeFile(join(dir, 'output', 'transcript.jsonl'), files.transcript);
  return dir;
}
const callMeta = (job: number, role: 'swe' | 'qa' | 'reviewer', id: number, startedAt: string) => ({ schema_version: 1, invocation_id: uuid(id), job_id: uuid(job), role, provider: 'claude', model: null, chain_index: 0, repair_round: 0, started_at: startedAt, elapsed_ms: 5, status: 'SUCCEEDED', error_code: null, continued_from_handoff: false });

describe('call.json per provider attempt', () => {
  it('is written for every attempt including failed and fallback attempts, outside the public manifest', async () => {
    const s = newScript(); failWith(s, 'claude:swe', { code: 'UNAVAILABLE' });
    const job = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    const swe = (await calls(job.job_id, 'swe')).sort((a, b) => a.chain_index - b.chain_index);
    assert.deepEqual(swe.map((c) => [c.provider, c.chain_index, c.status, c.error_code, c.continued_from_handoff, c.repair_round]), [['claude', 0, 'FAILED', 'UNAVAILABLE', false, 0], ['codex', 1, 'SUCCEEDED', null, false, 0]]);
    assert.equal(swe[0]!.model, null); assert.equal(swe[0]!.job_id, job.job_id); assert.ok(Number.isInteger(swe[0]!.elapsed_ms));
    assert.equal((await calls(job.job_id, 'qa')).length, 1); assert.equal((await calls(job.job_id, 'reviewer')).length, 1);
    const reviewer = (await calls(job.job_id, 'reviewer'))[0]!; assert.equal(reviewer.model, 'auto');
    const manifest = JSON.parse(await readFile(join(config.storage.artifacts_dir, job.job_id, 'manifest.json'), 'utf8')) as { files: Array<{ name: string }> };
    assert.ok(!manifest.files.some((f) => /call\.json|_private/.test(f.name)));
  });
  it('records timed-out attempts, retries and malformed-output attempts', async () => {
    const s = newScript(); failWith(s, 'claude:swe', { code: 'TIMEOUT', status: 'TIMED_OUT' });
    outputWith(s, 'cursor:reviewer', 'not json', 'still not json');
    const job = await run(s);
    const swe = (await calls(job.job_id, 'swe')).sort((a, b) => a.chain_index - b.chain_index);
    assert.equal(swe[0]!.status, 'TIMED_OUT'); assert.equal(swe[0]!.error_code, 'TIMEOUT');
    const reviewer = (await calls(job.job_id, 'reviewer')).sort((a, b) => a.chain_index - b.chain_index);
    assert.deepEqual(reviewer.map((c) => [c.provider, c.status, c.error_code]), [['cursor', 'FAILED', 'INVALID_OUTPUT'], ['cursor', 'FAILED', 'INVALID_OUTPUT'], ['claude', 'SUCCEEDED', null]]);
  });
  it('never fails or blocks the job when call.json cannot be written', async () => {
    const job = await run(newScript(), (r) => new FailingWriteStore(r));
    assert.equal(job.state, 'READY_FOR_HUMAN');
    const records = await collect();
    assert.equal(records[0]!.calls.length, 3); assert.ok(records[0]!.calls.every((c) => c.call === null && c.prompt !== null));
  });
});

describe('exportDataset', () => {
  it('exports a real run with calls, artifacts and timeline, all validating', async () => {
    const job = await run(newScript());
    const [record] = await collect(); assert.ok(record);
    assert.equal(datasetRecordSchema.safeParse(record).success, true);
    assert.equal(record.job_id, job.job_id); assert.equal(record.outcome, 'awaiting_review'); assert.equal(record.final_state, 'READY_FOR_HUMAN'); assert.equal(record.exported_at, '2026-11-08T00:00:00.000Z');
    assert.deepEqual(record.calls.map((c) => c.role), ['swe', 'qa', 'reviewer']); assert.ok(record.calls.every((c) => c.call !== null && c.prompt && c.transcript === null && !c.transcript_truncated));
    assert.ok(record.issue && record.rounds && record.checks && record.qa && record.review && record.final_diff);
    assert.ok(record.timeline.some((e) => e.type === 'role_started' && e.role === 'swe'));
  });

  it('classifies outcomes, skips dry runs and active/planned jobs, and attaches revision feedback', async () => {
    seed([
      { id: 1, issue: 'SAMPLE-1' }, { id: 2, issue: 'SAMPLE-1', parent: 1, revision: 1 }, // 1 revised, 2 merged (closure)
      { id: 3, issue: 'SAMPLE-2', state: 'BLOCKED', code: 'CHECK_FAILED' }, { id: 4, issue: 'SAMPLE-2', state: 'READY_FOR_HUMAN' }, // 3 blocked, 4 abandoned
      { id: 5, issue: 'SAMPLE-3', state: 'CANCELLED' }, { id: 6, issue: 'SAMPLE-4' }, // cancelled, awaiting_review
      { id: 7, issue: 'SAMPLE-5', dry: true, state: 'PLANNED' }, { id: 8, issue: 'SAMPLE-5', state: 'PLANNED' }, { id: 9, issue: 'SAMPLE-6', state: 'RUNNING_SWE' },
      { id: 10, issue: 'SAMPLE-7', dry: true }, { id: 11, issue: 'SAMPLE-8', state: 'READY_FOR_HUMAN' }, // 11: closed issue but not the closure's attempt
      { id: 12, issue: 'SAMPLE-8', state: 'READY_FOR_HUMAN', parent: 11 },
    ], (db) => {
      note(db, 2, 'please also handle nulls');
      db.prepare('INSERT INTO issue_closures(issue_key,resolution,closed_at,closed_by,job_id,commit_sha,feature_branch) VALUES(?,?,?,?,?,?,?)').run('SAMPLE-1', 'MERGED', '2026-11-06T00:00:00.000Z', 'deep', uuid(2), 'c'.repeat(40), 'deep/SAMPLE-1');
      db.prepare('INSERT INTO issue_closures(issue_key,resolution,closed_at,closed_by,job_id,commit_sha,feature_branch) VALUES(?,?,?,?,?,?,?)').run('SAMPLE-2', 'ABANDONED', '2026-11-06T00:00:00.000Z', 'deep', uuid(4), null, null);
      db.prepare('INSERT INTO issue_closures(issue_key,resolution,closed_at,closed_by,job_id,commit_sha,feature_branch) VALUES(?,?,?,?,?,?,?)').run('SAMPLE-8', 'MERGED', '2026-11-06T00:00:00.000Z', 'deep', uuid(12), null, null);
    });
    const byId = new Map((await collect()).map((r) => [Number.parseInt(r.job_id.slice(-12), 16), r]));
    assert.deepEqual([...byId.keys()], [1, 2, 3, 4, 5, 6, 11, 12]);
    assert.deepEqual([...byId.values()].map((r) => r.outcome), ['revised', 'merged', 'blocked', 'abandoned', 'cancelled', 'awaiting_review', 'revised', 'merged']);
    assert.deepEqual(byId.get(1)!.feedback.map((n) => n.instructions), ['please also handle nulls']);
    assert.equal(byId.get(2)!.feedback.length, 0); assert.equal(byId.get(2)!.parent_job_id, uuid(1)); assert.equal(byId.get(2)!.revision, 1);
    assert.deepEqual(byId.get(2)!.operator_notes.map((n) => [n.author, n.roles]), [['deep', ['swe']]]);
    assert.equal(byId.get(3)!.blocked_code, 'CHECK_FAILED');
  });

  it('applies since, issue_key and outcome filters', async () => {
    seed([{ id: 1, issue: 'SAMPLE-1' }, { id: 2, issue: 'SAMPLE-2', state: 'BLOCKED' }, { id: 3, issue: 'SAMPLE-2', state: 'CANCELLED' }]);
    const ids = async (o: Parameters<typeof collect>[0]) => (await collect(o)).map((r) => Number.parseInt(r.job_id.slice(-12), 16));
    assert.deepEqual(await ids({}), [1, 2, 3]);
    assert.deepEqual(await ids({ since: '2026-11-02T00:00:00.000Z' }), [2, 3]);
    assert.deepEqual(await ids({ since: '2026-11-03T10:00:00.000Z' }), [3]); // inclusive
    assert.deepEqual(await ids({ issue_key: 'SAMPLE-2' }), [2, 3]);
    assert.deepEqual(await ids({ outcomes: ['blocked', 'awaiting_review'] }), [1, 2]);
    assert.deepEqual(await ids({ issue_key: 'SAMPLE-2', outcomes: ['cancelled'], since: '2026-11-01T00:00:00.000Z' }), [3]);
    await assert.rejects(() => collect({ outcomes: [] }));
  });

  it('reads artifacts, honours include flags, detects truncation and sorts calls by start time', async () => {
    seed([{ id: 1 }]);
    await artifact(1, 'issue.json', '{"key":"SAMPLE-1"}'); await artifact(1, 'rounds.json', '{"rounds":[]}'); await artifact(1, 'effective-instructions.md', 'be careful'); await artifact(1, 'changes.patch', '+x');
    await invocation(1, 'swe', 20, { call: callMeta(1, 'swe', 20, '2026-11-01T10:05:00.000Z'), prompt: 'late', transcript: '{"a":1}\n[transcript truncated]\n' });
    await invocation(1, 'swe', 21, { call: callMeta(1, 'swe', 21, '2026-11-01T10:01:00.000Z'), prompt: 'early', transcript: '{"b":2}\n' });
    await invocation(1, 'qa', 22, { call: callMeta(1, 'qa', 22, '2026-11-01T10:03:00.000Z'), prompt: 'mid', transcript: '' });
    const [full] = await collect();
    assert.deepEqual(full!.calls.map((c) => c.prompt), ['early', 'mid', 'late']);
    assert.deepEqual(full!.calls.map((c) => c.transcript_truncated), [false, false, true]);
    assert.equal(full!.calls[2]!.transcript, '{"a":1}\n[transcript truncated]\n');
    assert.deepEqual(full!.issue, { key: 'SAMPLE-1' }); assert.equal(full!.instructions, 'be careful'); assert.equal(full!.final_diff, '+x'); assert.equal(full!.checks, null); assert.equal(full!.precedents, null);
    const [noPrompts] = await collect({ include_prompts: false }); assert.ok(noPrompts!.calls.every((c) => c.prompt === null && c.transcript !== null));
    const [noTranscripts] = await collect({ include_transcripts: false }); assert.ok(noTranscripts!.calls.every((c) => c.transcript === null && !c.transcript_truncated && c.prompt !== null));
  });

  it('orders by directory mtime when call.json is missing and never throws on missing or malformed files', async () => {
    seed([{ id: 1 }, { id: 2 }]);
    await artifact(1, 'issue.json', '{not json'); await artifact(1, 'checks.json', '');
    const older = await invocation(1, 'swe', 30, { prompt: 'p-old' }); const newer = await invocation(1, 'swe', 31, { call: '{"schema_version":2}', prompt: 'p-new' });
    await utimes(older, new Date('2026-11-01T09:00:00Z'), new Date('2026-11-01T09:00:00Z')); await utimes(newer, new Date('2026-11-01T11:00:00Z'), new Date('2026-11-01T11:00:00Z'));
    await mkdir(join(jobDir(1), '_private', 'swe', 'not-a-uuid'), { recursive: true }); await mkdir(join(jobDir(1), '_private', 'other', uuid(32)), { recursive: true });
    await writeFile(join(jobDir(1), '_private', 'swe', uuid(33)), 'a file, not a directory');
    const records = await collect();
    assert.equal(records.length, 2);
    const first = records[0]!; assert.equal(first.issue, null); assert.equal(first.checks, null);
    assert.deepEqual(first.calls.map((c) => [c.invocation_id, c.call, c.prompt, c.transcript]), [[uuid(30), null, 'p-old', null], [uuid(31), null, 'p-new', null]]);
    assert.deepEqual(records[1]!.calls, []); assert.equal(records[1]!.final_diff, null);
  });

  it('does not follow symlinks out of the artifacts directory', async () => {
    seed([{ id: 1 }]);
    const secret = join(root, 'secret.txt'); await writeFile(secret, 'TOP SECRET'); await writeFile(join(root, 'secret.json'), '{"leak":true}');
    await mkdir(jobDir(1), { recursive: true }); await symlink(secret, join(jobDir(1), 'changes.patch')); await symlink(join(root, 'secret.json'), join(jobDir(1), 'issue.json'));
    const dir = await invocation(1, 'swe', 40, { call: callMeta(1, 'swe', 40, '2026-11-01T10:00:00.000Z') });
    await symlink(secret, join(dir, 'input', 'prompt.md')); await symlink(secret, join(dir, 'output', 'transcript.jsonl'));
    const outside = join(root, 'outside'); await mkdir(join(outside, 'input'), { recursive: true }); await writeFile(join(outside, 'input', 'prompt.md'), 'TOP SECRET');
    await symlink(outside, join(jobDir(1), '_private', 'swe', uuid(41)));
    const [record] = await collect(); const text = JSON.stringify(record);
    assert.ok(!text.includes('TOP SECRET') && !text.includes('leak')); assert.equal(record!.final_diff, null); assert.equal(record!.issue, null);
    assert.deepEqual(record!.calls.map((c) => [c.invocation_id, c.prompt, c.transcript]), [[uuid(40), null, null]]);
  });

  it('reads the database read-only and fails clearly when it is missing', async () => {
    await assert.rejects(() => collect(), /database not found/);
    seed([{ id: 1 }]); const before = (await readdir(config.storage.data_dir)).sort();
    await collect(); assert.equal((await readdir(config.storage.data_dir)).filter((f) => !before.includes(f) && !/-(wal|shm)$/.test(f)).length, 0);
  });
});
