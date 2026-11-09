import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  parseConfigYaml, type AtlassianReadPort, type CheckCommand, type Checks, type GitWorkspace,
  type ProjectMapping, type ProviderRequest, type ProviderResult, type RunnerPort,
} from '@autos/contracts';
import { GitRunner } from '@autos/git-runner';
import { createController, createRuntime } from '@autos/controller';

const execFile = promisify(execFileCallback);
const fixtureDirectory = resolve('tests/fixtures/java');
const epoch = '2026-11-08T06:00:00.000Z';

test('runtime processes a dry-run then a real Java fixture and preserves API history after reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-runtime-')));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let app: Awaited<ReturnType<typeof createController>> | undefined;
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Autos Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Autos Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const gitCommand = async (args: string[], cwd = root) => (await execFile('git', args, { cwd, env })).stdout.trim();
  try {
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    await cp(fixtureDirectory, seed, { recursive: true });
    await rm(join(seed, 'src/test/java/example/tasks/CompleteTaskRegression.java'));
    await mkdir(join(seed, 'scripts'), { recursive: true });
    await writeFile(join(seed, 'src/test/java/example/tasks/FixtureBaseline.java'), 'package example.tasks; public class FixtureBaseline { public static void main(String[] args) { if (!"success".equals(new CompleteTaskAction(new TaskService()).execute(new Task("SAMPLE-123")))) throw new AssertionError("baseline action failed"); } }\n');
    await writeFile(join(seed, 'AGENTS.md'), 'Preserve the Action to Service boundary. Add a regression test for the completion status.\n');
    await writeFile(join(seed, 'scripts/check.mjs'), `import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { spawnSync } from 'node:child_process';
const files = []; function walk(p) { for (const item of readdirSync(p, {withFileTypes:true})) { const path = join(p,item.name); if(item.isDirectory()) walk(path); else if(path.endsWith('.java')) files.push(path); } }
walk('src'); const classes=mkdtempSync(join(tmpdir(),'autos-java-classes-')); let status=0;
try { const compile=spawnSync('javac',['--release','17','-d',classes,...files],{stdio:'pipe'}); if(compile.status!==0) status=1;
else { for(const name of ['FixtureBaseline', ...(files.some(p=>p.endsWith('CompleteTaskRegression.java'))?['CompleteTaskRegression']:[])]) { const run=spawnSync('java',['-ea','-cp',classes,'example.tasks.'+name],{stdio:'pipe'}); if(run.status!==0) status=1; } }
} finally { rmSync(classes,{recursive:true,force:true}); } process.exit(status);
`);
    await gitCommand(['init', '-b', 'develop', seed]);
    await gitCommand(['add', '.'], seed);
    await gitCommand(['commit', '-m', 'Seed passing baseline and unfixed completion status'], seed);
    const baseSha = await gitCommand(['rev-parse', 'HEAD'], seed);
    await gitCommand(['init', '--bare', remote]);
    await gitCommand(['remote', 'add', 'origin', remote], seed);
    await gitCommand(['push', 'origin', 'develop'], seed);

    const config = parseConfigYaml(await readFile('config/config.example.yaml', 'utf8'));
    config.bitbucket.allowed_repositories[0]!.allowed_paths = ['src/**', 'scripts/**', 'AGENTS.md', 'pom.xml'];
    config.build_profiles['java-example']!.checks = [{ executable: process.execPath, args: ['scripts/check.mjs'], timeout_ms: 30_000, required: true }];
    const configPath = join(root, 'config.yaml');
    await writeFile(configPath, JSON.stringify(config));
    const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 1, fetched_at: epoch } };
    const issue = { key: 'SAMPLE-123', project_key: 'SAMPLE', summary: 'Persist resolved completion status', description: 'Completing a task reports success but keeps OPEN. Persist RESOLVED without changing the action result.', acceptance_criteria: ['Action returns success and completed task is RESOLVED.'], issue_type: 'Bug', status: 'Open', updated_at: epoch, fetched_at: epoch, comments: [], linked_issue_keys: [], components: ['tasks'], url: 'https://example.atlassian.net/browse/SAMPLE-123' };
    const atlassian: AtlassianReadPort = {
      getSavedFilter: async () => ({ id: '12345', name: 'Synthetic', jql: 'key = SAMPLE-123' }),
      listIssueKeys: async () => [issue.key], listIssues: async () => [issue], getIssue: async () => ({ ...issue }), getBranchMap: async () => [mapping],
    };
    const roles: ProviderRequest[] = [];
    const workspaces = new Map<string, GitWorkspace>();
    const actualGit = new GitRunner({ allowedRepositories: config.bitbucket.allowed_repositories, testOnlyRemoteOverrides: [{ repository: 'example/sample-app', path: remote }] });
    const git = {
      resolveBase: actualGit.resolveBase.bind(actualGit),
      prepare: async (...args: Parameters<GitRunner['prepare']>) => { const workspace = await actualGit.prepare(...args); workspaces.set(workspace.job_id, workspace); return workspace; },
      inspectCandidate: actualGit.inspectCandidate.bind(actualGit), commit: actualGit.commit.bind(actualGit), push: actualGit.push.bind(actualGit),
      readInstructionFiles: actualGit.readInstructionFiles.bind(actualGit), takeHandoff: actualGit.takeHandoff.bind(actualGit),
    };
    // This explicitly injected test runner runs only our trusted fixture locally.
    // Container role permissions are tested separately; this is no host fallback in product config.
    const runner: RunnerPort = {
      runRole: async (request: ProviderRequest): Promise<ProviderResult> => {
        roles.push(request);
        const workspace = workspaces.get(request.job_id)!;
        let result: unknown;
        if (request.role === 'swe') {
          const source = join(request.cwd, 'src/main/java/example/tasks/TaskService.java');
          const buggy = await readFile(source, 'utf8');
          await writeFile(source, buggy.replace('        return task;', '        task.setStatus("RESOLVED");\n        return task;'));
          await cp(join(fixtureDirectory, 'src/test/java/example/tasks/CompleteTaskRegression.java'), join(request.cwd, 'src/test/java/example/tasks/CompleteTaskRegression.java'));
          result = 'The service now persists RESOLVED; the new regression preserves the action result.';
        } else {
          assert.equal(request.source_access, 'read');
          const candidate = await actualGit.inspectCandidate(workspace);
          assert.ok((await readFile(request.prompt_path, 'utf8')).includes(candidate.digest), 'role prompt must identify its expected evidence digest');
          result = request.role === 'qa' ? { schema_version: 1, candidate_digest: candidate.digest, status: 'PASS', evidence: ['Trusted fixture javac and regression commands exited zero.'] }
            : { schema_version: 1, candidate_digest: candidate.digest, status: 'PASS', findings: [] };
        }
        return { provider: request.provider, role: request.role, status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: request.transcript_path, result };
      },
      runChecks: async (workspace: GitWorkspace, candidateDigest: string, commands: CheckCommand[], signal?: AbortSignal): Promise<Checks> => {
        const scratch = await mkdtemp(join(root, 'checks-'));
        const checks: Checks['checks'] = [];
        try {
          await cp(workspace.directory, scratch, { recursive: true, filter: (path) => !path.includes('/.git') });
          for (const command of commands) {
            let exitCode = 0;
            try { await execFile(command.executable, command.args, { cwd: scratch, env: { PATH: env.PATH, HOME: root }, timeout: command.timeout_ms, ...(signal ? { signal } : {}) }); }
            catch { exitCode = 1; }
            checks.push({ name: 'Java fixture', command: [command.executable, ...command.args], status: exitCode === 0 ? 'PASS' : 'FAIL', exit_code: exitCode, timed_out: false, required: command.required, report_paths: [] });
          }
          return { schema_version: 1, candidate_digest: candidateDigest, recorded_at: new Date().toISOString(), checks };
        } finally { await rm(scratch, { recursive: true, force: true }); }
      },
      stop: async () => undefined,
    };
    const options = { cwd: root, configPath, env: {}, atlassian, precedents: { findPrecedents: async () => ({ outcome: 'NO_MATCH' as const, items: [] }) }, git, runner };
    runtime = await createRuntime(options);
    const dryJob = await runtime.workflow.submit(issue.key, true);
    assert.equal((await runtime.workflow.execute(dryJob.job_id)).state, 'PLANNED');
    assert.equal(roles.length, 0);
    const job = await runtime.workflow.submit(issue.key, false);
    const finished = await runtime.workflow.execute(job.job_id);
    assert.equal(finished.state, 'READY_FOR_HUMAN', finished.blocked_reason);
    assert.match(finished.commit_sha ?? '', /^[a-f0-9]{40}$/);
    assert.deepEqual(roles.map((request) => request.role), ['swe', 'qa', 'reviewer']);
    assert.equal(new Set(roles.map((request) => request.transcript_path)).size, 3);
    const workspace = workspaces.get(job.job_id)!;
    assert.equal(await gitCommand(['rev-parse', 'HEAD^'], workspace.directory), baseSha);
    assert.deepEqual((await gitCommand(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], workspace.directory)).split('\n'), ['src/main/java/example/tasks/TaskService.java', 'src/test/java/example/tasks/CompleteTaskRegression.java']);
    const manifest = await runtime.artifacts.manifest(job.job_id);
    assert.equal(manifest.commit_sha, finished.commit_sha);
    assert.ok(manifest.files.some((file) => file.name === 'checks.json'));
    assert.ok(manifest.files.every((file) => !/private|prompt|transcript|restricted/.test(file.name)));
    await runtime.close(); runtime = undefined;

    runtime = await createRuntime(options);
    assert.equal((await runtime.workflow.get(job.job_id))?.commit_sha, finished.commit_sha);
    await assert.rejects(runtime.workflow.submit(issue.key, false), { code: 'CONFLICT' });
    app = await createController({ ...runtime, operatorToken: 'fixture-operator-token-123456789' });
    const response = await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}`, headers: { authorization: 'Bearer fixture-operator-token-123456789' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().commit_sha, finished.commit_sha);
    const denied = await app.inject({ method: 'GET', url: `/v1/jobs/${job.job_id}` });
    assert.equal(denied.statusCode, 401);
    await app.close(); app = undefined;
    await runtime.close(); runtime = undefined;
  } finally {
    await app?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
