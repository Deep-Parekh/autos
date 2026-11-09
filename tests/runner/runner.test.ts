import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { AutosError } from '@autos/contracts';
import type { ProviderRequest } from '@autos/contracts';
import { spawnSync } from 'node:child_process';
import { DockerRunner, DockerRunnerClient, createSupervisorServer, defaultDockerExecutor, shutdownSupervisor } from '@autos/runner';
import type { DockerExecutor, DockerProcessOptions } from '@autos/runner';

class FakeDocker implements DockerExecutor {
  calls: { binary: string; args: string[]; options: DockerProcessOptions }[] = [];
  nextResult: { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimit: boolean } | undefined;
  listedContainer = '';
  envFileContents = '';
  async run(binary: string, args: string[], options: DockerProcessOptions): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimit: boolean }> {
    this.calls.push({ binary, args, options });
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, outputLimit: false };
    if (args[0] === 'ps') return { code: 0, stdout: this.listedContainer, stderr: '', timedOut: false, cancelled: false, outputLimit: false };
    const envIndex = args.indexOf('--env-file');
    if (envIndex >= 0) this.envFileContents = await readFile(args[envIndex + 1]!, 'utf8');
    if (this.nextResult) { const result = this.nextResult; this.nextResult = undefined; return result; }
    if (args[args.indexOf('worker:test') + 1] === '--provider') {
      const role = args[args.indexOf('--role') + 1];
      const provider = args[args.indexOf('--provider') + 1];
      const outMount = args.find((arg) => arg.endsWith(',dst=/run/autos/output'));
      const hostOut = outMount?.match(/^type=bind,src=(.*),dst=/)?.[1];
      // The real worker writes its private transcript into the mounted output directory.
      if (hostOut) await writeFile(join(hostOut, args[args.indexOf('--transcript') + 1]!.split('/').at(-1)!), '{"event":"fake"}\n');
      return { code: 0, stdout: JSON.stringify({ job_id: 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9', issue_key: 'AUTO-17', result: { provider, role, status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: `/run/autos/output/${args[args.indexOf('--transcript') + 1]?.split('/').at(-1)}`, result: { summary: 'updated' } } }), stderr: '', timedOut: false, cancelled: false, outputLimit: false };
    }
    if (args.includes('checks:test')) return { code: 0, stdout: JSON.stringify({ exit_code: 0, timed_out: false, output_excerpt: 'fixture check passed' }), stderr: '', timedOut: false, cancelled: false, outputLimit: false };
    return { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, outputLimit: false };
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-runner-test-')));
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'outputs');
  const promptRoot = outputRoot;
  const workspace = join(workspaceRoot, 'job');
  const jobId = 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9';
  const invocationId = 'c66cbf42-1a04-4458-832a-41b7ef6aefb3';
  const invocationRoot = join(outputRoot, jobId, '_private', 'swe', invocationId);
  const prompt = join(invocationRoot, 'input', 'prompt.md');
  const output = join(invocationRoot, 'output');
  await Promise.all([mkdir(join(workspace, '.git'), { recursive: true }), mkdir(join(invocationRoot, 'input'), { recursive: true }), mkdir(output, { recursive: true })]);
  await writeFile(prompt, 'Check source carefully');
  return { root, workspaceRoot, promptRoot, outputRoot, workspace, prompt, output };
}

const request = (paths: Awaited<ReturnType<typeof fixture>>): ProviderRequest => ({
  job_id: 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9', issue_key: 'AUTO-17', provider: 'codex', role: 'swe', cwd: paths.workspace,
  prompt_path: paths.prompt, transcript_path: join(paths.output, 'transcript.jsonl'), timeout_ms: 30_000, source_access: 'write', auth_profile: 'codex-profile',
});

test('DockerRunner builds bounded role-specific container plans and isolated check plans', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  try {
    const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
    const result = await runner.runRole(request(paths));
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.transcript_path, join(paths.output, 'transcript.jsonl'));
    const args = executor.calls[0]!.args;
    assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none');
    assert.ok(args.includes('--read-only') && args.includes('--cap-drop') && args.includes('ALL'));
    assert.ok(args.includes('no-new-privileges:true'));
    const mountArgs = args.filter((arg) => arg.startsWith('type=bind'));
    assert.ok(mountArgs.some((arg) => arg.endsWith('dst=/workspace')));
    assert.ok(mountArgs.some((arg) => arg.endsWith('dst=/workspace/.git,readonly')));
    assert.ok(mountArgs.some((arg) => arg.endsWith('dst=/run/autos/prompt.txt,readonly')));
    assert.ok(mountArgs.some((arg) => arg.endsWith('dst=/run/autos/output')));
    const checks = await runner.runChecks({ job_id: request(paths).job_id, issue_key: 'AUTO-17', repository: {} as never, directory: paths.workspace, base_sha: 'a'.repeat(40), development_branch: 'main', feature_branch: 'deep/AUTO-17' }, 'b'.repeat(64), [{ executable: 'mvn', args: ['test'], timeout_ms: 1000, required: true }]);
    assert.equal(checks.checks[0]?.status, 'PASS');
    const checkArgs = executor.calls.find((call) => call.args.includes('checks:test'))!.args;
    assert.equal(checkArgs[checkArgs.indexOf('checks:test') + 1], '--source');
    assert.ok(checkArgs.some((arg) => arg.endsWith('dst=/source,readonly')));
    assert.ok(checkArgs.some((arg) => arg.endsWith('dst=/scratch')));
    assert.ok(executor.calls.some((call) => call.args[0] === 'rm'));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('QA cannot request write access and workspace paths cannot escape the configured root', async () => {
  const paths = await fixture();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor: new FakeDocker(), testOnly: true });
  try {
    await assert.rejects(() => runner.runRole({ ...request(paths), role: 'qa', source_access: 'write' }));
    await assert.rejects(() => runner.runRole({ ...request(paths), cwd: paths.root }), (error: unknown) => error instanceof AutosError);
    const qaRoot = join(paths.outputRoot, request(paths).job_id, '_private', 'qa', 'c66cbf42-1a04-4458-832a-41b7ef6aefb3');
    await mkdir(join(qaRoot, 'input'), { recursive: true }); await mkdir(join(qaRoot, 'output'), { recursive: true });
    const qaPrompt = join(qaRoot, 'input', 'prompt.md'); await writeFile(qaPrompt, 'Review without editing');
    await runner.runRole({ ...request(paths), role: 'qa', source_access: 'read', prompt_path: qaPrompt, transcript_path: join(qaRoot, 'output', 'transcript.jsonl') });
    const qaArgs = (runner as unknown as { executor: FakeDocker }).executor.calls.find((call) => call.args.includes('worker:test') && call.args[call.args.indexOf('--role') + 1] === 'qa')!.args;
    assert.ok(qaArgs.some((arg) => arg.endsWith('dst=/workspace,readonly')));
    assert.ok(qaArgs.some((arg) => arg.endsWith('dst=/workspace/.git,readonly')));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('check timeout and cancellation do not count as passing evidence', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  const workspace = { job_id: request(paths).job_id, issue_key: 'AUTO-17', repository: {} as never, directory: paths.workspace, base_sha: 'a'.repeat(40), development_branch: 'main', feature_branch: 'deep/AUTO-17' };
  try {
    executor.nextResult = { code: null, stdout: '', stderr: '', timedOut: true, cancelled: false, outputLimit: false };
    const timeout = await runner.runChecks(workspace, 'b'.repeat(64), [{ executable: 'mvn', args: ['test'], timeout_ms: 1000, required: true }]);
    assert.equal(timeout.checks[0]?.status, 'FAIL');
    assert.equal(timeout.checks[0]?.timed_out, true);
    const controller = new AbortController(); controller.abort();
    const cancelled = await runner.runChecks(workspace, 'b'.repeat(64), [{ executable: 'mvn', args: ['test'], timeout_ms: 1000, required: true }], controller.signal);
    assert.equal(cancelled.checks[0]?.status, 'NOT_RUN');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('api-mode profile keys reach only the private env file, never Docker argv, and no auth directory is mounted', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, authProfiles: async () => ({ mode: 'api', env: { OPENAI_API_KEY: 'sensitive-fixture-key' } }), executor, testOnly: true });
  try {
    const result = await runner.runRole(request(paths));
    assert.equal(result.status, 'SUCCEEDED');
    assert.match(executor.envFileContents, /OPENAI_API_KEY=sensitive-fixture-key/);
    const args = executor.calls[0]!.args;
    assert.ok(!args.some((arg) => arg.includes('dst=/run/autos/auth')), 'api mode mounts no auth directory');
    assert.ok(!executor.envFileContents.includes('CODEX_HOME'));
    assert.ok(!args.join(' ').includes('sensitive-fixture-key'));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('executor output-limit and pre-abort are explicit and pre-abort does not spawn', async () => {
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await defaultDockerExecutor.run('/definitely/missing/executable', [], { timeoutMs: 1000 }, aborted.signal);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.code, null);
  assert.equal(cancelled.outputLimit, false);
  const limited = await defaultDockerExecutor.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { timeoutMs: 5000, maxOutputBytes: 100 });
  assert.equal(limited.outputLimit, true);
});

test('stop discovers labelled containers even when the supervisor has no in-memory job state', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  executor.listedContainer = 'a'.repeat(64);
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  try {
    await runner.stop(request(paths).job_id);
    assert.ok(executor.calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'a'.repeat(64)));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('fixed Unix supervisor RPC reports readiness and translates only approved paths', async (t) => {
  const paths = await fixture();
  const socketPath = join(paths.root, 'runner.sock');
  const executor = new FakeDocker();
  const hostRoot = join(paths.root, 'host');
  await mkdir(join(hostRoot, 'workspace', '.git'), { recursive: true });
    const hostPrompt = join(hostRoot, 'outputs', 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9', '_private', 'swe', 'c66cbf42-1a04-4458-832a-41b7ef6aefb3', 'input');
    await mkdir(hostPrompt, { recursive: true });
  const hostOutput = join(hostPrompt, '..', 'output');
    await mkdir(hostOutput, { recursive: true });
    await writeFile(join(hostPrompt, 'prompt.md'), 'Hello');
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: join(hostRoot, 'workspace'), promptRoot: join(hostRoot, 'outputs'), outputRoot: join(hostRoot, 'outputs'), executor, testOnly: true });
  let server: Awaited<ReturnType<typeof createSupervisorServer>>;
  try { server = await createSupervisorServer({ socketPath, runner, clientRoot: paths.root, hostRoot }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('environment blocks Unix socket creation; RPC remains unverified here'); return; }
    throw error;
  }
  const client = new DockerRunnerClient({ socketPath });
  try {
    assert.deepEqual(await client.health(), { status: 'ready', version: 1, docker: 'test-only', auth: [], require_subscription: false });
    const apiRequest = { ...request(paths), cwd: join(paths.root, 'workspace') };
    await mkdir(apiRequest.cwd, { recursive: true });
    await mkdir(dirname(apiRequest.cwd) === paths.root ? join(paths.root, 'workspace', '.git') : join(apiRequest.cwd, '.git'), { recursive: true });
    const response = await client.runRole(apiRequest);
    assert.equal(response.transcript_path, apiRequest.transcript_path);
    await assert.rejects(() => client.runRole({ ...apiRequest, cwd: resolve(paths.root, '..') }), (error: unknown) => error instanceof AutosError);
  } finally { await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())); await rm(paths.root, { recursive: true, force: true }); }
});

test('concurrent jobs use distinct containers, scratch mounts and per-job stop without single-job assumptions', async () => {
  const paths = await fixture();
  const jobA = 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9';
  const jobB = 'aaaaaaaa-3ea7-4e3f-a005-68288ea6c9d9';
  const dirB = join(paths.workspaceRoot, 'jobB');
  await mkdir(dirB, { recursive: true });
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const started: string[] = [];
  const scratchMounts: string[] = [];
  class Gated extends FakeDocker {
    override async run(binary: string, args: string[], options: DockerProcessOptions) {
      if (args[0] === 'run' && args.includes('checks:test')) { started.push(args[args.indexOf('--name') + 1]!); scratchMounts.push(args.find((arg) => arg.endsWith('dst=/scratch'))!); await gate; }
      return super.run(binary, args, options);
    }
  }
  const executor = new Gated();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  const workspace = (job_id: string, directory: string) => ({ job_id, issue_key: 'AUTO-17', repository: {} as never, directory, base_sha: 'a'.repeat(40), development_branch: 'main', feature_branch: 'deep/AUTO-17' });
  const command = [{ executable: 'mvn', args: ['test'], timeout_ms: 1000, required: true }];
  try {
    const first = runner.runChecks(workspace(jobA, paths.workspace), 'b'.repeat(64), command);
    const second = runner.runChecks(workspace(jobB, dirB), 'c'.repeat(64), command);
    for (let i = 0; i < 100 && started.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(started.length, 2, 'both jobs have a live container at once');
    assert.notEqual(started[0], started[1]);
    assert.equal(new Set(scratchMounts).size, 2, 'each check run has its own scratch mount');
    // Stopping job A removes only job A's container.
    await runner.stop(jobA);
    const removed = executor.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args.at(-1));
    assert.ok(removed.length >= 1 && removed.every((name) => String(name).includes(jobA)), `stop removed only job A containers: ${removed.join()}`);
    release();
    assert.equal((await first).candidate_digest, 'b'.repeat(64));
    assert.equal((await second).candidate_digest, 'c'.repeat(64));
  } finally { release(); await rm(paths.root, { recursive: true, force: true }); }
});

const gitWorkspace = (paths: Awaited<ReturnType<typeof fixture>>) => ({ job_id: request(paths).job_id, issue_key: 'AUTO-17', repository: {} as never, directory: paths.workspace, base_sha: 'a'.repeat(40), development_branch: 'main', feature_branch: 'deep/AUTO-17' });
const oneCheck = [{ executable: 'mvn', args: ['test'], timeout_ms: 1000, required: true }];
const processResult = (code: number | null, stdout = '', stderr = '') => ({ code, stdout, stderr, timedOut: false, cancelled: false, outputLimit: false });

test('docker infrastructure exits map to UNAVAILABLE for roles and throw for checks; 137 is an explicit OOM failure', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  try {
    for (const code of [125, 126, 127]) {
      executor.nextResult = processResult(code, '', 'docker: secret-looking raw stderr');
      const role = await runner.runRole(request(paths));
      assert.equal(role.status, 'FAILED');
      assert.equal(role.error_code, 'UNAVAILABLE');
      assert.ok(!JSON.stringify(role).includes('secret-looking'));
      executor.nextResult = processResult(code);
      await assert.rejects(() => runner.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck), (error: unknown) => error instanceof AutosError && error.code === 'UNAVAILABLE' && error.retryable);
    }
    // The docker binary could not even be spawned (null exit, no output).
    executor.nextResult = processResult(null);
    assert.equal((await runner.runRole(request(paths))).error_code, 'UNAVAILABLE');
    // A wrapper report is authoritative even when the check itself exited 127.
    executor.nextResult = processResult(1, JSON.stringify({ exit_code: 127, timed_out: false, output_excerpt: 'mvn: not found' }));
    assert.equal((await runner.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck)).checks[0]?.status, 'FAIL');
    executor.nextResult = processResult(137);
    const killedRole = await runner.runRole(request(paths));
    assert.equal(killedRole.error_code, 'TOOL');
    assert.match(JSON.stringify(killedRole.result), /exit 137.*AUTOS_ROLE_MEMORY/);
    executor.nextResult = processResult(137);
    const killedCheck = (await runner.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck)).checks[0]!;
    assert.equal(killedCheck.status, 'FAIL');
    assert.equal(killedCheck.exit_code, 137);
    assert.match(killedCheck.output_excerpt ?? '', /killed \(exit 137\): likely out of memory; raise AUTOS_CHECK_MEMORY/);
    executor.nextResult = processResult(1, JSON.stringify({ exit_code: 137, timed_out: false, output_excerpt: 'Killed' }));
    const wrapped = (await runner.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck)).checks[0]!;
    assert.match(wrapped.output_excerpt ?? '', /AUTOS_CHECK_MEMORY[\s\S]*Killed/);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('worker failures with a sanitized error_code surface to the caller', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  try {
    const failed = { job_id: request(paths).job_id, issue_key: 'AUTO-17', result: { provider: 'codex', role: 'swe', status: 'FAILED', exit_code: 1, elapsed_ms: 0, transcript_path: '/run/autos/output/transcript.jsonl', result: null, error_code: 'INVALID_INPUT' } };
    executor.nextResult = processResult(1, JSON.stringify(failed));
    const result = await runner.runRole(request(paths));
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error_code, 'INVALID_INPUT');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('client reports a missing or refused supervisor socket as retryable UNAVAILABLE', async () => {
  const paths = await fixture();
  try {
    const client = new DockerRunnerClient({ socketPath: join(paths.root, 'missing.sock') });
    await assert.rejects(() => client.health(), (error: unknown) => error instanceof AutosError && error.code === 'UNAVAILABLE' && error.retryable);
    await assert.rejects(() => client.runRole(request(paths)), (error: unknown) => error instanceof AutosError && error.code === 'UNAVAILABLE');
    await assert.rejects(() => client.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck), (error: unknown) => error instanceof AutosError && error.code === 'UNAVAILABLE');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('health requires a reachable daemon and both images', async () => {
  const paths = await fixture();
  let missingImage: string | undefined;
  let daemonDown = false;
  const calls: string[][] = [];
  const executor: DockerExecutor = { async run(_binary, args) {
    calls.push(args);
    if (daemonDown) return processResult(1);
    if (args[0] === 'image' && args.at(-1) === missingImage) return processResult(1);
    return processResult(0, '1');
  } };
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor: executor, testOnly: true });
  // testOnly short-circuits health, so use a non-test runner shape through the same executor seam.
  const real = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  (real as unknown as { options: { testOnly?: boolean } }).options = { ...(real as unknown as { options: object }).options, testOnly: undefined } as never;
  try {
    assert.equal((await runner.health()).docker, 'test-only');
    assert.equal((await real.health()).docker, 'available');
    assert.ok(calls.some((args) => args[0] === 'image' && args.at(-1) === 'worker:test') && calls.some((args) => args[0] === 'image' && args.at(-1) === 'checks:test'));
    missingImage = 'checks:test';
    assert.equal((await real.health()).docker, 'unavailable');
    missingImage = undefined; daemonDown = true;
    assert.equal((await real.health()).docker, 'unavailable');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('runner and checks containers use --init and configurable limits with the raised HOME tmpfs default', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  const make = (limits?: ConstructorParameters<typeof DockerRunner>[0]['limits']) => new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true, ...(limits ? { limits } : {}) });
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  try {
    await make().runRole(request(paths));
    await make().runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck);
    const roleArgs = executor.calls.find((call) => call.args[0] === 'run' && call.args.includes('worker:test'))!.args;
    const checkArgs = executor.calls.find((call) => call.args[0] === 'run' && call.args.includes('checks:test'))!.args;
    assert.ok(roleArgs.includes('--init') && checkArgs.includes('--init'));
    assert.match(roleArgs.find((arg) => arg.startsWith('/home/worker:'))!, /size=256m/);
    assert.equal(value(roleArgs, '--memory'), '2g');
    assert.equal(value(checkArgs, '--memory'), '4g');
    assert.match(executor.envFileContents, /AUTOS_TIMEOUT_MS=30000/);
    assert.match(executor.envFileContents, /AUTOS_MAX_PROMPT_BYTES=262144/);
    executor.calls.length = 0;
    const custom = make({ memory: '3g', cpus: '1.5', checkMemory: '6g', checkCpus: '4', pids: 512, tmpSize: '64m', homeSize: '512m', maxPromptBytes: 500_000 });
    await custom.runRole(request(paths));
    await custom.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck);
    const customRole = executor.calls.find((call) => call.args[0] === 'run' && call.args.includes('worker:test'))!.args;
    const customCheck = executor.calls.find((call) => call.args[0] === 'run' && call.args.includes('checks:test'))!.args;
    assert.deepEqual([value(customRole, '--memory'), value(customRole, '--cpus'), value(customRole, '--pids-limit')], ['3g', '1.5', '512']);
    assert.deepEqual([value(customCheck, '--memory'), value(customCheck, '--cpus')], ['6g', '4']);
    assert.match(customRole.find((arg) => arg.startsWith('/home/worker:'))!, /size=512m/);
    assert.match(customCheck.find((arg) => arg.startsWith('/tmp:'))!, /size=64m/);
    assert.match(executor.envFileContents, /AUTOS_MAX_PROMPT_BYTES=500000/);
    for (const bad of [{ memory: '2' }, { checkMemory: 'lots' }, { cpus: '0' }, { checkCpus: '-1' }, { tmpSize: '0m' }, { homeSize: '1t' }, { maxPromptBytes: 10 }, { pids: 1 }]) {
      assert.throws(() => make(bad as never), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG', JSON.stringify(bad));
    }
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('startup sweep removes labelled containers, stale check scratch and stale env dirs', async (t) => {
  const paths = await fixture();
  const staleEnvRoot = join(paths.root, 'env');
  await mkdir(join(staleEnvRoot, 'autos-auth-abc123'), { recursive: true });
  await mkdir(join(staleEnvRoot, 'unrelated'), { recursive: true });
  await mkdir(join(paths.outputRoot, '.checks', 'old-scratch'), { recursive: true });
  await writeFile(join(paths.outputRoot, '.checks', 'old-scratch', 'file'), 'x');
  const executor = new FakeDocker();
  executor.listedContainer = `${'a'.repeat(64)}\n${'b'.repeat(64)}\nnot-an-id\n`;
  const logs: Record<string, unknown>[] = [];
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, envRoot: staleEnvRoot, executor, testOnly: true });
  let server: Awaited<ReturnType<typeof createSupervisorServer>> | undefined;
  try {
    try { server = await createSupervisorServer({ socketPath: join(paths.root, 'sweep.sock'), runner, clientRoot: paths.root, hostRoot: paths.root, log: (record) => logs.push({ ...record }) }); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('environment blocks Unix sockets'); return; } throw error; }
    const listing = executor.calls.find((call) => call.args[0] === 'ps')!;
    assert.ok(listing.args.includes('label=autos.job_id'));
    const removed = executor.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args.at(-1));
    assert.deepEqual(removed, ['a'.repeat(64), 'b'.repeat(64)]);
    assert.deepEqual(await readdir(join(paths.outputRoot, '.checks')), []);
    assert.deepEqual(await readdir(staleEnvRoot), ['unrelated']);
    assert.deepEqual(logs[0], { event: 'sweep', status: 'OK', containers: 2, scratch: 1, env_dirs: 1, elapsed_ms: logs[0]!.elapsed_ms });
  } finally { if (server) await shutdownSupervisor(server, { waitMs: 500 }); await rm(paths.root, { recursive: true, force: true }); }
});

test('shutdown aborts in-flight runs, stops their containers and logs one structured line per request', async (t) => {
  const paths = await fixture();
  let aborted = false;
  let started!: () => void;
  const running = new Promise<void>((resolvePromise) => { started = resolvePromise; });
  const calls: string[][] = [];
  const executor: DockerExecutor = {
    async run(_binary, args, _options, signal) {
      calls.push(args);
      if (args[0] === 'run') {
        started();
        await new Promise<void>((resolvePromise) => { signal?.addEventListener('abort', () => { aborted = true; resolvePromise(); }, { once: true }); });
        return { code: null, stdout: '', stderr: '', timedOut: false, cancelled: true, outputLimit: false };
      }
      return processResult(0);
    },
  };
  const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
  const logs: Record<string, unknown>[] = [];
  const socketPath = join(paths.root, 'shutdown.sock');
  let server: Awaited<ReturnType<typeof createSupervisorServer>>;
  try { server = await createSupervisorServer({ socketPath, runner, clientRoot: paths.root, hostRoot: paths.root, log: (record) => logs.push({ ...record }) }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('environment blocks Unix sockets'); await rm(paths.root, { recursive: true, force: true }); return; } throw error; }
  try {
    const client = new DockerRunnerClient({ socketPath });
    const pending = client.runChecks(gitWorkspace(paths), 'b'.repeat(64), oneCheck);
    await running;
    await shutdownSupervisor(server, { waitMs: 2000 });
    assert.equal(aborted, true, 'in-flight execution received the abort signal');
    const outcome: unknown = await pending.catch((error: unknown) => error);
    if (!(outcome instanceof Error)) assert.equal((outcome as Awaited<typeof pending>).checks[0]?.status, 'NOT_RUN');
    assert.ok(calls.some((args) => args[0] === 'rm' && args.at(-1)?.startsWith('autos-')), 'in-flight container was removed');
    const requestLog = logs.find((record) => record.event === 'request' && record.action === 'run-checks');
    assert.ok(requestLog, JSON.stringify(logs));
    assert.equal(requestLog.job_id, request(paths).job_id);
    assert.ok(typeof requestLog.elapsed_ms === 'number');
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(paths.root) && !serialized.includes('mvn'), 'logs carry no paths or commands');
    assert.ok(logs.some((record) => record.event === 'shutdown'));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('supervisor start script validates environment, treats empty strings as unset and fails with clear messages', () => {
  const script = resolve('docker/supervisor/start.mjs');
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--test'));
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [...execArgv, script], { encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH ?? '', ...extra } });
  const base = { AUTOS_SUPERVISOR_SOCKET: '/tmp/autos-never.sock', AUTOS_WORKSPACE_ROOT: '/tmp/autos-w', AUTOS_PROMPT_ROOT: '/tmp/autos-o', AUTOS_OUTPUT_ROOT: '/tmp/autos-o', AUTOS_WORKER_IMAGE: 'w:t', AUTOS_CHECKS_IMAGE: 'c:t', AUTOS_PROVIDER_PROFILES_FILE: '/tmp/autos-missing/profiles.json' };
  const missing = run({});
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /AUTOS_SUPERVISOR_SOCKET is required/);
  const empty = run({ ...base, AUTOS_WORKER_IMAGE: '', AUTOS_RUNNER_UID: '0' });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /AUTOS_WORKER_IMAGE is required/);
  assert.match(empty.stderr, /AUTOS_RUNNER_UID must be an integer between 1/);
  const badLimits = run({ ...base, AUTOS_CHECK_MEMORY: 'lots', AUTOS_ROLE_CPUS: '0', AUTOS_PIDS_LIMIT: '3', AUTOS_TMP_SIZE: '12', AUTOS_HOME_SIZE: '9t', AUTOS_RUNNER_UID: '', AUTOS_RUNNER_GID: '' });
  assert.equal(badLimits.status, 2);
  for (const name of ['AUTOS_CHECK_MEMORY', 'AUTOS_ROLE_CPUS', 'AUTOS_PIDS_LIMIT', 'AUTOS_TMP_SIZE', 'AUTOS_HOME_SIZE']) assert.match(badLimits.stderr, new RegExp(name));
  assert.doesNotMatch(badLimits.stderr, /AUTOS_RUNNER_UID|AUTOS_RUNNER_GID/, 'empty uid/gid fall back to the process ids instead of failing or becoming 0');
  const relative = run({ ...base, AUTOS_WORKSPACE_ROOT: 'relative/path' });
  assert.match(relative.stderr, /AUTOS_WORKSPACE_ROOT must be an absolute path/);
  const profile = run(base);
  assert.equal(profile.status, 2);
  assert.match(profile.stderr, /AUTOS_PROVIDER_PROFILES_FILE is unreadable/);
});

test('DockerRunner forwards a validated reasoning effort to the worker as its own argument', async () => {
  const paths = await fixture();
  const executor = new FakeDocker();
  try {
    const runner = new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.promptRoot, outputRoot: paths.outputRoot, executor, testOnly: true });
    assert.equal((await runner.runRole({ ...request(paths), effort: 'xhigh' })).status, 'SUCCEEDED');
    const args = executor.calls[0]!.args; const worker = args.slice(args.indexOf('worker:test'));
    assert.equal(worker[worker.indexOf('--effort') + 1], 'xhigh');
    executor.calls = [];
    assert.equal((await runner.runRole(request(paths))).status, 'SUCCEEDED');
    assert.equal(executor.calls[0]!.args.includes('--effort'), false);
    await assert.rejects(() => runner.runRole({ ...request(paths), provider: 'cursor', effort: 'high' }));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
