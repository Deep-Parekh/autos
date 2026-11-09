import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerRunner } from '@autos/runner';
import type { GitWorkspace } from '@autos/contracts';

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0;
}

test('real Docker checks see a mounted toolchain read-only with JAVA_HOME and PATH set', async (t) => {
  if (!dockerAvailable()) { t.skip('Docker daemon is unavailable; command-plan tests cover only fake execution'); return; }
  const inspect = spawnSync('docker', ['image', 'inspect', 'autos-checks:local'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(inspect.status, 0, 'Build the checks image first: docker build -f docker/runner/Dockerfile -t autos-checks:local .');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-docker-toolchain-')));
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'artifacts');
  const toolchainRoot = join(root, 'toolchains');
  const workspace = join(workspaceRoot, 'job');
  const jdk = join(toolchainRoot, 'jdk', '25');
  try {
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(outputRoot, { recursive: true }), mkdir(join(jdk, 'bin'), { recursive: true })]);
    await writeFile(join(jdk, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(jdk, 'release'), 'JAVA_VERSION="25.0.1"\nOS_NAME="Linux"\n');
    const runner = new DockerRunner({ workerImage: 'autos-worker:local', checksImage: 'autos-checks:local', workspaceRoot, promptRoot: outputRoot, outputRoot, toolchainRoot, uid: process.getuid?.() ?? 10001, gid: process.getgid?.() ?? 10001 });
    const gitWorkspace = { job_id: '708a488c-93ce-4dfb-b15c-f0ea46ea7011', issue_key: 'AUTO-17', repository_id: 'example/sample-app', base_sha: 'a'.repeat(40), development_branch: 'develop', feature_branch: 'deep/AUTO-17', directory: workspace } as unknown as GitWorkspace;
    const script = 'test "$JAVA_HOME" = /opt/toolchains/jdk && test -f "$JAVA_HOME/release" && case "$PATH" in /opt/toolchains/jdk/bin:*) ;; *) exit 3;; esac && if touch "$JAVA_HOME/x" 2>/dev/null; then exit 4; fi';
    const checks = await runner.runChecks(gitWorkspace, 'b'.repeat(64), [{ executable: 'sh', args: ['-c', script], timeout_ms: 60_000, required: true }], undefined, { toolchain: { jdk: '25', tomcat: null } });
    assert.equal(checks.checks[0]?.status, 'PASS', JSON.stringify(checks));
    assert.deepEqual(checks.toolchain, { jdk: '25', tomcat: null, java_version: '25.0.1' });
    assert.deepEqual(await readdir(join(outputRoot, '.checks')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
