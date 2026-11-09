import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfigYaml, type Checks, type GitWorkspace, type InstalledToolchains, type IssueSnapshot, type ProjectMapping, type ProviderRequest, type ProviderResult, type ToolchainSelection, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let dbCount = 0;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const baseMapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z' } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');

interface Script {
  mapping: ProjectMapping; digest: number; calls: string[]; requests: Array<{ role: string; toolchain: ToolchainSelection | undefined; prompt: string }>;
  checkOptions: Array<unknown>; health: 'none' | 'noToolchains' | InstalledToolchains; checksToolchain: (t: ToolchainSelection | undefined) => Checks['toolchain'];
}
const newScript = (mapping: Partial<ProjectMapping> = {}): Script => ({
  mapping: { ...baseMapping, ...mapping }, digest: 1, calls: [], requests: [], checkOptions: [], health: 'none',
  checksToolchain: (t) => (t ? { jdk: t.jdk, tomcat: t.tomcat } : undefined),
});

function deps(script: Script, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  const runner: WorkflowDependencies['runner'] = {
    async runRole(req: ProviderRequest) {
      script.calls.push(`role:${req.role}`);
      script.requests.push({ role: req.role, toolchain: req.toolchain, prompt: readFileSync(req.prompt_path, 'utf8') });
      const base = { provider: req.provider, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
      if (req.role === 'swe') { script.digest++; return { ...base, result: 'Implemented.' } as ProviderResult; }
      const d = sha(script.digest);
      return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
    },
    async runChecks(_ws, d, commands, _signal, options) {
      script.calls.push('checks'); script.checkOptions.push(options);
      const toolchain = script.checksToolchain(options?.toolchain);
      return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })), ...(toolchain ? { toolchain } : {}) } as never;
    },
    async stop() { /* nothing running */ },
  };
  if (script.health !== 'none') {
    runner.health = async () => {
      const base = { docker: 'available' as const };
      return (script.health === 'noToolchains' ? base : { ...base, toolchains: script.health }) as never;
    };
  }
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return ['SAMPLE-1']; },
      async listIssues() { return [issue('SAMPLE-1')]; },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return [script.mapping]; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { script.calls.push('resolveBase'); return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        script.calls.push('prepare');
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}` } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digest), paths: ['src/Fix.java'], diff: `+ fixed v${script.digest}` }; },
      async commit(req) { return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-toolchain-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 1;
  for (const profile of Object.values(config.build_profiles)) { delete profile.jdk; delete profile.tomcat; }
  dbCount = 0;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const profileOf = () => config.build_profiles[config.bitbucket.allowed_repositories[0]!.build_profile]!;
const readJson = async (jobId: string, name: string) => JSON.parse(await readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8')) as Record<string, any>;
const run = async (script: Script, dryRun = false) => {
  const store = new SqliteJobStore(join(root, `jobs-${dbCount++}.sqlite`)); const service = new WorkflowService(deps(script, store, new FileArtifactStore(config.storage.artifacts_dir)));
  const job = await service.execute((await service.submit('SAMPLE-1', dryRun)).job_id); store.close(); return job;
};

describe('per-project toolchains', () => {
  it('branch-map values win over the build profile and are recorded', async () => {
    profileOf().jdk = '17'; profileOf().tomcat = '10.1.30';
    const s = newScript({ jdk: '25', tomcat: '11.0.24' });
    const job = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(await readJson(job.job_id, 'toolchain.json'), { schema_version: 1, jdk: '25', tomcat: '11.0.24', source: { jdk: 'branch_map', tomcat: 'branch_map' } });
    const map = await readJson(job.job_id, 'branch-map.json'); assert.equal(map.jdk, '25'); assert.equal(map.tomcat, '11.0.24');
  });

  it('each field falls back to the build profile independently', async () => {
    profileOf().jdk = '21'; profileOf().tomcat = '10.1.30';
    const s = newScript({ jdk: '25', tomcat: null });
    const job = await run(s);
    assert.deepEqual(await readJson(job.job_id, 'toolchain.json'), { schema_version: 1, jdk: '25', tomcat: '10.1.30', source: { jdk: 'branch_map', tomcat: 'build_profile' } });
    assert.ok(s.requests.every((r) => r.toolchain?.jdk === '25' && r.toolchain.tomcat === '10.1.30'));
  });

  it('a Tomcat without a JDK blocks with MAPPING', async () => {
    const s = newScript({ tomcat: '11.0.24' });
    const job = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'MAPPING');
    assert.deepEqual(s.calls, []);
  });

  it('a runner missing the JDK blocks MAPPING before any clone, role or checks', async () => {
    const s = newScript({ jdk: '25', tomcat: '11.0.24' }); s.health = { jdk: ['21'], tomcat: ['11.0.24'] };
    const job = await run(s);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'MAPPING');
    assert.match(job.blocked_reason ?? '', /Required toolchain is not installed on the runner: JDK 25 \(install it with scripts\/install-toolchains\.ts\)/);
    assert.deepEqual(s.calls, []);
  });

  it('a dry run reveals a missing toolchain', async () => {
    const s = newScript({ jdk: '21', tomcat: '11.0.24' }); s.health = { jdk: ['21'], tomcat: [] };
    const job = await run(s, true);
    assert.equal(job.state, 'BLOCKED'); assert.equal(job.blocked_code, 'MAPPING');
    assert.match(job.blocked_reason ?? '', /JDK 25|Tomcat 11\.0\.24/);
    assert.deepEqual(s.calls, []);
  });

  it('health without a toolchains report does not block', async () => {
    const s = newScript({ jdk: '25' }); s.health = 'noToolchains';
    const job = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
  });

  it('every role request and checks call carries the toolchain; prompts include the Runtime section', async () => {
    const s = newScript({ jdk: '25', tomcat: '11.0.24' }); s.health = { jdk: ['25'], tomcat: ['11.0.24'] };
    const job = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(new Set(s.requests.map((r) => r.role)), new Set(['swe', 'qa', 'reviewer']));
    for (const r of s.requests) {
      assert.deepEqual(r.toolchain, { jdk: '25', tomcat: '11.0.24' });
      assert.match(r.prompt, /Runtime:/); assert.match(r.prompt, /JDK 25 is at \$JAVA_HOME/); assert.match(r.prompt, /Tomcat 11\.0\.24 is at \$CATALINA_HOME with a writable \$CATALINA_BASE/);
      assert.match(r.prompt, /\/scratch/);
    }
    assert.ok(s.checkOptions.length >= 3);
    for (const o of s.checkOptions) assert.deepEqual(o, { toolchain: { jdk: '25', tomcat: '11.0.24' } });
  });

  it('JDK-only selection omits the Tomcat line', async () => {
    const s = newScript({ jdk: '21' });
    await run(s);
    assert.ok(s.requests.length > 0 && s.requests.every((r) => !r.prompt.includes('CATALINA')));
    assert.ok(s.requests.every((r) => r.toolchain?.tomcat === null));
  });

  it('checks without the matching toolchain block finalization', async () => {
    for (const bad of [undefined, { jdk: '21', tomcat: '11.0.24' }, { jdk: '25', tomcat: null }] as const) {
      const s = newScript({ jdk: '25', tomcat: '11.0.24' }); s.checksToolchain = () => bad;
      const job = await run(s);
      assert.equal(job.state, 'BLOCKED', JSON.stringify(bad)); assert.notEqual(job.state, 'READY_FOR_HUMAN');
      assert.ok(job.blocked_code === 'INVALID_OUTPUT');
    }
  });

  it('a null selection keeps existing behaviour', async () => {
    const s = newScript();
    const job = await run(s);
    assert.equal(job.state, 'READY_FOR_HUMAN');
    assert.deepEqual(await readJson(job.job_id, 'toolchain.json'), { schema_version: 1, jdk: null, tomcat: null, source: { jdk: null, tomcat: null } });
    assert.ok(s.requests.every((r) => r.toolchain === undefined && !r.prompt.includes('Runtime:')));
    assert.ok(s.checkOptions.every((o) => o === undefined));
  });
});
