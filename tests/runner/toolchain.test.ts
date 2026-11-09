import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutosError, TOOLCHAIN_MOUNTS } from '@autos/contracts';
import type { GitWorkspace, ProviderRequest } from '@autos/contracts';
import { DockerRunner, listInstalledToolchains } from '@autos/runner';
import type { DockerExecutor, DockerProcessResult } from '@autos/runner';

const jobId = 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9';
const invocationId = 'c66cbf42-1a04-4458-832a-41b7ef6aefb3';
const done: DockerProcessResult = { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, outputLimit: false };

async function installJdk(root: string, major: string, release = `JAVA_VERSION="${major}.0.1"\nOS_NAME="Linux"\nOS_ARCH="aarch64"\n`): Promise<string> {
  const dir = join(root, 'jdk', major);
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(dir, 'release'), release);
  return dir;
}
async function installTomcat(root: string, version: string, omit?: string): Promise<string> {
  const dir = join(root, 'tomcat', version);
  for (const file of ['bin/catalina.sh', 'lib/catalina.jar', 'conf/server.xml']) {
    if (file === omit) continue;
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), 'x');
  }
  return dir;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-toolchain-test-')));
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'outputs');
  const toolchainRoot = join(root, 'toolchains');
  const cache = join(root, 'm2');
  const workspace = join(workspaceRoot, 'job');
  const invocationRoot = join(outputRoot, jobId, '_private', 'swe', invocationId);
  const prompt = join(invocationRoot, 'input', 'prompt.md');
  const output = join(invocationRoot, 'output');
  await Promise.all([mkdir(join(workspace, '.git'), { recursive: true }), mkdir(join(invocationRoot, 'input'), { recursive: true }), mkdir(output, { recursive: true }), mkdir(toolchainRoot, { recursive: true }), mkdir(cache, { recursive: true })]);
  await writeFile(prompt, 'prompt');
  await installJdk(toolchainRoot, '25');
  await installTomcat(toolchainRoot, '11.0.24');
  return { root, workspaceRoot, outputRoot, toolchainRoot, cache, workspace, prompt, output };
}
type Paths = Awaited<ReturnType<typeof fixture>>;

const roleRequest = (paths: Paths, toolchain?: ProviderRequest['toolchain']): ProviderRequest => ({
  job_id: jobId, issue_key: 'AUTO-17', provider: 'codex', role: 'swe', cwd: paths.workspace, prompt_path: paths.prompt, transcript_path: join(paths.output, 'transcript.jsonl'),
  timeout_ms: 30_000, source_access: 'write', auth_profile: 'p', ...(toolchain ? { toolchain } : {}),
});
const gitWorkspace = (paths: Paths) => ({ job_id: jobId, issue_key: 'AUTO-17', repository_id: 'example/app', base_sha: 'a'.repeat(40), development_branch: 'develop', feature_branch: 'deep/AUTO-17', directory: paths.workspace }) as unknown as GitWorkspace;
const commands = [{ executable: 'mvn', args: ['-q', 'test'], timeout_ms: 60_000, required: true }];

class Fake implements DockerExecutor {
  runs: string[][] = [];
  scratchSeen: { path: string; mode: number; exists: boolean } | undefined;
  async run(_binary: string, args: string[]): Promise<DockerProcessResult> {
    if (args[0] !== 'run') return done;
    this.runs.push(args);
    const scratchSource = args.find((arg) => arg.endsWith(`,dst=${TOOLCHAIN_MOUNTS.scratch}`))?.match(/^type=bind,src=(.*),dst=/)?.[1];
    if (scratchSource) { const info = await stat(scratchSource); this.scratchSeen = { path: scratchSource, mode: info.mode & 0o777, exists: info.isDirectory() }; }
    if (args.includes('worker:test')) {
      const out = args.find((arg) => arg.endsWith(',dst=/run/autos/output'))!.match(/^type=bind,src=(.*),dst=/)![1]!;
      await writeFile(join(out, 'transcript.jsonl'), '{}\n');
      return { ...done, stdout: JSON.stringify({ job_id: jobId, issue_key: 'AUTO-17', result: { provider: 'codex', role: 'swe', status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: '/run/autos/output/transcript.jsonl', result: { ok: true } } }) };
    }
    return { ...done, stdout: JSON.stringify({ exit_code: 0, timed_out: false, output_excerpt: 'ok' }) };
  }
}

const runnerFor = (paths: Paths, executor: DockerExecutor, extra: Partial<ConstructorParameters<typeof DockerRunner>[0]> = {}) =>
  new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot, toolchainRoot: paths.toolchainRoot, executor, testOnly: true, ...extra });
const mountsOf = (args: string[]) => args.filter((_, index) => args[index - 1] === '--mount');
const envOf = (args: string[]) => args.filter((_, index) => args[index - 1] === '--env');

test('listInstalledToolchains reports only valid, sorted, real toolchains', async () => {
  const paths = await fixture();
  try {
    const root = paths.toolchainRoot;
    await installJdk(root, '21');
    await installJdk(root, '17', 'JAVA_VERSION="21.0.1"\nOS_NAME="Linux"\n'); // wrong major
    await installJdk(root, '19', 'JAVA_VERSION="19.0.1"\nOS_NAME="Darwin"\n'); // not Linux
    await installJdk(root, '23').then((dir) => rm(join(dir, 'bin/java'))); // no java
    await installJdk(join(paths.root, 'elsewhere'), '22');
    await symlink(join(paths.root, 'elsewhere', 'jdk', '22'), join(root, 'jdk', '22')); // escaping symlink
    await symlink(join(root, 'jdk', '21'), join(root, 'jdk', '24')); // symlinked directory inside the root
    await mkdir(join(root, 'jdk', 'latest'), { recursive: true });
    await installTomcat(root, '10.1.30');
    await installTomcat(root, '9.0.90', 'lib/catalina.jar');
    await installTomcat(root, '10.1.31', 'conf/server.xml');
    assert.deepEqual(await listInstalledToolchains(root), { jdk: ['21', '25'], tomcat: ['10.1.30', '11.0.24'] });
    const runner = runnerFor(paths, new Fake());
    assert.deepEqual((await runner.health()).toolchains, { jdk: ['21', '25'], tomcat: ['10.1.30', '11.0.24'] });
    const plain = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot, executor: new Fake(), testOnly: true });
    assert.equal('toolchains' in (await plain.health()), false);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('runRole with a toolchain mounts it read-only with scratch, env and offline Maven args, then removes scratch', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    const result = await runnerFor(paths, executor, { dependencyCacheRoot: paths.cache }).runRole(roleRequest(paths, { jdk: '25', tomcat: '11.0.24' }));
    assert.equal(result.status, 'SUCCEEDED');
    const args = executor.runs[0]!;
    const mounts = mountsOf(args);
    assert.ok(mounts.includes(`type=bind,src=${join(paths.toolchainRoot, 'jdk', '25')},dst=${TOOLCHAIN_MOUNTS.jdk},readonly`));
    assert.ok(mounts.includes(`type=bind,src=${join(paths.toolchainRoot, 'tomcat', '11.0.24')},dst=${TOOLCHAIN_MOUNTS.tomcat},readonly`));
    assert.ok(mounts.includes(`type=bind,src=${paths.cache},dst=${TOOLCHAIN_MOUNTS.mavenCache},readonly`));
    assert.ok(mounts.some((mountArg) => mountArg.startsWith(`type=bind,src=${join(paths.outputRoot, '.scratch')}/`) && mountArg.endsWith(`,dst=${TOOLCHAIN_MOUNTS.scratch}`)));
    const env = envOf(args);
    assert.ok(env.includes(`JAVA_HOME=${TOOLCHAIN_MOUNTS.jdk}`) && env.includes(`CATALINA_HOME=${TOOLCHAIN_MOUNTS.tomcat}`) && env.includes(`CATALINA_BASE=${TOOLCHAIN_MOUNTS.catalinaBase}`));
    assert.ok(env.includes(`MAVEN_ARGS=-o -Dmaven.repo.local=${TOOLCHAIN_MOUNTS.mavenLocal} -Dmaven.repo.local.tail=${TOOLCHAIN_MOUNTS.mavenCache} -Dmaven.repo.local.tail.ignoreAvailability=true`));
    assert.ok(env.some((entry) => entry.startsWith(`PATH=${TOOLCHAIN_MOUNTS.jdk}/bin:/opt/maven/bin:/usr/local/`)));
    assert.equal(executor.scratchSeen?.mode, 0o700);
    assert.deepEqual(await readdir(join(paths.outputRoot, '.scratch')), []);
    assert.equal(await stat(executor.scratchSeen!.path).then(() => true, () => false), false);

    // No cache, no Tomcat: no tail, no CATALINA_*.
    const bare = new Fake();
    await runnerFor(paths, bare).runRole(roleRequest(paths, { jdk: '25', tomcat: null }));
    const bareEnv = envOf(bare.runs[0]!);
    assert.ok(bareEnv.includes(`MAVEN_ARGS=-o -Dmaven.repo.local=${TOOLCHAIN_MOUNTS.mavenLocal}`));
    assert.ok(!bareEnv.some((entry) => entry.startsWith('CATALINA_')));
    assert.ok(!mountsOf(bare.runs[0]!).some((entry) => entry.includes(TOOLCHAIN_MOUNTS.tomcat) || entry.includes(TOOLCHAIN_MOUNTS.mavenCache)));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('runRole without a toolchain is unchanged: no toolchain mounts, env or scratch', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    await runnerFor(paths, executor, { dependencyCacheRoot: paths.cache }).runRole(roleRequest(paths));
    const args = executor.runs[0]!;
    assert.deepEqual(envOf(args), []);
    assert.ok(!mountsOf(args).some((entry) => entry.includes('/opt/toolchains') || entry.includes(',dst=/scratch') || entry.includes(TOOLCHAIN_MOUNTS.mavenCache)));
    await assert.rejects(() => readdir(join(paths.outputRoot, '.scratch')));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('unknown or unconfigured toolchains fail with INVALID_CONFIG before any container starts', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    const runner = runnerFor(paths, executor);
    for (const selection of [{ jdk: '21', tomcat: null }, { jdk: '25', tomcat: '10.1.30' }]) {
      await assert.rejects(() => runner.runRole(roleRequest(paths, selection)), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG' && !error.retryable && /Required toolchain is not installed on the runner: (JDK 21|Tomcat 10\.1\.30)/.test(error.message));
      await assert.rejects(() => runner.runChecks(gitWorkspace(paths), 'a'.repeat(64), commands, undefined, { toolchain: selection }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
    }
    const noRoot = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
    await assert.rejects(() => noRoot.runRole(roleRequest(paths, { jdk: '25', tomcat: null })), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG' && error.message === 'Required toolchain is not installed on the runner: JDK 25');
    await assert.rejects(() => noRoot.runChecks(gitWorkspace(paths), 'a'.repeat(64), commands, undefined, { toolchain: { jdk: '25', tomcat: null } }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
    assert.equal(executor.runs.length, 0);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('runChecks mounts the toolchain read-only, passes env and records checks.toolchain with java_version', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    const checks = await runnerFor(paths, executor, { dependencyCacheRoot: paths.cache }).runChecks(gitWorkspace(paths), 'b'.repeat(64), commands, undefined, { toolchain: { jdk: '25', tomcat: '11.0.24' } });
    assert.deepEqual(checks.toolchain, { jdk: '25', tomcat: '11.0.24', java_version: '25.0.1' });
    const args = executor.runs[0]!;
    const mounts = mountsOf(args);
    assert.ok(mounts.includes(`type=bind,src=${join(paths.toolchainRoot, 'jdk', '25')},dst=${TOOLCHAIN_MOUNTS.jdk},readonly`));
    assert.ok(mounts.includes(`type=bind,src=${join(paths.toolchainRoot, 'tomcat', '11.0.24')},dst=${TOOLCHAIN_MOUNTS.tomcat},readonly`));
    const env = envOf(args);
    assert.ok(env.includes(`JAVA_HOME=${TOOLCHAIN_MOUNTS.jdk}`) && env.includes(`CATALINA_HOME=${TOOLCHAIN_MOUNTS.tomcat}`));
    assert.ok(env.some((entry) => entry.startsWith(`PATH=${TOOLCHAIN_MOUNTS.jdk}/bin:`)));
    assert.deepEqual(await readdir(join(paths.outputRoot, '.checks')), []);

    const plain = new Fake();
    const without = await runnerFor(paths, plain).runChecks(gitWorkspace(paths), 'b'.repeat(64), commands);
    assert.equal('toolchain' in without, false);
    assert.deepEqual(envOf(plain.runs[0]!), []);
    assert.ok(!mountsOf(plain.runs[0]!).some((entry) => entry.includes('/opt/toolchains')));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('toolchain root overlapping job data, auth or cache roots is refused', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    for (const toolchainRoot of [join(paths.workspaceRoot, 'tc'), paths.outputRoot, paths.root]) {
      assert.throws(() => runnerFor(paths, executor, { toolchainRoot }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
    }
    assert.throws(() => runnerFor(paths, executor, { dependencyCacheRoot: join(paths.toolchainRoot, 'jdk') }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
    // Symlinked overlap is caught on canonical paths when a toolchain is used.
    await symlink(paths.outputRoot, join(paths.root, 'link-to-output'));
    const runner = runnerFor(paths, executor, { toolchainRoot: join(paths.root, 'link-to-output') });
    await assert.rejects(() => runner.runRole(roleRequest(paths, { jdk: '25', tomcat: null })), (error: unknown) => error instanceof AutosError && error.code === 'POLICY');
    assert.equal(executor.runs.length, 0);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('java_version is read from the release file as written (bare major versions included)', async () => {
  const paths = await fixture();
  try {
    await rm(join(paths.toolchainRoot, 'jdk', '25'), { recursive: true });
    await installJdk(paths.toolchainRoot, '25', 'JAVA_VERSION="25"\nOS_NAME="Linux"\n');
    const executor = new Fake();
    const checks = await runnerFor(paths, executor).runChecks(gitWorkspace(paths), 'b'.repeat(64), commands, undefined, { toolchain: { jdk: '25', tomcat: null } });
    assert.deepEqual(checks.toolchain, { jdk: '25', tomcat: null, java_version: '25' });
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
