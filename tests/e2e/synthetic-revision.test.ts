// Human-requested revisions end to end: real GitRunner + workflow + controller HTTP over the synthetic fakes
// (fake Atlassian, fake provider processes, disposable bare remote, TEST-ONLY local runner; no isolation claim).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createController, createRuntime } from '@autos/controller';
import { createSyntheticScenario, regressionTestPath, taskServicePath, type SyntheticScenario } from '../fixtures/synthetic/index.js';

const token = 'synthetic-operator-token-0123456789';
const auth = { authorization: `Bearer ${token}` };
const terminal = new Set(['PLANNED', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED']);
const NOTE_SECRET = 'SECRET-NOTE-TEXT-7F3A9C';
const NOTE = `Please add a null guard to TaskService.complete. [fixture:operator-null-guard] ${NOTE_SECRET}`;
const GUARD = 'if (task == null) throw new IllegalArgumentException("task");';
type Job = { job_id: string; issue_key: string; state: string; commit_sha?: string; base_sha?: string | null; feature_branch?: string; blocked_code?: string; parent_job_id?: string; revision?: number; push_status?: string };

async function harness(options: Parameters<typeof createSyntheticScenario>[0] = {}) {
  const scenario = await createSyntheticScenario(options);
  const runtime = await createRuntime(scenario.runtimeOptions);
  const app = await createController({ ...runtime, operatorToken: token });
  const get = async <T = Job>(url: string): Promise<T> => (await app.inject({ method: 'GET', url, headers: auth })).json() as T;
  const waitTerminal = async (id: string): Promise<Job> => {
    const deadline = Date.now() + 300_000;
    for (;;) { const job = await get(`/v1/jobs/${id}`); if (terminal.has(job.state)) return job; assert.ok(Date.now() < deadline, `job ${id} stuck in ${job.state}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  const submit = async (issue_key: string): Promise<Job> => {
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key, dry_run: false } });
    assert.equal(response.statusCode, 202, response.body);
    return response.json() as Job;
  };
  const revise = (jobId: string, instructions = NOTE, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/revisions`, headers, payload: { instructions } });
  const refs = async () => (await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'for-each-ref', '--format=%(refname) %(objectname)'])).split('\n');
  const close = async () => { await app.close(); await runtime.close(); await scenario.cleanup(); };
  return { scenario, runtime, app, get, waitTerminal, submit, revise, refs, close };
}

function regressionStatus(scenario: SyntheticScenario, jobDirectory: string, revision: string): Promise<number | null> {
  return (async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'autos-rev-tree-'));
    try {
      const archive = join(scratch, 'tree.tar');
      const out = join(scratch, 'tree'); await mkdir(out);
      spawnSync('git', ['archive', '--format=tar', '-o', archive, revision], { cwd: jobDirectory, env: scenario.remote.gitEnv });
      spawnSync('tar', ['-xf', archive, '-C', out]);
      const classes = join(scratch, 'classes'); await mkdir(classes);
      const files = (await readdir(join(out, 'src'), { recursive: true })).filter((n) => n.endsWith('.java')).map((n) => join(out, 'src', n));
      const compile = spawnSync('javac', ['--release', '17', '-d', classes, ...files], { encoding: 'utf8' });
      assert.equal(compile.status, 0, compile.stderr);
      return spawnSync('java', ['-ea', '-cp', classes, 'example.tasks.CompleteTaskRegression']).status;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  })();
}

test('operator revision continues the reviewed commit, is evidenced, never leaks note text, and rejects invalid revisions', { timeout: 600_000 }, async () => {
  const h = await harness();
  const { scenario, app } = h;
  try {
    // 1. Initial run.
    const first = await h.waitTerminal((await h.submit('SAMPLE-123')).job_id);
    assert.equal(first.state, 'READY_FOR_HUMAN', JSON.stringify(first));
    const c1 = first.commit_sha!;
    const dir1 = scenario.workspaces.get(first.job_id)!.directory;
    // Marker text in untrusted issue text must not trigger the operator knob.
    assert.ok(!(await readFile(join(dir1, taskServicePath), 'utf8')).includes(GUARD));

    // 4a. Auth and unknown-job handling before the revision exists.
    assert.equal((await h.revise(first.job_id, NOTE, {})).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/jobs/${first.job_id}/revisions`, headers: auth, payload: { instructions: '   ' } })).statusCode, 400);

    // 2. Revision with a trusted operator note.
    const queued = await h.revise(first.job_id);
    assert.equal(queued.statusCode, 202, queued.body);
    const revisionJob = queued.json() as Job;
    assert.equal(revisionJob.parent_job_id, first.job_id);
    // 4b. While the revision is active (or queued) a second revision attempt is a conflict.
    const concurrent = await h.revise(first.job_id);
    assert.equal(concurrent.statusCode, 409, concurrent.body);
    const second = await h.waitTerminal(revisionJob.job_id);
    assert.equal(second.state, 'READY_FOR_HUMAN', JSON.stringify(second));

    // 3. Lineage and commit shape.
    assert.equal(second.parent_job_id, first.job_id);
    assert.equal(second.revision, 1);
    assert.equal(second.base_sha, first.base_sha);
    assert.equal(second.feature_branch, 'deep/SAMPLE-123');
    const c2 = second.commit_sha!;
    assert.notEqual(c2, c1);
    const dir2 = scenario.workspaces.get(second.job_id)!.directory;
    const git2 = (args: string[]) => scenario.remote.git(args, dir2);
    assert.equal(await git2(['rev-parse', 'HEAD']), c2);
    assert.equal(await git2(['rev-parse', 'HEAD^']), c1, 'C2 builds directly on C1');
    const names = async (range: string[]) => (await git2(['diff', '--name-only', ...range])).split('\n').sort();
    assert.deepEqual(await names([second.base_sha!, c2]), [taskServicePath, regressionTestPath].sort(), 'cumulative change vs base');
    assert.deepEqual(await names([c1, c2]), [taskServicePath], 'incremental change is TaskService.java only');
    assert.ok((await git2(['show', `${c2}:${taskServicePath}`])).includes(GUARD));
    assert.ok((await git2(['show', `${c2}:${taskServicePath}`])).includes('task.setStatus("RESOLVED");'));
    assert.equal(await regressionStatus(scenario, dir2, c2), 0, 'regression still passes on C2');

    // Roles: SWE and reviewers received the operator requirement through the real prompt path.
    const invocations = (await scenario.providerInvocations()).filter((entry) => entry.issue === 'SAMPLE-123');
    assert.deepEqual(invocations.map((entry) => entry.role), ['swe', 'qa', 'reviewer', 'swe', 'qa', 'reviewer']);
    const manifest = (await h.get<{ files: Array<{ name: string }>; commit_sha: string }>(`/v1/jobs/${second.job_id}/artifacts`));
    const fileNames = manifest.files.map((file) => file.name);
    assert.ok(fileNames.includes('operator-notes.json') && fileNames.includes('parent.json'), fileNames.join());
    assert.equal(manifest.commit_sha, c2);
    const qaEvidence = JSON.parse(await readFile(join(h.runtime.config.storage.artifacts_dir, second.job_id, 'qa.json'), 'utf8')) as { status: string; evidence: string[] };
    assert.equal(qaEvidence.status, 'PASS');
    assert.ok(qaEvidence.evidence.some((line) => /Operator requirement received.*satisfied/.test(line)), 'QA saw and verified the operator requirement');
    const reviewEvidence = JSON.parse(await readFile(join(h.runtime.config.storage.artifacts_dir, second.job_id, 'review.json'), 'utf8')) as { status: string; findings: unknown[] };
    assert.deepEqual([reviewEvidence.status, reviewEvidence.findings.length], ['PASS', 0]);

    // Note text appears only in operator-notes.json (and private prompts), never in API surfaces or public artifacts.
    const surfaces = await Promise.all(['/v1/jobs', '/v1/queue', '/v1/events', '/v1/status', `/v1/jobs/${second.job_id}`, `/v1/jobs/${second.job_id}/artifacts`, `/v1/jobs/${second.job_id}/events`, `/v1/jobs/${first.job_id}`]
      .map(async (url) => (await app.inject({ method: 'GET', url, headers: auth })).body));
    for (const body of surfaces) assert.ok(!body.includes(NOTE_SECRET) && !body.includes('operator-null-guard'));
    const jobDirectory = join(h.runtime.config.storage.artifacts_dir, second.job_id);
    for (const name of await readdir(jobDirectory)) {
      if (name === '_private' || name.startsWith('.')) continue;
      const text = await readFile(join(jobDirectory, name), 'utf8').catch(() => '');
      assert.equal(text.includes(NOTE_SECRET), name === 'operator-notes.json', `${name} note exposure`);
    }
    const events = (await h.get<{ events: Array<{ type: string; job_id: string | null }> }>('/v1/events')).events;
    assert.ok(events.some((event) => event.type === 'revision_requested' && event.job_id === second.job_id));
    assert.deepEqual(await h.refs(), [`refs/heads/develop ${scenario.remote.baseSha}`], 'push disabled: remote only has develop');
    assert.equal((await h.get(`/v1/jobs/${second.job_id}`)).push_status, 'DISABLED');

    // 4c. Rejections.
    assert.equal((await h.revise(first.job_id)).statusCode, 409, 'the superseded C1 attempt cannot be revised again');
    await h.runtime.workflow.poll();
    const blocked = (await h.runtime.workflow.list(50)).filter((job) => job.state === 'BLOCKED');
    assert.ok(blocked.length >= 2, 'poll produced blocked tickets');
    for (const job of blocked) assert.equal((await h.revise(job.job_id)).statusCode, 409, `${job.issue_key} is not revisable`);
    assert.equal((await h.revise(second.job_id, NOTE, {})).statusCode, 401);
    assert.deepEqual(scenario.violations, []);
  } finally { await h.close(); }
});

test('with push enabled a revision fast-forwards the remote branch; a foreign remote commit is never overwritten', { timeout: 600_000 }, async () => {
  const h = await harness({ pushFeatureBranch: true });
  const { scenario } = h;
  const scratch = await mkdtemp(join(tmpdir(), 'autos-rev-foreign-'));
  try {
    const remoteBranch = async () => (await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'rev-parse', 'refs/heads/deep/SAMPLE-123']));
    const first = await h.waitTerminal((await h.submit('SAMPLE-123')).job_id);
    assert.equal(first.state, 'READY_FOR_HUMAN', JSON.stringify(first));
    assert.equal(first.push_status, 'PUSHED');
    assert.equal(await remoteBranch(), first.commit_sha, 'initial attempt pushed C1');

    const secondQueued = await h.revise(first.job_id);
    assert.equal(secondQueued.statusCode, 202, secondQueued.body);
    const second = await h.waitTerminal((secondQueued.json() as Job).job_id);
    assert.equal(second.state, 'READY_FOR_HUMAN', JSON.stringify(second));
    assert.equal(second.push_status, 'PUSHED');
    assert.equal(await remoteBranch(), second.commit_sha, 'revision fast-forwarded the remote to C2');
    assert.equal(await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'merge-base', first.commit_sha!, second.commit_sha!]), first.commit_sha, 'fast-forward: C1 is an ancestor of C2');

    // Someone else moves the remote branch to a foreign commit.
    const clone = join(scratch, 'clone');
    await scenario.remote.git(['clone', '-q', scenario.remote.remotePath, clone], scratch);
    await scenario.remote.git(['checkout', '-q', 'deep/SAMPLE-123'], clone);
    await writeFile(join(clone, 'FOREIGN.txt'), 'someone else was here\n');
    await scenario.remote.git(['add', 'FOREIGN.txt'], clone);
    await scenario.remote.git(['commit', '-q', '-m', 'Foreign commit'], clone);
    await scenario.remote.git(['push', '-q', 'origin', 'deep/SAMPLE-123'], clone);
    const foreign = await remoteBranch();
    assert.notEqual(foreign, second.commit_sha);

    const thirdQueued = await h.revise(second.job_id, `Second change request. [fixture:operator-null-guard] ${NOTE_SECRET}`);
    assert.equal(thirdQueued.statusCode, 202, thirdQueued.body);
    const third = await h.waitTerminal((thirdQueued.json() as Job).job_id);
    // Either outcome is acceptable by contract (push FAILED / BRANCH_COLLISION, or blocked at prepare); a force never is.
    console.log(`third revision outcome: state=${third.state} push_status=${third.push_status} blocked_code=${third.blocked_code}`);
    assert.equal(await remoteBranch(), foreign, 'remote still points at the foreign commit: no force, no overwrite');
    const ok = (third.state === 'READY_FOR_HUMAN' && third.push_status === 'FAILED') || (third.state === 'BLOCKED' && third.blocked_code === 'BRANCH_COLLISION');
    assert.ok(ok, JSON.stringify(third));
    assert.deepEqual(scenario.violations, []);
  } finally { await rm(scratch, { recursive: true, force: true }); await h.close(); }
});
