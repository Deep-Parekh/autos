import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, type IssueSnapshot, type JobEvent, type ProjectMapping, type ProviderResult, type RunnerPort, type WorkflowDependencies } from '@autos/contracts';
import { DEFAULT_LEASE_MS, FileArtifactStore, MAX_AUTO_RETRIES, PROMPT_BUDGET_BYTES, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const baseIssue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', comments: [], linked_issue_keys: [], components: ['core'], url: 'https://example.atlassian.net/browse/' + key } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Ctl {
  digest: number; now: number; keys: string[];
  getIssue: (key: string, call: number) => IssueSnapshot | Promise<IssueSnapshot>; issueCalls: number;
  precedents: () => Promise<never> | undefined;
  inspect: (call: number) => { paths?: string[]; diff?: string } | Promise<never> | undefined;
  inspectCalls: number;
  swe: (n: number, req: { prompt_path: string; signal?: AbortSignal | undefined }) => Promise<ProviderResult | undefined> | undefined; sweCalls: number;
  roleOutput: (role: string, n: number) => unknown; roleCalls: Record<string, number>;
  checks: (call: number) => Record<string, unknown>[] | undefined; checkCalls: number;
  health?: RunnerPort['health'];
  prompts: Array<{ role: string; provider: string; text: string }>;
  instruction: string; qaFails?: { code: string };
}
const newCtl = (): Ctl => ({
  digest: 1, now: Date.parse('2026-11-07T20:00:00.000Z'), keys: ['SAMPLE-1'], getIssue: (key) => baseIssue(key), issueCalls: 0, precedents: () => undefined,
  inspect: () => undefined, inspectCalls: 0, swe: () => undefined, sweCalls: 0, roleOutput: () => undefined, roleCalls: {}, checks: () => undefined, checkCalls: 0, prompts: [], instruction: '',
});

function deps(ctl: Ctl, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date(ctl.now) },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return [...ctl.keys]; },
      async listIssues() { return ctl.keys.map(baseIssue); },
      async getIssue(key: string) { return ctl.getIssue(key, ++ctl.issueCalls); },
      async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { const failure = ctl.precedents(); if (failure) await failure; return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}` } as never;
      },
      async inspectCandidate() {
        const call = ++ctl.inspectCalls; const custom = ctl.inspect(call); if (custom && 'then' in custom) await custom;
        const over = custom && !('then' in custom) ? custom : {};
        return { digest: sha(ctl.digest), paths: over.paths ?? ['src/Fix.java'], diff: over.diff ?? `+ fixed v${ctl.digest}` };
      },
      async commit(req) { return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return ctl.instruction ? [{ path: 'AGENTS.md', blob_sha: '1'.repeat(40), content: ctl.instruction }] : []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req, signal) {
        ctl.prompts.push({ role: req.role, provider: req.provider, text: await readFile(req.prompt_path, 'utf8') });
        const base = { provider: req.provider, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        const n = (ctl.roleCalls[req.role] = (ctl.roleCalls[req.role] ?? 0) + 1);
        if (req.role === 'swe') {
          ctl.sweCalls = n; const custom = await ctl.swe(n, { prompt_path: req.prompt_path, signal }); if (custom) return custom;
          ctl.digest++; return { ...base, result: 'Implemented.' } as ProviderResult;
        }
        if (req.role === 'qa' && ctl.qaFails) return { ...base, status: 'FAILED', exit_code: 1, error_code: ctl.qaFails.code } as unknown as ProviderResult;
        const custom = ctl.roleOutput(req.role, n); if (custom !== undefined) return { ...base, result: custom } as ProviderResult;
        const d = sha(ctl.digest);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        const call = ++ctl.checkCalls; const over = ctl.checks(call);
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: over ?? commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
      ...(ctl.health ? { health: ctl.health } : {}),
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-review-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
  config.agents.swe = { ...config.agents.swe, provider: 'claude', fallbacks: [] };
  config.agents.qa = { ...config.agents.qa, provider: 'codex', fallbacks: [] };
  config.agents.reviewer = { ...config.agents.reviewer, provider: 'cursor', model: 'auto', fallbacks: [] };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (ctl: Ctl, options: ConstructorParameters<typeof WorkflowService>[1] = {}) => {
  const store = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, service: new WorkflowService(deps(ctl, store, artifacts), options) };
};
const readText = (jobId: string, name: string) => readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8');
const readJson = async (jobId: string, name: string) => JSON.parse(await readText(jobId, name)) as Record<string, any>;
const runOne = async (ctl: Ctl, dry = false) => { const { store, service } = open(ctl); const job = await service.execute((await service.submit('SAMPLE-1', dry)).job_id); const events = await service.events({ job_id: job.job_id, limit: 500 }); return { store, service, job, events }; };
const waitFor = async (condition: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error('timeout waiting for condition'); await sleep(10); } };

describe('discover / drain (item 1)', () => {
  it('discover queues at most max_new_per_poll jobs in filter order and never executes', async () => {
    const ctl = newCtl(); ctl.keys = ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3', 'SAMPLE-4', 'SAMPLE-5']; config.jira.max_new_per_poll = 2;
    const { store, service } = open(ctl);
    assert.deepEqual(await service.discover(), { discovered: 5, queued: 2 });
    assert.deepEqual((await service.list(50)).map((j) => j.issue_key).sort(), ['SAMPLE-1', 'SAMPLE-2']);
    assert.equal(ctl.sweCalls, 0); assert.equal(ctl.checkCalls, 0);
    assert.deepEqual(await service.discover(), { discovered: 5, queued: 2 });
    assert.deepEqual((await service.list(50)).map((j) => j.issue_key).sort(), ['SAMPLE-1', 'SAMPLE-2', 'SAMPLE-3', 'SAMPLE-4']);
    const events = await service.events({ limit: 100 }); assert.ok(events.some((e) => e.type === 'poll_finished' && /per-poll limit 2/.test(e.message ?? '')));
    assert.equal(ctl.sweCalls, 0); store.close();
  });
  it('discover rejects on filter failure, and runs while a drain is in progress; poll() still does both', async () => {
    const ctl = newCtl(); ctl.keys = ['SAMPLE-1'];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    ctl.swe = async (n) => { if (n === 1) await gate; return undefined; };
    const { store, service } = open(ctl);
    const job = await service.submit('SAMPLE-1', false);
    const draining = service.drain(); await waitFor(() => ctl.sweCalls === 1);
    ctl.keys = ['SAMPLE-1', 'SAMPLE-2'];
    assert.deepEqual(await service.discover(), { discovered: 2, queued: 1 }); // intake is not blocked by the running job
    assert.equal((await service.get(job.job_id))!.state, 'IMPLEMENTING');
    release(); await draining;
    assert.equal((await service.get(job.job_id))!.state, 'READY_FOR_HUMAN');
    await service.poll(); assert.equal((await service.list(10)).find((j) => j.issue_key === 'SAMPLE-2')!.state, 'READY_FOR_HUMAN');
    const failing = deps(ctl, store, new FileArtifactStore(config.storage.artifacts_dir)); failing.atlassian.getSavedFilter = async () => { throw new AutosError('AUTH', 'no'); };
    await assert.rejects(new WorkflowService(failing).discover(), /no/);
    store.close();
  });
});

describe('runner health and infrastructure requeue (item 2)', () => {
  it('does not claim anything while the runner is unavailable, emits one sanitized event, then proceeds when healthy', async () => {
    const ctl = newCtl(); let status: 'available' | 'unavailable' | 'throw' = 'unavailable';
    ctl.health = async () => { if (status === 'throw') throw new Error('socket /var/run/x.sock refused'); return { status: 'ready', version: 1, docker: status }; };
    const { store, service } = open(ctl);
    const job = await service.submit('SAMPLE-1', false);
    await service.drain(); await service.drain();
    assert.equal((await service.get(job.job_id))!.state, 'QUEUED'); assert.equal(ctl.sweCalls, 0); assert.equal(ctl.checkCalls, 0);
    status = 'throw'; await service.drain(); assert.equal((await service.get(job.job_id))!.state, 'QUEUED');
    const down = (await service.events({ limit: 100 })).filter((e) => e.type === 'poll_failed'); assert.equal(down.length, 1); assert.equal(down[0]!.message, 'runner unavailable'); assert.equal(down[0]!.code, 'UNAVAILABLE');
    await assert.rejects(service.execute(job.job_id), /Runner unavailable/); assert.equal((await service.get(job.job_id))!.state, 'QUEUED');
    status = 'available'; await service.drain(); assert.equal((await service.get(job.job_id))!.state, 'READY_FOR_HUMAN'); store.close();
  });
  it('Atlassian UPSTREAM before the agent starts blocks the attempt and queues a backoff retry that drain skips until due', async () => {
    const ctl = newCtl(); ctl.getIssue = () => { throw new AutosError('UPSTREAM', 'Atlassian unavailable'); };
    const { store, service } = open(ctl);
    const first = await service.submit('SAMPLE-1', false); await service.drain();
    const blocked = (await service.get(first.job_id))!; assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.blocked_code, 'UPSTREAM'); assert.match(blocked.blocked_reason ?? '', /automatic retry 1\/5 scheduled/);
    const jobs = await service.list(10); assert.equal(jobs.length, 2); const retry = jobs.find((j) => j.job_id !== first.job_id)!; assert.equal(retry.state, 'QUEUED');
    assert.equal(store.notBefore(retry.job_id), new Date(ctl.now + 60_000).toISOString()); assert.equal(store.autoRetryCount(retry.job_id), 1);
    const queuedEvent = (await service.events({ job_id: retry.job_id, limit: 20 })).find((e) => e.type === 'job_queued')!; assert.match(queuedEvent.message ?? '', /Auto-retry 1\/5/);
    ctl.getIssue = (key) => baseIssue(key);
    await service.drain(); assert.equal((await service.get(retry.job_id))!.state, 'QUEUED', 'not due yet');
    ctl.now += 61_000; await service.drain(); assert.equal((await service.get(retry.job_id))!.state, 'READY_FOR_HUMAN'); store.close();
  });
  it('stops auto-retrying after 5 attempts in a chain (backoff 1,2,4,8,16 min) and stays BLOCKED', async () => {
    const ctl = newCtl(); ctl.getIssue = () => { throw new AutosError('TIMEOUT', 'Atlassian timed out'); };
    const { store, service } = open(ctl); await service.submit('SAMPLE-1', false); const delays: number[] = [];
    for (let i = 0; i < 8; i++) { await service.drain(); const queued = (await service.list(50)).find((j) => j.state === 'QUEUED'); if (queued) delays.push(Date.parse(store.notBefore(queued.job_id)!) - ctl.now); ctl.now += 20 * 60_000; }
    assert.deepEqual(delays, [1, 2, 4, 8, 16].map((m) => m * 60_000));
    const jobs = await service.list(50); assert.equal(jobs.length, MAX_AUTO_RETRIES + 1); assert.ok(jobs.every((j) => j.state === 'BLOCKED'));
    assert.ok(jobs.some((j) => /automatic retry limit reached/.test(j.blocked_reason ?? ''))); store.close();
  });
  it('failures after an agent session started keep blocking without a retry', async () => {
    const ctl = newCtl(); ctl.qaFails = { code: 'UPSTREAM' };
    const { job, service, store } = await runOne(ctl);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'UPSTREAM'); assert.doesNotMatch(job.blocked_reason ?? '', /automatic retry/);
    assert.equal((await service.list(10)).length, 1); store.close();
  });
  it('requeues a shutdown-cancelled attempt once, but never an operator cancel', async () => {
    const ctl = newCtl(); let wait = true;
    ctl.swe = async (_n, { signal }) => { if (!wait) return undefined; await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); signal?.addEventListener('abort', () => resolve(), { once: true }); }); return { provider: 'claude', role: 'swe', status: 'CANCELLED', exit_code: null, elapsed_ms: 1, transcript_path: '/dev/null', error_code: 'CANCELLED' } as unknown as ProviderResult; };
    const { store, service } = open(ctl);
    const first = await service.submit('SAMPLE-1', false); const abort = new AbortController();
    const running = service.execute(first.job_id, abort.signal); await waitFor(() => ctl.sweCalls === 1); abort.abort();
    assert.equal((await running).state, 'CANCELLED');
    wait = false; await service.drain();
    let jobs = await service.list(10); assert.equal(jobs.length, 2); assert.equal(jobs.find((j) => j.job_id !== first.job_id)!.state, 'READY_FOR_HUMAN');
    await service.drain(); assert.equal((await service.list(10)).length, 2, 'requeued only once');
    // operator cancel of another issue never requeues
    ctl.keys = ['SAMPLE-2']; wait = true; ctl.sweCalls = 0; ctl.roleCalls = {};
    const second = await service.submit('SAMPLE-2', false); const running2 = service.execute(second.job_id); await waitFor(() => ctl.sweCalls === 1);
    assert.equal((await service.cancel(second.job_id)).state, 'CANCELLED'); await running2.catch(() => undefined);
    wait = false; await service.drain(); jobs = (await service.list(20)).filter((j) => j.issue_key === 'SAMPLE-2'); assert.equal(jobs.length, 1); assert.equal(jobs[0]!.state, 'CANCELLED'); store.close();
  });
});

describe('precedent lookup (item 3)', () => {
  it('a failing lookup is non-fatal for full and dry runs', async () => {
    const ctl = newCtl(); ctl.precedents = () => Promise.reject(new AutosError('UPSTREAM', 'https://user:pw@evil.example/secret failed'));
    const full = await runOne(ctl); assert.equal(full.job.state, 'READY_FOR_HUMAN');
    const text = await readText(full.job.job_id, 'precedents.md'); assert.match(text, /Precedent lookup unavailable \(UPSTREAM\)/); assert.doesNotMatch(text, /evil|secret|pw/);
    const dry = await runOne(ctl, true).catch(() => null); // second submit for SAMPLE-1 in dry mode on the same store path
    assert.equal(dry?.job.state, 'PLANNED'); assert.match(await readText(dry!.job.job_id, 'precedents.md'), /unavailable \(UPSTREAM\)/);
    full.store.close(); dry?.store.close();
  });
});

describe('issue change detection (item 4)', () => {
  it('ignores updated_at-only changes but blocks when the content agents saw changed', async () => {
    const same = newCtl(); same.getIssue = (key, call) => ({ ...baseIssue(key), updated_at: call === 1 ? '2026-11-07T20:00:00.000Z' : '2026-11-07T21:00:00.000Z', comments: [{ id: '1', body: 'a late comment' }] });
    const a = await runOne(same); assert.equal(a.job.state, 'READY_FOR_HUMAN'); a.store.close();
    await rm(join(root, 'jobs.sqlite'), { force: true }); await rm(join(root, 'jobs.sqlite-wal'), { force: true }); await rm(join(root, 'jobs.sqlite-shm'), { force: true });
    const changed = newCtl(); changed.getIssue = (key, call) => ({ ...baseIssue(key), ...(call === 1 ? {} : { acceptance_criteria: ['works', 'and also this'] }) });
    const b = await runOne(changed); assert.equal(b.job.state, 'BLOCKED'); assert.equal(b.job.blocked_code, 'CONFLICT'); assert.equal(b.job.blocked_reason, 'Issue content changed during execution'); b.store.close();
  });
});

describe('path policy (item 5)', () => {
  it('states the repository path policy to SWE, QA and reviewer', async () => {
    const ctl = newCtl(); const { job, store } = await runOne(ctl); assert.equal(job.state, 'READY_FOR_HUMAN');
    const repo = config.bitbucket.allowed_repositories[0]!;
    for (const role of ['swe', 'qa', 'reviewer']) {
      const text = ctl.prompts.find((p) => p.role === role)!.text;
      assert.match(text, /Repository path policy/); assert.ok(text.includes(repo.allowed_paths[0]!), `${role} lists allowed_paths`);
      if (repo.prohibited_paths[0]) assert.ok(text.includes(repo.prohibited_paths[0]));
      assert.match(text, /immutable/); assert.match(text, /\.autos-handoff/);
    }
    assert.match(ctl.prompts.find((p) => p.role === 'qa')!.text, /every changed path is inside the allowed paths/);
    assert.match(ctl.prompts.find((p) => p.role === 'reviewer')!.text, /every changed path is inside the allowed paths/); store.close();
  });
  const violation = () => Object.assign(new AutosError('FORBIDDEN', 'Candidate path is outside the allowed path policy'), { paths: ['secrets/token.txt', 'AGENTS.md'] });
  it('turns FORBIDDEN from inspectCandidate into a repair round carrying the offending paths, then passes', async () => {
    const ctl = newCtl(); let forbidden = false;
    ctl.swe = (n) => { forbidden = n === 1; return undefined; };
    ctl.inspect = () => (forbidden ? Promise.reject(violation()) : undefined);
    const { job, store } = await runOne(ctl);
    assert.equal(job.state, 'READY_FOR_HUMAN'); assert.equal(job.repair_round, 1); assert.equal(ctl.sweCalls, 2);
    const repair = ctl.prompts.filter((p) => p.role === 'swe')[1]!.text; assert.match(repair, /these paths are outside policy: secrets\/token\.txt, AGENTS\.md; restore or remove them/);
    const rounds = await readJson(job.job_id, 'rounds.json'); assert.ok((rounds.rounds as any[]).some((r) => r.policy_violation?.code === 'FORBIDDEN')); store.close();
  });
  it('blocks FORBIDDEN once the repair limit is used up', async () => {
    const ctl = newCtl(); ctl.swe = () => undefined; ctl.inspect = (call) => (call > 1 ? Promise.reject(violation()) : undefined); // baseline inspect succeeds
    const { job, store } = await runOne(ctl);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'FORBIDDEN'); assert.equal(job.repair_round, 2); assert.equal(ctl.sweCalls, 3); assert.equal(ctl.roleCalls.qa ?? 0, 0); store.close();
  });
});

describe('empty SWE result (item 6)', () => {
  it('falls back to the next provider when the workspace is unchanged, without running checks on an empty candidate', async () => {
    const ctl = newCtl(); config.agents.swe = { ...config.agents.swe, fallbacks: [{ provider: 'codex' }] };
    ctl.inspect = () => ({ paths: ctl.digest === 1 ? [] : ['src/Fix.java'] });
    ctl.swe = (n) => (n === 1 ? Promise.resolve({ provider: 'claude', role: 'swe', status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: '/dev/null', result: 'did nothing' } as unknown as ProviderResult) : undefined);
    const { job, events, store } = await runOne(ctl);
    assert.equal(job.state, 'READY_FOR_HUMAN'); const fb = events.filter((e) => e.type === 'provider_fallback'); assert.equal(fb.length, 1); assert.equal(fb[0]!.code, 'INVALID_OUTPUT'); assert.equal(fb[0]!.provider, 'codex'); store.close();
  });
  it('blocks with SWE made no changes when the chain is exhausted; only the baseline checks ran', async () => {
    const ctl = newCtl(); ctl.inspect = () => ({ paths: [] }); ctl.swe = () => Promise.resolve({ provider: 'claude', role: 'swe', status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: '/dev/null', result: 'nothing' } as unknown as ProviderResult);
    const { job, store } = await runOne(ctl);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'INVALID_OUTPUT'); assert.equal(job.blocked_reason, 'SWE made no changes');
    assert.equal(ctl.checkCalls, 1); assert.equal(ctl.roleCalls.qa ?? 0, 0); assert.equal(ctl.roleCalls.reviewer ?? 0, 0); store.close();
  });
});

describe('evidence (item 7)', () => {
  it('writes baseline-checks.json before blocking and summarises failing checks with a redacted excerpt', async () => {
    const ctl = newCtl();
    ctl.checks = () => config.build_profiles[config.bitbucket.allowed_repositories[0]!.build_profile]!.checks.map((c, i) => ({ name: c.executable, command: [c.executable, ...c.args], status: i === 0 ? 'FAIL' : 'PASS', exit_code: i === 0 ? 1 : 0, timed_out: false, required: c.required, report_paths: [], ...(i === 0 ? { output_excerpt: 'compile error in Foo\napi_key=SUPERSECRET123 at /home/runner/work/app/Foo.java' } : {}) }));
    const { job, store } = await runOne(ctl);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'CHECK_FAILED');
    const baseline = await readJson(job.job_id, 'baseline-checks.json'); assert.equal(baseline.checks[0].status, 'FAIL');
    const summary = await readText(job.job_id, 'summary.md'); const firstName = baseline.checks[0].name as string;
    assert.ok(summary.includes(firstName)); assert.match(summary, /exit code 1/); assert.match(summary, /compile error in Foo/); assert.doesNotMatch(summary, /SUPERSECRET123|\/home\/runner/);
    store.close();
  });
  it('publishes changes.patch (the cumulative candidate diff) and lists it in the manifest', async () => {
    const ctl = newCtl(); ctl.inspect = () => ({ diff: 'diff --git a/src/Fix.java b/src/Fix.java\n@@ -1 +1 @@\n-old\n+new' });
    const { job, store } = await runOne(ctl); assert.equal(job.state, 'READY_FOR_HUMAN');
    const patch = await readText(job.job_id, 'changes.patch'); assert.match(patch, /^diff --git a\/src\/Fix\.java/); assert.match(patch, /\+new\n$/);
    const manifest = await readJson(job.job_id, 'manifest.json'); assert.ok((manifest.files as Array<{ name: string }>).some((f) => f.name === 'changes.patch')); store.close();
  });
});

describe('prompt budget (item 8)', () => {
  it('keeps every role prompt under the budget with explicit markers, preserving task, policy and file headers', async () => {
    const ctl = newCtl(); ctl.instruction = `ROOT-RULE-START\n${'rule line that goes on and on\n'.repeat(15_000)}`; // ~440 KB
    const hunk = (name: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n${'+changed line of code\n'.repeat(6_000)}`;
    ctl.inspect = () => ({ paths: ['src/A.java', 'src/B.java', 'src/C.java'], diff: ['src/A.java', 'src/B.java', 'src/C.java'].map(hunk).join('') });
    ctl.checks = () => config.build_profiles[config.bitbucket.allowed_repositories[0]!.build_profile]!.checks.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [], output_excerpt: 'x'.repeat(12_000) }));
    const { job, events, store } = await runOne(ctl); assert.equal(job.state, 'READY_FOR_HUMAN');
    for (const p of ctl.prompts) assert.ok(Buffer.byteLength(p.text) <= PROMPT_BUDGET_BYTES, `${p.role} prompt ${Buffer.byteLength(p.text)} bytes`);
    const qa = ctl.prompts.find((p) => p.role === 'qa')!.text;
    assert.match(qa, /truncated for prompt budget/); assert.match(qa, /Repository path policy/); assert.match(qa, /Task: Assess this candidate/); assert.match(qa, /Issue SAMPLE-1/);
    for (const f of ['src/A.java', 'src/B.java', 'src/C.java']) assert.ok(qa.includes(`diff --git a/${f} b/${f}`), `${f} header kept`);
    assert.ok(qa.includes('ROOT-RULE-START'));
    const notices = events.filter((e) => /Prompt truncated/.test(e.message ?? '')) as JobEvent[]; assert.ok(notices.length >= 1); assert.match(notices[0]!.message ?? '', /diff|instruction files|check output/);
    store.close();
  });
});

describe('role output parsing (item 9)', () => {
  it('accepts fenced JSON, JSON inside prose and a missing candidate_digest (filled server-side)', async () => {
    const ctl = newCtl();
    ctl.roleOutput = (role) => role === 'qa' ? '```json\n{"schema_version":1,"status":"PASS","evidence":["checked { braces } too"]}\n```' : `Here is my verdict: {"schema_version":1,"status":"PASS","findings":[]} Hope that helps.`;
    const { job, store } = await runOne(ctl); assert.equal(job.state, 'READY_FOR_HUMAN');
    const qa = await readJson(job.job_id, 'qa.json'); assert.match(qa.candidate_digest, /^[0-9a-f]{64}$/); assert.equal(qa.evidence[0], 'checked { braces } too');
    assert.equal((await readJson(job.job_id, 'review.json')).candidate_digest, qa.candidate_digest); store.close();
  });
  it('re-asks the same provider once with the validation error, and still rejects a different digest', async () => {
    const ctl = newCtl(); ctl.roleOutput = (role, n) => (role === 'qa' && n === 1 ? 'I could not decide' : undefined);
    const { job, store } = await runOne(ctl); assert.equal(job.state, 'READY_FOR_HUMAN'); assert.equal(ctl.roleCalls.qa, 2);
    const qaPrompts = ctl.prompts.filter((p) => p.role === 'qa'); assert.match(qaPrompts[1]!.text, /rejected by validation \(qa returned malformed evidence\)/); assert.doesNotMatch(qaPrompts[0]!.text, /rejected by validation/);
    store.close();
    await rm(join(root, 'jobs.sqlite'), { force: true });
    const bad = newCtl(); config.agents.qa = { ...config.agents.qa, fallbacks: [{ provider: 'claude' }] }; bad.roleOutput = (role, n) => (role === 'qa' && n <= 2 ? { schema_version: 1, candidate_digest: 'f'.repeat(64), status: 'PASS', evidence: ['x'] } : undefined);
    const second = await runOne(bad); assert.equal(second.job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(bad.prompts.filter((p) => p.role === 'qa').map((p) => p.provider), ['codex', 'codex', 'claude']); second.store.close();
  });
});

describe('leases (item 10)', () => {
  it('uses a 10 minute lease TTL by default', () => { assert.equal(DEFAULT_LEASE_MS, 600_000); });
  it('tolerates two failed heartbeats but declares the lease lost on a third', async () => {
    for (const failures of [2, 3]) {
      await rm(join(root, 'jobs.sqlite'), { force: true });
      const ctl = newCtl(); ctl.swe = async () => { await sleep(400); return undefined; };
      const { store, service } = open(ctl, { heartbeatMs: 30 }); const real = store.renew.bind(store); let calls = 0;
      store.renew = async (...args: Parameters<typeof real>) => { if (++calls <= failures) throw new Error('database is locked'); return real(...args); };
      const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
      if (failures === 2) assert.equal(job.state, 'READY_FOR_HUMAN'); else { assert.equal(job.state, 'BLOCKED'); assert.match(job.blocked_reason ?? '', /lease was lost/); }
      store.close();
    }
  });
});
