import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerRunner } from '@autos/runner';
import type { ProviderRequest } from '@autos/contracts';
import { checkScript, fixtureJavaDirectory } from '../fixtures/synthetic/index.js';

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0;
}

test('real Docker roles enforce source, git metadata, credential and socket boundaries', async (t) => {
  if (!dockerAvailable()) { t.skip('Docker daemon is unavailable; command-plan tests cover only fake execution'); return; }
  const image = process.env.AUTOS_TEST_WORKER_IMAGE ?? 'autos-test-worker:local';
  const inspect = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 3000 });
  assert.equal(inspect.status, 0, `Build the test image first: docker build -f docker/worker/Dockerfile -t autos-worker:local . && docker build -f docker/test-worker/Dockerfile -t ${image} .`);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-docker-boundary-')));
  const workspaceRoot = join(root, 'workspaces');
  const workspace = join(workspaceRoot, 'job');
  const outputRoot = join(root, 'artifacts');
  const authRoot = join(root, 'auth');
  const gitConfig = join(workspace, '.git', 'config');
  const javaFile = join(workspace, 'src', 'App.java');
  const jobId = '708a488c-93ce-4dfb-b15c-f0ea46ea7010';
  const runner = new DockerRunner({
    workerImage: image, checksImage: 'autos-checks:local', workspaceRoot, promptRoot: outputRoot, outputRoot, authRoot,
    uid: process.getuid?.() ?? 10001, gid: process.getgid?.() ?? 10001,
  });
  try {
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(authRoot, { recursive: true });
    await writeFile(gitConfig, '[remote "origin"]\n\turl = https://bitbucket.org/example/repo.git\n');
    await writeFile(javaFile, 'class App { int answer() { return 0; } }\n');
    const runRole = async (role: ProviderRequest['role'], invocationId: string) => {
      const invocation = join(outputRoot, jobId, '_private', role, invocationId);
      const prompt = join(invocation, 'input', 'prompt.md');
      await mkdir(join(invocation, 'input'), { recursive: true });
      await mkdir(join(invocation, 'output'), { recursive: true });
      await writeFile(prompt, `ROLE=${role}\nPerform the synthetic boundary attempt.`);
      return await runner.runRole({
        job_id: jobId, issue_key: 'AUTO-17', provider: 'claude', role, cwd: workspace, prompt_path: prompt,
        transcript_path: join(invocation, 'output', 'transcript.jsonl'), timeout_ms: 30_000,
        source_access: role === 'swe' ? 'write' : 'read', auth_profile: 'fake',
      });
    };
    const swe = await runRole('swe', 'f1973851-3fa0-4ee2-8bfe-a8eb1d2af612');
    assert.equal(swe.status, 'SUCCEEDED', JSON.stringify(swe));
    const sweEvidence = JSON.parse(String(swe.result)) as { sourceWrite: string; gitWrite: string; dockerSocket: boolean; credentialEnvironmentNames: string[] };
    assert.equal(sweEvidence.sourceWrite, 'allowed');
    assert.equal(sweEvidence.gitWrite, 'denied');
    assert.equal(sweEvidence.dockerSocket, false);
    assert.deepEqual(sweEvidence.credentialEnvironmentNames, []);
    const expectedSource = await readFile(javaFile, 'utf8');
    assert.match(expectedSource, /42/);
    const expectedGit = await readFile(gitConfig, 'utf8');
    for (const role of ['qa', 'reviewer'] as const) {
      const result = await runRole(role, role === 'qa' ? 'f1973851-3fa0-4ee2-8bfe-a8eb1d2af613' : 'f1973851-3fa0-4ee2-8bfe-a8eb1d2af614');
      assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
      const evidence = JSON.parse(String(result.result)) as { sourceWrite: string; dockerSocket: boolean; credentialEnvironmentNames: string[] };
      assert.equal(evidence.sourceWrite, 'denied');
      assert.equal(evidence.dockerSocket, false);
      assert.deepEqual(evidence.credentialEnvironmentNames, []);
      assert.equal(await readFile(javaFile, 'utf8'), expectedSource);
      assert.equal(await readFile(gitConfig, 'utf8'), expectedGit);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Docker checks run the Java fixture regression with no network, read-only source and a scratch copy', async (t) => {
  if (!dockerAvailable()) { t.skip('Docker daemon is unavailable; command-plan tests cover only fake execution'); return; }
  const inspect = spawnSync('docker', ['image', 'inspect', 'autos-checks:local'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(inspect.status, 0, 'Build the checks image first: docker build -f docker/runner/Dockerfile -t autos-checks:local .');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-docker-checks-')));
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'artifacts');
  const workspace = join(workspaceRoot, 'job');
  const jobId = '708a488c-93ce-4dfb-b15c-f0ea46ea7011';
  const runner = new DockerRunner({ workerImage: 'autos-worker:local', checksImage: 'autos-checks:local', workspaceRoot, promptRoot: outputRoot, outputRoot, uid: process.getuid?.() ?? 10001, gid: process.getgid?.() ?? 10001 });
  const gitWorkspace = { job_id: jobId, issue_key: 'AUTO-17', repository_id: 'example/sample-app', base_sha: 'a'.repeat(40), development_branch: 'develop', feature_branch: 'deep/AUTO-17', directory: workspace } as unknown as Parameters<DockerRunner['runChecks']>[0];
  const commands = [{ executable: 'node', args: ['scripts/check.mjs'], timeout_ms: 120_000, required: true }];
  try {
    await mkdir(outputRoot, { recursive: true });
    await cp(fixtureJavaDirectory, workspace, { recursive: true });
    await mkdir(join(workspace, 'scripts'), { recursive: true });
    await writeFile(join(workspace, 'scripts/check.mjs'), checkScript);
    await writeFile(join(workspace, 'src/test/java/example/tasks/FixtureBaseline.java'), 'package example.tasks; public class FixtureBaseline { public static void main(String[] args) { if (!"success".equals(new CompleteTaskAction(new TaskService()).execute(new Task("SAMPLE-123")))) throw new AssertionError("baseline"); } }\n');
    // The seeded defect: the included regression must FAIL inside the container.
    const buggy = await runner.runChecks(gitWorkspace, 'b'.repeat(64), commands);
    assert.equal(buggy.checks[0]?.status, 'FAIL', JSON.stringify(buggy));
    // Apply the one-line fix: the same command now PASSes.
    const service = join(workspace, 'src/main/java/example/tasks/TaskService.java');
    await writeFile(service, (await readFile(service, 'utf8')).replace('        return task;', '        task.setStatus("RESOLVED");\n        return task;'));
    const fixed = await runner.runChecks(gitWorkspace, 'c'.repeat(64), commands);
    assert.equal(fixed.checks[0]?.status, 'PASS', JSON.stringify(fixed));
    assert.equal(fixed.checks[0]?.exit_code, 0);
    // Source stayed untouched by the check (scratch copy only), and scratch directories are cleaned up.
    assert.ok(!(await readdir(workspace)).includes('target') && !(await readdir(workspace, { recursive: true })).some((name) => name.endsWith('.class')));
    assert.deepEqual(await readdir(join(outputRoot, '.checks')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
