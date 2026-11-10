import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, parseConfigYaml, type GitPrepareRequest, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let qaStatus: 'PASS' | 'FAIL' = 'PASS';
const pushes: Array<{ sha: string; wip: boolean }> = [];
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
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
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
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}`, ...(req.continue_from ? { start_sha: req.continue_from.parent_commit_sha } : {}) } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digestIndex), paths: ['src/Fix.java'], diff: `+ fixed v${script.digestIndex}`, ...(script.incremental ? { incremental: script.incremental } : {}) }; },
      async commit(req) { script.commitSeq++; return { commit_sha: String(script.commitSeq).repeat(40).slice(0, 40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha, _signal, options) { pushes.push({ sha: commitSha, wip: options?.wip === true }); return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        script.calls.push(`role:${req.role}`); script.prompts.push({ role: req.role, text: await readFile(req.prompt_path, 'utf8') });
        const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (req.role === 'swe') { script.digestIndex++; return { ...base, result: 'Implemented.' } as ProviderResult; }
        const d = sha(script.digestIndex);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: qaStatus, evidence: [qaStatus === 'PASS' ? 'ok' : 'missing the other creation paths'] } : script.review(d) } as ProviderResult;
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
  issueOverride = {}; qaStatus = 'PASS'; pushes.length = 0;
  root = await mkdtemp(join(tmpdir(), 'autos-continue-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 0;
  config.bitbucket.push_blocked_attempts = true;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (script: Script, file = 'jobs.sqlite') => {
  const store = new SqliteJobStore(join(root, file)); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, artifacts, service: new WorkflowService(deps(script, store, artifacts)) };
};
const readJson = async (jobId: string, name: string) => JSON.parse(await readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8')) as Record<string, any>;
const summary = async (jobId: string) => readFile(join(config.storage.artifacts_dir, jobId, 'summary.md'), 'utf8');

describe('blocked attempts keep their work; retries continue from it', () => {
  it('commits and pushes a QA-failed attempt as unreviewed work, then a retry continues from that commit', async () => {
    const script = newScript(); const { store, service } = open(script);
    qaStatus = 'FAIL';
    const blocked = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(blocked.state, 'BLOCKED');
    assert.ok(blocked.wip_commit_sha, 'the unreviewed work is committed');
    assert.equal(blocked.wip_push_status, 'PUSHED');
    assert.equal(blocked.commit_sha, undefined, 'never recorded as a reviewed commit');
    assert.deepEqual(pushes, [{ sha: blocked.wip_commit_sha, wip: true }], 'pushed through the blocked-attempt switch only');
    assert.match(await summary(blocked.job_id), /Unreviewed work preserved as commit [0-9a-f]{12} on deep\/SAMPLE-1 \(pushed\)/);
    assert.ok(store.policySnapshot().awaitingRetry.has(blocked.job_id), 'its workspace is kept for the retry');

    qaStatus = 'PASS'; script.prompts.length = 0;
    const retry = await service.retry(blocked.job_id);
    assert.equal(retry.continues_job_id, blocked.job_id);
    const done = await service.execute(retry.job_id);
    assert.equal(done.state, 'READY_FOR_HUMAN');
    assert.deepEqual(script.prepares.at(-1)!.continue_from, { parent_job_id: blocked.job_id, parent_directory: join(root, 'ws', `${blocked.job_id}-dir`), parent_commit_sha: blocked.wip_commit_sha, base_sha: BASE, development_branch: 'develop' });
    const swe = script.prompts.find((p) => p.role === 'swe')!.text;
    assert.match(swe, /Continue an earlier attempt of this ticket/); assert.match(swe, /That attempt was stopped: /);
    assert.equal((await readJson(done.job_id, 'continued.json')).continues_job_id, blocked.job_id);
    assert.equal(store.policySnapshot().awaitingRetry.size, 0, 'nothing waits for a retry once it succeeded');
  });

  it('a retry of a retry that blocked before any agent ran still continues the preserved work', async () => {
    const script = newScript(); const { service } = open(script);
    qaStatus = 'FAIL';
    const blocked = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    const second = await service.retry(blocked.job_id);
    script.mappings = []; // routing fails before any agent runs
    const failedEarly = await service.execute(second.job_id);
    assert.equal(failedEarly.state, 'BLOCKED'); assert.equal(failedEarly.wip_commit_sha, undefined);
    const third = await service.retry(failedEarly.job_id);
    assert.equal(third.continues_job_id, blocked.job_id);
  });

  it('is off by default: a blocked attempt is not committed and a retry starts fresh', async () => {
    config.bitbucket.push_blocked_attempts = false;
    const script = newScript(); const { service } = open(script);
    qaStatus = 'FAIL';
    const blocked = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.wip_commit_sha, undefined); assert.equal(script.commitSeq, 0); assert.equal(pushes.length, 0);
    assert.equal((await service.retry(blocked.job_id)).continues_job_id, undefined);
  });

  it('commits nothing when the attempt blocked before its agent ran', async () => {
    const script = newScript(); const { service } = open(script);
    script.mappings = [];
    const early = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(early.state, 'BLOCKED'); assert.equal(early.wip_commit_sha, undefined); assert.equal(script.commitSeq, 0);
    const retry = await service.retry(early.job_id);
    assert.equal(retry.continues_job_id, undefined, 'nothing to continue: starts fresh');
  });
});
