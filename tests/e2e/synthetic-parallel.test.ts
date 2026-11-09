// Concurrent tickets end to end: real workflow slots, real GitRunner, real CLI adapters over fake provider processes,
// controller HTTP, TEST-ONLY local fixture runner with deterministic delays so jobs overlap measurably.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { createController, createRuntime } from '@autos/controller';
import { createSyntheticScenario, parallelAtlassianScenario, regressionTestPath, taskServicePath } from '../fixtures/synthetic/index.js';

const token = 'synthetic-operator-token-0123456789';
const auth = { authorization: `Bearer ${token}` };
const FIXABLE = ['SAMPLE-201', 'SAMPLE-202', 'SAMPLE-203', 'SAMPLE-204'];
type Job = { job_id: string; issue_key: string; state: string; commit_sha?: string; base_sha?: string | null; feature_branch?: string; blocked_code?: string };
type Status = { activity: { active_jobs: Array<{ job_id: string; issue_key: string; state: string }>; slots: { max_parallel: number; in_use: number; max_concurrent_checks: number; checks_in_use: number } } };

async function harness(extra: Parameters<typeof createSyntheticScenario>[0]) {
  const scenario = await createSyntheticScenario({ atlassian: parallelAtlassianScenario(), roleDelayMs: 400, checkDelayMs: 300, ...extra });
  const runtime = await createRuntime(scenario.runtimeOptions);
  const app = await createController({ ...runtime, operatorToken: token });
  const get = async <T>(url: string): Promise<T> => (await app.inject({ method: 'GET', url, headers: auth })).json() as T;
  return { scenario, runtime, app, get, close: async () => { await app.close(); await runtime.close(); await scenario.cleanup(); } };
}

test('max_parallel=2, max_concurrent_checks=1 drains a filter concurrently with isolated workspaces and branches', { timeout: 600_000 }, async () => {
  const h = await harness({ maxParallel: 2, maxConcurrentChecks: 1 });
  const { scenario, runtime } = h;
  try {
    assert.equal(runtime.config.jobs.max_parallel, 2);
    let done = false; let maxInUse = 0; let sawTwo: Status | undefined; let maxChecksInUse = 0;
    const sampler = (async () => {
      while (!done) {
        const status = await h.get<Status>('/v1/status');
        const { slots, active_jobs } = status.activity;
        maxInUse = Math.max(maxInUse, slots.in_use); maxChecksInUse = Math.max(maxChecksInUse, slots.checks_in_use);
        if (slots.in_use === 2 && active_jobs.length === 2 && !sawTwo) sawTwo = status;
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
    await runtime.workflow.poll();
    done = true; await sampler;

    assert.ok(sawTwo, '/v1/status showed two jobs in flight');
    assert.equal(new Set(sawTwo.activity.active_jobs.map((job) => job.issue_key)).size, 2, 'distinct issue keys in active_jobs');
    assert.equal(sawTwo.activity.slots.max_parallel, 2);
    assert.equal(sawTwo.activity.slots.max_concurrent_checks, 1);
    assert.ok(maxInUse <= 2 && maxChecksInUse <= 1);
    // Two jobs in flight is proven by /v1/status above; whether their agent runs overlap in time depends on
    // scheduling (one may be waiting for the single check slot), so only the upper bound is an invariant.
    assert.ok(scenario.runner.peak.roles >= 1 && scenario.runner.peak.roles <= 2, `peak concurrent roles ${scenario.runner.peak.roles} must never exceed max_parallel`);
    assert.equal(scenario.runner.peak.checks, 1, 'checks are serialized by max_concurrent_checks');

    const jobs = (await runtime.workflow.list(50)).filter((job) => !job.dry_run);
    const byKey = new Map(jobs.map((job) => [job.issue_key, job]));
    assert.equal(jobs.length, 6);
    assert.equal(byKey.get('SAMPLE-125')?.state, 'BLOCKED');
    assert.equal(byKey.get('LEGACY-9')?.state, 'BLOCKED');
    const directories = new Set<string>(); const commits = new Set<string>();
    for (const key of FIXABLE) {
      const job = byKey.get(key)!;
      assert.equal(job.state, 'READY_FOR_HUMAN', `${key}: ${JSON.stringify(job)}`);
      assert.equal(job.feature_branch, `deep/${key}`);
      const workspace = scenario.workspaces.get(job.job_id)!;
      directories.add(workspace.directory); commits.add(job.commit_sha!);
      const git = (args: string[]) => scenario.remote.git(args, workspace.directory);
      assert.equal(await git(['rev-parse', 'HEAD']), job.commit_sha);
      assert.equal(await git(['rev-parse', 'HEAD^']), scenario.remote.baseSha, `${key} parent is the pinned develop SHA`);
      assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD']), `deep/${key}`);
      assert.deepEqual((await git(['diff-tree', '--no-commit-id', '--name-only', '-r', job.commit_sha!])).split('\n').sort(), [taskServicePath, regressionTestPath].sort());
    }
    assert.equal(directories.size, FIXABLE.length, 'no workspace is shared');
    assert.equal(commits.size, FIXABLE.length);
    assert.equal((await readdir(runtime.config.storage.workspaces_dir)).length, FIXABLE.length);
    // Every provider invocation ran in its own job's workspace.
    for (const entry of await scenario.providerInvocations()) {
      const job = byKey.get(entry.issue!)!;
      assert.equal(entry.cwd, scenario.workspaces.get(job.job_id)!.directory);
    }
    assert.ok(!(await scenario.providerInvocations()).some((entry) => entry.issue === 'SAMPLE-125' || entry.issue === 'LEGACY-9'));

    // Per-job event order stays valid even though jobs interleave.
    for (const job of jobs) {
      const { events } = await h.get<{ events: Array<{ event_id: number; type: string }> }>(`/v1/jobs/${job.job_id}/events?limit=500`);
      const types = events.map((event) => event.type);
      assert.ok(events.every((event, i) => i === 0 || event.event_id > events[i - 1]!.event_id));
      assert.equal(types.filter((type) => type === 'job_started').length, 1, job.issue_key);
      assert.equal(types.filter((type) => type === 'job_finished').length, 1, job.issue_key);
      assert.ok(types.indexOf('job_queued') < types.indexOf('job_started') && types.indexOf('job_started') < types.indexOf('job_finished'));
      assert.equal(types.at(-1), 'job_finished', `${job.issue_key} has no events after job_finished`);
    }
    assert.deepEqual(scenario.violations, []);
    assert.deepEqual(await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'for-each-ref', '--format=%(refname)']), 'refs/heads/develop', 'push disabled');
  } finally { await h.close(); }
});

test('cancelling one of two running jobs frees its slot for the next ticket and leaves the other job unaffected', { timeout: 600_000 }, async () => {
  const h = await harness({ maxParallel: 2, maxConcurrentChecks: 2, roleDelayMs: 700 });
  const { scenario, runtime, app } = h;
  try {
    const polling = runtime.workflow.poll();
    let running: Status['activity']['active_jobs'] = [];
    for (const deadline = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 40))) {
      running = (await h.get<Status>('/v1/status')).activity.active_jobs;
      // Only cancel fixable tickets that are past intake: a ticket about to be BLOCKED by policy/mapping would
      // legitimately finish BLOCKED before the cancel lands.
      const working = running.filter((job) => (FIXABLE as readonly string[]).includes(job.issue_key) && job.state !== 'INVESTIGATING');
      if (running.length === 2 && working.length === 2) break;
      assert.ok(Date.now() < deadline, 'two jobs never ran together');
    }
    const [victim, survivor] = running as [typeof running[number], typeof running[number]];
    const cancelled = await app.inject({ method: 'POST', url: `/v1/jobs/${victim.job_id}/cancel`, headers: auth });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    await polling;

    const jobs = (await runtime.workflow.list(50)).filter((job) => !job.dry_run);
    const byId = new Map(jobs.map((job) => [job.job_id, job]));
    assert.equal(byId.get(victim.job_id)?.state, 'CANCELLED');
    assert.equal(byId.get(survivor.job_id)?.state, 'READY_FOR_HUMAN');
    const others = FIXABLE.filter((key) => key !== victim.issue_key && key !== survivor.issue_key);
    for (const key of others) {
      const job = jobs.find((entry) => entry.issue_key === key)!;
      assert.equal(job.state, 'READY_FOR_HUMAN', `${key} used the freed slot: ${JSON.stringify(job)}`);
    }
    assert.ok(scenario.runner.peak.roles <= 2);
    assert.ok(scenario.runner.stopped.includes(victim.job_id), 'runner.stop was invoked for the cancelled job');
    assert.equal((await scenario.remote.git(['--git-dir', scenario.remote.remotePath, 'for-each-ref', '--format=%(refname)'])), 'refs/heads/develop');
  } finally { await h.close(); }
});
