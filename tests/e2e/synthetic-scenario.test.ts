// First scenario: a synthetic end-to-end ticket run with REAL Autos modules (atlassian client, workflow, SQLite,
// git-runner, cli-adapters, controller HTTP) over FAKES (read-only Jira/Confluence HTTP, fake provider processes,
// disposable bare Git remote, test-only local runner). This is not provider certification and not isolation proof.
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createController, createRuntime } from '@autos/controller';
import { createSyntheticScenario, regressionTestPath, taskServicePath, type SyntheticScenario } from '../fixtures/synthetic/index.js';

const execFile = promisify(execFileCallback);
const token = 'synthetic-operator-token-0123456789';
const auth = { authorization: `Bearer ${token}` };
const terminal = new Set(['PLANNED', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED']);
type Job = { job_id: string; issue_key: string; state: string; dry_run: boolean; commit_sha?: string; base_sha?: string | null; feature_branch?: string; blocked_code?: string; repair_round: number; push_status?: string };

async function javaRegression(tree: string): Promise<number | null> {
  const classes = await mkdtemp(join(tmpdir(), 'autos-regression-classes-'));
  try {
    const files = (await readdir(join(tree, 'src'), { recursive: true })).filter((name) => name.endsWith('.java')).map((name) => join(tree, 'src', name));
    const compile = spawnSync('javac', ['--release', '17', '-d', classes, ...files], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    return spawnSync('java', ['-ea', '-cp', classes, 'example.tasks.CompleteTaskRegression'], { encoding: 'utf8' }).status;
  } finally { await rm(classes, { recursive: true, force: true }); }
}

async function exportRevision(scenario: SyntheticScenario, repo: string, revision: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const archive = join(target, '..', `${revision.slice(0, 12)}.tar`);
  await execFile('git', ['archive', '--format=tar', '-o', archive, revision], { cwd: repo, env: scenario.remote.gitEnv });
  await execFile('tar', ['-xf', archive, '-C', target]);
}

test('synthetic scenario: dry-run, one real fix, then a poll with a repaired ticket and blocked tickets', { timeout: 600_000 }, async () => {
  const scenario = await createSyntheticScenario();
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let app: Awaited<ReturnType<typeof createController>> | undefined;
  try {
    runtime = await createRuntime(scenario.runtimeOptions);
    app = await createController({ ...runtime, operatorToken: token });
    const { workflow, config } = runtime;
    const getJob = async (id: string): Promise<Job> => (await app!.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: auth })).json() as Job;
    const waitTerminal = async (id: string): Promise<Job> => {
      const deadline = Date.now() + 300_000;
      for (;;) { const job = await getJob(id); if (terminal.has(job.state)) return job; assert.ok(Date.now() < deadline, `job ${id} stuck in ${job.state}`); await new Promise((r) => setTimeout(r, 100)); }
    };
    const submit = async (issue_key: string, dry_run: boolean): Promise<Job> => {
      const response = await app!.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key, dry_run } });
      assert.equal(response.statusCode, 202, response.body);
      return response.json() as Job;
    };
    assert.equal((await app.inject({ method: 'GET', url: '/v1/jobs' })).statusCode, 401, 'operator endpoints require the bearer token');
    const remoteRefs = async () => (await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'for-each-ref', '--format=%(refname) %(objectname)'])).split('\n');

    // 1. Dry run: PLANNED, no provider process, no workspace, no branch.
    const dryQueued = await submit('SAMPLE-123', true);
    const dry = await waitTerminal(dryQueued.job_id);
    assert.equal(dry.state, 'PLANNED');
    assert.equal(dry.base_sha, scenario.remote.baseSha, 'dry run pins the develop SHA');
    assert.deepEqual(await scenario.providerInvocations(), []);
    assert.equal(scenario.runner.roleInvocations.length, 0);
    assert.equal(scenario.runner.checkRuns.length, 0);
    assert.equal(scenario.workspaces.size, 0);
    assert.deepEqual(await readdir(config.storage.workspaces_dir), []);
    assert.deepEqual(await remoteRefs(), [`refs/heads/develop ${scenario.remote.baseSha}`]);

    // 2. Real run of SAMPLE-123 through the HTTP API.
    const queued = await submit('SAMPLE-123', false);
    const ready = await waitTerminal(queued.job_id);
    assert.equal(ready.state, 'READY_FOR_HUMAN', JSON.stringify(ready));
    assert.equal(ready.feature_branch, 'deep/SAMPLE-123');
    assert.equal(ready.base_sha, scenario.remote.baseSha);
    assert.match(ready.commit_sha ?? '', /^[a-f0-9]{40}$/);
    assert.equal(ready.push_status, 'DISABLED');
    const workspace = scenario.workspaces.get(ready.job_id)!;
    const gitIn = (args: string[]) => scenario.remote.git(args, workspace.directory);
    assert.equal(await gitIn(['rev-parse', 'deep/SAMPLE-123']), ready.commit_sha);
    assert.equal(await gitIn(['rev-parse', `${ready.commit_sha}^`]), scenario.remote.baseSha, 'commit parent is the pinned develop SHA');
    assert.deepEqual((await gitIn(['diff-tree', '--no-commit-id', '--name-only', '-r', ready.commit_sha!])).split('\n').sort(), [taskServicePath, regressionTestPath].sort());
    const real123 = (await scenario.providerInvocations()).filter((entry) => entry.issue === 'SAMPLE-123');
    assert.deepEqual(real123.map((entry) => `${entry.role}:${entry.provider}`), ['swe:claude', 'qa:codex', 'reviewer:cursor']);
    assert.ok(real123.every((entry) => entry.cwd === workspace.directory));

    // Regression fails on the base and passes on the committed candidate.
    const scratch = await mkdtemp(join(tmpdir(), 'autos-e2e-trees-'));
    try {
      await exportRevision(scenario, workspace.directory, ready.base_sha!, join(scratch, 'base'));
      await exportRevision(scenario, workspace.directory, ready.commit_sha!, join(scratch, 'fixed'));
      await writeFile(join(scratch, 'base', regressionTestPath), await gitIn(['show', `${ready.commit_sha}:${regressionTestPath}`]));
      assert.notEqual(await javaRegression(join(scratch, 'base')), 0, 'regression must fail on the pinned base');
      assert.equal(await javaRegression(join(scratch, 'fixed')), 0, 'regression must pass on the commit');
    } finally { await rm(scratch, { recursive: true, force: true }); }

    // Artifacts: evidence present through the API; private provider files are not exposed.
    const artifactsResponse = await app.inject({ method: 'GET', url: `/v1/jobs/${ready.job_id}/artifacts`, headers: auth });
    assert.equal(artifactsResponse.statusCode, 200);
    const manifest = artifactsResponse.json() as { commit_sha: string; push_status: string; files: Array<{ name: string }> };
    const names = manifest.files.map((file) => file.name);
    for (const expected of ['issue.json', 'branch-map.json', 'baseline-checks.json', 'checks.json', 'qa.json', 'review.json', 'rounds.json', 'summary.md']) assert.ok(names.includes(expected), `manifest lists ${expected}`);
    assert.equal(manifest.commit_sha, ready.commit_sha);
    assert.ok(names.every((name) => !/private|prompt|transcript/i.test(name)));
    for (const body of [artifactsResponse.body, JSON.stringify(ready)]) assert.ok(!/transcript|_private|prompt\.md/.test(body));
    assert.ok((await readdir(join(config.storage.artifacts_dir, ready.job_id, '_private', 'swe'), { recursive: true })).some((name) => name.endsWith('transcript.jsonl')), 'private transcripts exist on disk but are not part of the API surface');

    // 3. Poll: the Story (blocked first in filter order) and the disabled-mapping ticket must not stop SAMPLE-124.
    await workflow.poll();
    const jobs = (await workflow.list(50)).filter((job) => !job.dry_run);
    const byIssue = new Map(jobs.map((job) => [job.issue_key, job]));
    assert.equal(jobs.length, 4, 'one real attempt per filter ticket; SAMPLE-123 was deduplicated');
    assert.equal(byIssue.get('SAMPLE-123')?.job_id, ready.job_id);
    assert.equal(byIssue.get('SAMPLE-125')?.state, 'BLOCKED');
    assert.equal(byIssue.get('SAMPLE-125')?.blocked_code, 'POLICY');
    assert.equal(byIssue.get('LEGACY-9')?.state, 'BLOCKED');
    assert.equal(byIssue.get('LEGACY-9')?.blocked_code, 'MAPPING');
    const repaired = byIssue.get('SAMPLE-124')!;
    assert.equal(repaired.state, 'READY_FOR_HUMAN', JSON.stringify(repaired));
    assert.equal(repaired.repair_round, 1);
    assert.ok(new Date(byIssue.get('SAMPLE-125')!.created_at) <= new Date(repaired.created_at));
    const sequence124 = (await scenario.providerInvocations()).filter((entry) => entry.issue === 'SAMPLE-124').map((entry) => entry.role + (entry.repair ? '+repair' : ''));
    assert.deepEqual(sequence124, ['swe', 'qa', 'reviewer', 'swe+repair', 'qa', 'reviewer']);
    const rounds = JSON.parse(await readFile(join(config.storage.artifacts_dir, repaired.job_id, 'rounds.json'), 'utf8')) as { rounds: Array<{ gate: { ready: boolean; reasons: string[] }; review: { status: string; findings: unknown[] } }> };
    assert.equal(rounds.rounds.length, 2);
    assert.deepEqual(rounds.rounds[0]!.gate.reasons, ['REVIEW_NOT_PASSED']);
    assert.equal(rounds.rounds[0]!.review.findings.length, 1);
    assert.equal(rounds.rounds[1]!.gate.ready, true);
    assert.equal(runtime.config.jobs.max_parallel, 1, 'default config is serial');
    assert.equal(scenario.runner.peak.roles, 1, 'roles never ran concurrently');
    assert.equal(scenario.runner.peak.checks, 1);
    assert.ok(!(await scenario.providerInvocations()).some((entry) => entry.issue === 'SAMPLE-125' || entry.issue === 'LEGACY-9'), 'blocked tickets never reached a provider');

    // A second poll creates no work and runs nothing new.
    const invocationCount = (await scenario.providerInvocations()).length;
    await workflow.poll();
    assert.equal((await workflow.list(50)).filter((job) => !job.dry_run).length, 4);
    assert.equal((await scenario.providerInvocations()).length, invocationCount);

    // 4. Read-only Atlassian and no push.
    assert.ok(scenario.fakeAtlassian.requests.length > 0);
    assert.ok(scenario.fakeAtlassian.requests.every((request) => request.method === 'GET'));
    assert.deepEqual(scenario.violations, []);
    const refs = await remoteRefs();
    assert.deepEqual(refs, [`refs/heads/develop ${scenario.remote.baseSha}`], 'push is disabled: the remote only has the seeded develop branch');
    assert.equal(config.bitbucket.push_feature_branch, false);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/jobs/${repaired.job_id}`, headers: auth })).json<Job>().push_status, 'DISABLED');
  } finally {
    await app?.close();
    await runtime?.close();
    await scenario.cleanup();
  }
});
