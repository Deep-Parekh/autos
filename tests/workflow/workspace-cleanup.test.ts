import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, type GitPrepareRequest, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let clockMs = Date.now();
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
let issueOverride: Partial<IssueSnapshot> = {};
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', ...issueOverride } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');
const SECRET_NOTE = 'Also handle the zebra-crossing edge case';

interface Script {
  mappings: ProjectMapping[]; digestIndex: number; commitSeq: number; calls: string[]; prepares: GitPrepareRequest[];
  prompts: { role: string; text: string }[]; incremental?: { paths: string[]; diff: string }; failChecksOnce?: boolean;
  review: (digest: string) => unknown;
}
const newScript = (): Script => ({ mappings: [mapping], digestIndex: 1, commitSeq: 0, calls: [], prepares: [], prompts: [],
  review: (d) => ({ schema_version: 1, candidate_digest: d, status: 'PASS', findings: [{ severity: 'LOW', file: 'src/Fix.java', line: 3, issue: 'nit about naming', suggested_fix: 'rename' }] }) });

function deps(script: Script, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date(clockMs) },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return ['SAMPLE-1', 'SAMPLE-2']; },
      async listIssues() { return [issue('SAMPLE-1')]; },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return script.mappings; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { script.calls.push('resolveBase'); return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        script.calls.push(`prepare:${req.job_id}`); script.prepares.push(req);
        const directory = join(config.storage.workspaces_dir, `${req.job_id}-${randomUUID()}`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}`, ...(req.continue_from ? { start_sha: req.continue_from.parent_commit_sha } : {}) } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digestIndex), paths: ['src/Fix.java'], diff: `+ fixed v${script.digestIndex}`, ...(script.incremental ? { incremental: script.incremental } : {}) }; },
      async commit(req) { script.commitSeq++; return { commit_sha: String(script.commitSeq).repeat(40).slice(0, 40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        script.calls.push(`role:${req.role}`); script.prompts.push({ role: req.role, text: await readFile(req.prompt_path, 'utf8') });
        const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (req.role === 'swe') { script.digestIndex++; return { ...base, result: 'Implemented.' } as ProviderResult; }
        const d = sha(script.digestIndex);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : script.review(d) } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        script.calls.push('checks');
        const failing = script.failChecksOnce; script.failChecksOnce = false;
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: failing ? 'FAIL' : 'PASS', exit_code: failing ? 1 : 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
    },
  };
}

beforeEach(async () => {
  clockMs = Date.now();
  root = await mkdtemp(join(tmpdir(), 'autos-cleanup-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  await mkdir(config.storage.workspaces_dir, { recursive: true });
});
afterEach(async () => {
  for (const name of await readdir(config.storage.workspaces_dir).catch(() => [] as string[])) await chmod(join(config.storage.workspaces_dir, name, 'locked'), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const open = (script: Script) => {
  const store = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, artifacts, service: new WorkflowService(deps(script, store, artifacts)) };
};
const ws = (name: string) => join(config.storage.workspaces_dir, name);
const exists = async (path: string) => stat(path).then(() => true, () => false);
const dirs = async () => (await readdir(config.storage.workspaces_dir)).sort();
const note = { instructions: SECRET_NOTE, roles: ['swe' as const] };
const ready = async (service: WorkflowService, key = 'SAMPLE-1') => {
  const job = await service.execute((await service.submit(key, false)).job_id); assert.equal(job.state, 'READY_FOR_HUMAN'); return job;
};
const OLD = '2020-01-01T00:00:00.000Z';
let seq = 0;
/** Inserts a job row directly (state shortcuts) and optionally plants its workspace directory. */
function plant(store: SqliteJobStore, spec: { id?: string; issue: string; state: string; created?: string; updated?: string; parent?: string; plant?: boolean; old?: boolean; record?: boolean }): { id: string; name: string } {
  const id = spec.id ?? randomUUID(); const created = spec.created ?? `2020-01-01T00:00:${String(seq++ % 60).padStart(2, '0')}.000Z`; const updated = spec.updated ?? OLD;
  const db = new DatabaseSync(join(root, 'jobs.sqlite'));
  db.prepare(`INSERT INTO jobs(job_id,issue_key,repository_id,base_sha,state,dry_run,repair_round,created_at,updated_at,blocked_code,blocked_reason,feature_branch,commit_sha,base_branch,parent_job_id,revision)
    VALUES(?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,0)`).run(id, spec.issue, 'example/sample-app', BASE, spec.state, created, updated, spec.state === 'BLOCKED' ? 'CONFLICT' : null, spec.state === 'BLOCKED' ? 'x' : null,
    `deep/${spec.issue}`, spec.state === 'READY_FOR_HUMAN' ? 'a'.repeat(40) : null, 'develop', spec.parent ?? null);
  db.close();
  return { id, name: `${id}-${randomUUID()}` };
}
async function dir(store: SqliteJobStore, p: { id: string; name: string }, opts: { old?: boolean; record?: boolean } = {}) {
  await mkdir(join(ws(p.name), '.git'), { recursive: true }); await writeFile(join(ws(p.name), 'file.txt'), 'content');
  if (opts.record !== false) store.setWorkspaceDir(p.id, ws(p.name));
  if (opts.old !== false) { const t = new Date(OLD); for (const x of [join(ws(p.name), 'file.txt'), join(ws(p.name), '.git'), ws(p.name)]) await utimes(x, t, t); }
}

describe('issue closure and workspace cleanup', () => {
  it('closes MERGED: removes the whole revision chain, keeps artifacts, records closure evidence and event', async () => {
    const script = newScript(); const { store, service } = open(script);
    const parent = await ready(service); const queued = await service.revise(parent.job_id, { instructions: SECRET_NOTE, roles: ['swe'] }, 'alice');
    const child = await service.execute(queued.job_id); assert.equal(child.state, 'READY_FOR_HUMAN');
    assert.equal((await dirs()).length, 2);

    const dry = await service.closeIssue('SAMPLE-1', { resolution: 'MERGED', dry_run: true }, 'alice');
    assert.equal(dry.dry_run, true); assert.equal(dry.removed.length, 2); assert.equal((await dirs()).length, 2);
    assert.equal(await service.closure('SAMPLE-1'), null); assert.equal((await service.get(child.job_id))?.closed_as, undefined);
    assert.equal((await service.events({ limit: 500 })).some((e) => e.type === 'issue_closed'), false);
    assert.equal(await exists(join(config.storage.artifacts_dir, child.job_id, 'closure.json')), false);

    const result = await service.closeIssue('SAMPLE-1', { resolution: 'MERGED', note: 'merged via PR #12 secretnote' }, 'alice');
    assert.equal(result.closure.resolution, 'MERGED'); assert.equal(result.closure.job_id, child.job_id); assert.equal(result.closure.commit_sha, child.commit_sha);
    assert.equal(result.removed.length, 2); assert.deepEqual(result.failed, []); assert.deepEqual(await dirs(), []);
    assert.equal(store.workspaceDir(parent.job_id), null); assert.equal(store.workspaceDir(child.job_id), null);
    assert.equal((await service.get(parent.job_id))?.closed_as, 'MERGED');
    assert.ok((await service.list(10)).every((j) => j.closed_as === 'MERGED'));
    assert.deepEqual(await service.closure('SAMPLE-1'), result.closure);
    assert.ok(await exists(join(config.storage.artifacts_dir, parent.job_id, 'summary.md')));
    const evidence = JSON.parse(await readFile(join(config.storage.artifacts_dir, child.job_id, 'closure.json'), 'utf8'));
    assert.equal(evidence.note, 'merged via PR #12 secretnote'); assert.equal(evidence.removed.length, 2); assert.equal(evidence.closure.resolution, 'MERGED');
    const events = (await service.events({ limit: 500 })).filter((e) => e.type === 'issue_closed');
    assert.equal(events.length, 1); assert.equal(events[0]!.outcome, 'MERGED'); assert.equal(events[0]!.count, 2); assert.equal(events[0]!.job_id, child.job_id);
    assert.equal(JSON.stringify(events).includes('secretnote'), false); assert.equal(JSON.stringify(events).includes(root), false);
    store.close();
  });

  it('refuses to close while active, without a candidate for MERGED, and with a different resolution; same resolution retries removal', async () => {
    const script = newScript(); const { store, service } = open(script);
    await assert.rejects(() => service.closeIssue('SAMPLE-9', { resolution: 'ABANDONED' }, 'alice'), { code: 'NOT_FOUND' });
    const queued = await service.submit('SAMPLE-2', false);
    await assert.rejects(() => service.closeIssue('SAMPLE-2', { resolution: 'ABANDONED' }, 'alice'), { code: 'CONFLICT' });
    await service.cancel(queued.job_id);
    await assert.rejects(() => service.closeIssue('SAMPLE-2', { resolution: 'MERGED' }, 'alice'), { code: 'CONFLICT' });
    await assert.rejects(() => service.closeIssue('SAMPLE-2', { resolution: 'ABANDONED' }, 'bad author!'), { code: 'INVALID_INPUT' });
    assert.equal(await service.closure('SAMPLE-2'), null);
    const first = await service.closeIssue('SAMPLE-2', { resolution: 'ABANDONED', note: 'dropped' }, 'alice');
    assert.equal(first.closure.job_id, null); assert.equal(first.removed.length, 0);
    await assert.rejects(() => service.closeIssue('SAMPLE-2', { resolution: 'MERGED' }, 'alice'), { code: 'CONFLICT' });
    const p = plant(store, { issue: 'SAMPLE-2', state: 'BLOCKED' }); void p;
    const leftover = { id: queued.job_id, name: `${queued.job_id}-${randomUUID()}` }; await dir(store, leftover);
    const again = await service.closeIssue('SAMPLE-2', { resolution: 'ABANDONED' }, 'bob');
    assert.equal(again.closure.closed_by, 'alice'); assert.equal(again.closure.closed_at, first.closure.closed_at);
    assert.equal(again.removed.length, 1); assert.deepEqual(await dirs(), []);
    store.close();
  });

  it('refuses submit, revise, reviseIssue and retry once closed; reviseIssue picks the latest READY attempt', async () => {
    const script = newScript(); const { store, service } = open(script);
    await assert.rejects(() => service.reviseIssue('SAMPLE-1', note, 'alice'), { code: 'NOT_FOUND' });
    const parent = await ready(service);
    const queued = await service.reviseIssue('SAMPLE-1', note, 'alice'); assert.equal(queued.parent_job_id, parent.job_id);
    const child = await service.execute(queued.job_id);
    const second = await service.reviseIssue('SAMPLE-1', note, 'alice'); assert.equal(second.parent_job_id, child.job_id); assert.equal(second.revision, 2);
    await service.cancel(second.job_id);
    const blocked = plant(store, { issue: 'SAMPLE-1', state: 'BLOCKED', created: '2030-01-01T00:00:00.000Z' }); void blocked;
    await service.closeIssue('SAMPLE-1', { resolution: 'ABANDONED' }, 'alice');
    await assert.rejects(() => service.submit('SAMPLE-1', false), /Issue is closed \(ABANDONED\)/);
    await assert.rejects(() => service.submit('SAMPLE-1', true), { code: 'CONFLICT' });
    await assert.rejects(() => service.revise(child.job_id, note, 'alice'), { code: 'CONFLICT' });
    await assert.rejects(() => service.reviseIssue('SAMPLE-1', note, 'alice'), { code: 'CONFLICT' });
    await assert.rejects(() => service.retry(second.job_id), { code: 'CONFLICT' });
    await assert.rejects(() => service.retry(blocked.id), /closed/);
    store.close();
  });

  it('prune keeps active, parent-of-active, awaiting_review and recent work; removes expired terminal, superseded and orphan dirs', async () => {
    const script = newScript(); const { store, service } = open(script);
    const mk = async (spec: Parameters<typeof plant>[1], opts: { old?: boolean } = {}) => { const p = plant(store, spec); await dir(store, p, opts); return p; };
    const active = await mk({ issue: 'A-1', state: 'QUEUED' });
    const parentOfActive = await mk({ issue: 'B-1', state: 'READY_FOR_HUMAN' }); const child = plant(store, { issue: 'B-1', state: 'QUEUED', parent: parentOfActive.id });
    const unrecordedActive = plant(store, { issue: 'C-1', state: 'INVESTIGATING' }); await dir(store, unrecordedActive, { record: false });
    const awaiting = await mk({ issue: 'D-1', state: 'READY_FOR_HUMAN' });
    const sup1 = await mk({ issue: 'E-1', state: 'READY_FOR_HUMAN' }); const sup2 = await mk({ issue: 'E-1', state: 'READY_FOR_HUMAN' });
    const blocked = await mk({ issue: 'F-1', state: 'BLOCKED' }); const cancelled = await mk({ issue: 'G-1', state: 'CANCELLED' });
    const recent = await mk({ issue: 'H-1', state: 'BLOCKED', updated: new Date().toISOString() }, { old: false });
    const orphan = { id: randomUUID(), name: `${randomUUID()}-${randomUUID()}` }; await dir(store, orphan);
    const unrecorded = plant(store, { issue: 'I-1', state: 'BLOCKED' }); await dir(store, unrecorded, { record: false });
    void child;

    const listed = await service.workspaces({ sizes: true });
    const by = (p: { name: string }) => listed.find((w) => w.name === p.name)!;
    assert.equal(by(active).retained_because, 'active'); assert.equal(by(parentOfActive).retained_because, 'active'); assert.equal(by(unrecordedActive).retained_because, 'active');
    assert.equal(by(awaiting).retained_because, 'awaiting_review'); assert.equal(by(sup2).retained_because, 'awaiting_review'); assert.equal(by(sup1).removable, 'superseded');
    assert.equal(by(blocked).removable, 'retention'); assert.equal(by(cancelled).removable, 'retention'); assert.equal(by(recent).retained_because, 'within_retention');
    assert.equal(by(orphan).removable, 'orphan'); assert.equal(by(orphan).issue_key, null); assert.equal(by(unrecorded).removable, 'orphan');
    assert.ok(by(blocked).size_bytes! > 0);
    assert.deepEqual(listed.map((w) => w.modified_at), [...listed.map((w) => w.modified_at)].sort().reverse());
    assert.equal((await service.workspaces())[0]!.size_bytes, null);

    const expected = [sup1, blocked, cancelled, orphan, unrecorded].map((p) => p.name).sort();
    const before = await dirs();
    const dry = await service.pruneWorkspaces({ dry_run: true }); assert.deepEqual(dry.removed.map((e) => e.name).sort(), expected); assert.deepEqual(await dirs(), before);
    assert.equal((await service.events({ limit: 500 })).some((e) => e.type === 'workspaces_pruned'), false);
    const real = await service.pruneWorkspaces({ sizes: true }); assert.deepEqual(real.removed.map((e) => e.name).sort(), expected); assert.deepEqual(real.failed, []);
    assert.ok(real.freed_bytes! > 0); assert.equal(real.remaining, before.length - expected.length);
    assert.deepEqual(await dirs(), before.filter((n) => !expected.includes(n)));
    assert.equal(store.workspaceDir(blocked.id), null); assert.equal(store.workspaceDir(awaiting.id), ws(awaiting.name));
    const pruned = (await service.events({ limit: 500 })).filter((e) => e.type === 'workspaces_pruned'); assert.equal(pruned.length, 1); assert.equal(pruned[0]!.count, expected.length); assert.equal(pruned[0]!.job_id, null);
    const none = await service.pruneWorkspaces({}); assert.equal(none.removed.length, 0);
    assert.equal((await service.events({ limit: 500 })).filter((e) => e.type === 'workspaces_pruned').length, 1);
    // A recent terminal workspace becomes removable with a zero-hour threshold; awaiting_review and active never do.
    clockMs = Date.now() + 1000;
    const zero = await service.pruneWorkspaces({ older_than_hours: 0 }); assert.deepEqual(zero.removed.map((e) => e.name), [recent.name]);
    store.close();
  });

  it('never follows symlinks or touches non-canonical names', async () => {
    const script = newScript(); const { store, service } = open(script);
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'precious.txt'), 'keep');
    const linkName = `${randomUUID()}-${randomUUID()}`; await symlink(outside, ws(linkName));
    const fileName = `${randomUUID()}-${randomUUID()}`; await writeFile(ws(fileName), 'not a dir');
    await mkdir(ws('smoke-1')); await writeFile(join(ws('smoke-1'), 'x'), 'x'); await mkdir(ws(`${randomUUID()}-dir`));
    const t = new Date(OLD); await utimes(ws('smoke-1'), t, t);
    const orphan = { id: randomUUID(), name: `${randomUUID()}-${randomUUID()}` }; await dir(store, orphan);
    assert.deepEqual((await service.workspaces()).map((w) => w.name), [orphan.name]);
    const result = await service.pruneWorkspaces({ older_than_hours: 0 });
    assert.deepEqual(result.removed.map((e) => e.name), [orphan.name]); assert.equal(result.remaining, 0);
    assert.ok(await exists(join(outside, 'precious.txt'))); assert.ok((await readdir(config.storage.workspaces_dir)).includes(linkName)); assert.ok(await exists(ws(fileName))); assert.ok(await exists(join(ws('smoke-1'), 'x')));
    store.close();
  });

  it('reports a removal failure without throwing or leaking paths', async (t) => {
    if (process.getuid?.() === 0) return t.skip('running as root');
    const script = newScript(); const { store, service } = open(script);
    const p = plant(store, { issue: 'F-1', state: 'BLOCKED' }); await dir(store, p);
    await mkdir(join(ws(p.name), 'locked')); await writeFile(join(ws(p.name), 'locked', 'f'), 'x'); await chmod(join(ws(p.name), 'locked'), 0o555);
    for (const x of [join(ws(p.name), 'locked'), ws(p.name)]) await utimes(x, new Date(OLD), new Date(OLD));
    const result = await service.pruneWorkspaces({});
    assert.equal(result.removed.length, 0); assert.deepEqual(result.failed, [{ name: p.name, job_id: p.id, code: 'TOOL' }]); assert.equal(result.remaining, 1);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(store.workspaceDir(p.id), ws(p.name));
    const closed = await service.closeIssue('F-1', { resolution: 'ABANDONED' }, 'alice');
    assert.equal(closed.failed.length, 1); assert.equal(closed.removed.length, 0);
    await chmod(join(ws(p.name), 'locked'), 0o755);
    assert.equal((await service.closeIssue('F-1', { resolution: 'ABANDONED' }, 'alice')).removed.length, 1);
    store.close();
  });

  it('prunes automatically at most hourly during drain and honours auto_prune_workspaces=false', async () => {
    const script = newScript(); const { store, service } = open(script);
    const orphan = async () => { const o = { id: randomUUID(), name: `${randomUUID()}-${randomUUID()}` }; await dir(store, o); return o; };
    const first = await orphan();
    await service.drain(); await service.settleAutoPrune(); assert.equal(await exists(ws(first.name)), false);
    const second = await orphan();
    clockMs += 30 * 60_000; await service.drain(); await service.settleAutoPrune(); assert.equal(await exists(ws(second.name)), true);
    clockMs += 31 * 60_000; await service.drain(); await service.settleAutoPrune(); assert.equal(await exists(ws(second.name)), false);
    assert.equal((await service.events({ limit: 500 })).filter((e) => e.type === 'workspaces_pruned').length, 2);

    config.jobs.auto_prune_workspaces = false;
    const third = await orphan(); clockMs += 3 * 3_600_000;
    await service.drain(); await service.settleAutoPrune(); assert.equal(await exists(ws(third.name)), true);
    store.close();
  });
});
