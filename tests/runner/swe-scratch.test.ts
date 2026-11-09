import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutosError, TOOLCHAIN_MOUNTS } from '@autos/contracts';
import type { ProviderRequest } from '@autos/contracts';
import { DockerRunner, DockerRunnerClient, createSupervisorServer, shutdownSupervisor } from '@autos/runner';
import type { DockerExecutor, DockerProcessResult } from '@autos/runner';

const jobA = 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9';
const jobB = 'aaaaaaaa-3ea7-4e3f-a005-68288ea6c9d9';
const done: DockerProcessResult = { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, outputLimit: false };
type Role = ProviderRequest['role'];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-swe-scratch-')));
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'outputs');
  const toolchainRoot = join(root, 'toolchains');
  const workspace = join(workspaceRoot, 'job');
  const jdk = join(toolchainRoot, 'jdk', '25');
  await Promise.all([mkdir(join(workspace, '.git'), { recursive: true }), mkdir(join(jdk, 'bin'), { recursive: true }), mkdir(outputRoot, { recursive: true })]);
  await writeFile(join(jdk, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(jdk, 'release'), 'JAVA_VERSION="25.0.1"\nOS_NAME="Linux"\n');
  return { root, workspaceRoot, outputRoot, toolchainRoot, workspace };
}
type Paths = Awaited<ReturnType<typeof fixture>>;

/** A request with its own private invocation directory under `<job>/_private/<role>/<invocation>`. */
async function roleRequest(paths: Paths, role: Role, jobId = jobA): Promise<ProviderRequest> {
  const invocation = randomUUID();
  const base = join(paths.outputRoot, jobId, '_private', role, invocation);
  await mkdir(join(base, 'input'), { recursive: true });
  await mkdir(join(base, 'output'), { recursive: true });
  await writeFile(join(base, 'input', 'prompt.md'), 'prompt');
  return {
    job_id: jobId, issue_key: 'AUTO-17', provider: 'codex', role, cwd: paths.workspace, prompt_path: join(base, 'input', 'prompt.md'), transcript_path: join(base, 'output', 'transcript.jsonl'),
    timeout_ms: 30_000, source_access: role === 'swe' ? 'write' : 'read', auth_profile: 'p', toolchain: { jdk: '25', tomcat: null },
  };
}

interface Seen { role: string; path: string; mode: number; files: string[] }

/** Fake Docker: records the scratch mount of each role run and writes a marker file into it, like a build would. */
class Fake implements DockerExecutor {
  seen: Seen[] = [];
  async run(_binary: string, args: string[]): Promise<DockerProcessResult> {
    if (args[0] !== 'run') return done;
    const role = args[args.indexOf('--role') + 1]!;
    const jobId = args.find((arg) => arg.startsWith('autos.job_id='))!.slice('autos.job_id='.length);
    const scratch = args.find((arg) => arg.endsWith(`,dst=${TOOLCHAIN_MOUNTS.scratch}`))!.match(/^type=bind,src=(.*),dst=/)![1]!;
    const info = await stat(scratch);
    this.seen.push({ role, path: scratch, mode: info.mode & 0o777, files: (await readdir(scratch)).sort() });
    await writeFile(join(scratch, `run-${this.seen.length}`), role);
    const out = args.find((arg) => arg.endsWith(',dst=/run/autos/output'))!.match(/^type=bind,src=(.*),dst=/)![1]!;
    await writeFile(join(out, 'transcript.jsonl'), '{}\n');
    return { ...done, stdout: JSON.stringify({ job_id: jobId, issue_key: 'AUTO-17', result: { provider: 'codex', role, status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: '/run/autos/output/transcript.jsonl', result: { ok: true } } }) };
  }
}

const runnerFor = (paths: Paths, executor: DockerExecutor) =>
  new DockerRunner({ workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot, toolchainRoot: paths.toolchainRoot, executor, testOnly: true });
const exists = (path: string) => lstat(path).then(() => true, () => false);

test('SWE runs of one job reuse a private per-job scratch that survives the run; QA/reviewer get a throwaway one', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    const runner = runnerFor(paths, executor);
    const sweScratch = join(paths.outputRoot, '.scratch', `swe-${jobA}`);
    assert.equal((await runner.runRole(await roleRequest(paths, 'swe'))).status, 'SUCCEEDED');
    assert.equal((await runner.runRole(await roleRequest(paths, 'swe'))).status, 'SUCCEEDED');
    const [first, second] = executor.seen;
    assert.equal(first!.path, sweScratch);
    assert.equal(second!.path, sweScratch);
    assert.equal(first!.mode, 0o700);
    assert.equal(second!.mode, 0o700);
    assert.deepEqual(first!.files, []);
    assert.deepEqual(second!.files, ['run-1'], 'a file written by the first SWE run survives into the second');
    assert.equal((await stat(sweScratch)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(sweScratch), ['run-1', 'run-2']);

    for (const role of ['qa', 'reviewer'] as const) {
      const result = await runner.runRole(await roleRequest(paths, role));
      assert.equal(result.status, 'SUCCEEDED');
      const seen = executor.seen.at(-1)!;
      assert.equal(seen.role, role);
      assert.notEqual(seen.path, sweScratch);
      assert.match(seen.path.slice(join(paths.outputRoot, '.scratch').length + 1), /^[0-9a-f-]{36}$/);
      assert.deepEqual(seen.files, [], `${role} never sees SWE build output`);
      assert.equal(seen.mode, 0o700);
      assert.equal(await exists(seen.path), false, `${role} scratch is removed after the run`);
    }
    assert.deepEqual(await readdir(sweScratch), ['run-1', 'run-2'], 'QA/review runs do not touch the SWE scratch');

    await runner.runRole(await roleRequest(paths, 'swe', jobB));
    const other = executor.seen.at(-1)!;
    assert.equal(other.path, join(paths.outputRoot, '.scratch', `swe-${jobB}`));
    assert.deepEqual(other.files, []);
    assert.deepEqual((await readdir(join(paths.outputRoot, '.scratch'))).sort(), [`swe-${jobA}`, `swe-${jobB}`].sort());
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('SWE job scratch that is a symlink or a file is refused before any container starts', async () => {
  const paths = await fixture();
  try {
    const executor = new Fake();
    const runner = runnerFor(paths, executor);
    const elsewhere = join(paths.root, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(paths.outputRoot, '.scratch'), { recursive: true });
    await symlink(elsewhere, join(paths.outputRoot, '.scratch', `swe-${jobA}`));
    const symlinked = await roleRequest(paths, 'swe');
    await assert.rejects(() => runner.runRole(symlinked), (error: unknown) => error instanceof AutosError && error.code === 'POLICY');
    await writeFile(join(paths.outputRoot, '.scratch', `swe-${jobB}`), 'x');
    const fileBacked = await roleRequest(paths, 'swe', jobB);
    await assert.rejects(() => runner.runRole(fileBacked), (error: unknown) => error instanceof AutosError && error.code === 'POLICY');
    assert.equal(executor.seen.length, 0);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('releaseJobScratch removes the SWE scratch, is idempotent, validates the id and never follows a symlink', async () => {
  const paths = await fixture();
  try {
    const runner = runnerFor(paths, new Fake());
    await runner.runRole(await roleRequest(paths, 'swe'));
    const sweScratch = join(paths.outputRoot, '.scratch', `swe-${jobA}`);
    assert.equal(await exists(sweScratch), true);
    await runner.releaseJobScratch(jobA);
    assert.equal(await exists(sweScratch), false);
    await runner.releaseJobScratch(jobA);
    await runner.releaseJobScratch(jobB);
    for (const bad of ['../x', 'not-a-uuid', '', `${jobA}/..`]) {
      await assert.rejects(() => runner.releaseJobScratch(bad), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
    }

    const target = join(paths.root, 'precious');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'data');
    await symlink(target, sweScratch);
    await runner.releaseJobScratch(jobA);
    assert.equal(await exists(sweScratch), false, 'the planted link itself is removed');
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'data', 'the link target is untouched');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('startup sweep removes SWE job scratch along with per-invocation scratch', async () => {
  const paths = await fixture();
  try {
    const runner = runnerFor(paths, new Fake());
    await runner.runRole(await roleRequest(paths, 'swe'));
    await mkdir(join(paths.outputRoot, '.scratch', randomUUID()));
    const swept = await runner.sweep();
    assert.equal(swept.scratch, 2);
    assert.deepEqual(await readdir(join(paths.outputRoot, '.scratch')), []);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('supervisor release-scratch route and client round-trip', async (t) => {
  const paths = await fixture();
  const runner = runnerFor(paths, new Fake());
  const logs: Record<string, unknown>[] = [];
  const socketPath = join(paths.root, 'rel.sock');
  let server: Awaited<ReturnType<typeof createSupervisorServer>>;
  try { server = await createSupervisorServer({ socketPath, runner, clientRoot: paths.root, hostRoot: paths.root, sweepOnStart: false, log: (record) => logs.push({ ...record }) }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('environment blocks Unix sockets'); await rm(paths.root, { recursive: true, force: true }); return; } throw error; }
  try {
    await runner.runRole(await roleRequest(paths, 'swe'));
    const sweScratch = join(paths.outputRoot, '.scratch', `swe-${jobA}`);
    const client = new DockerRunnerClient({ socketPath });
    await client.releaseJobScratch(jobA);
    assert.equal(await exists(sweScratch), false);
    await client.releaseJobScratch(jobA);
    await assert.rejects(() => client.releaseJobScratch('nope'), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
    // The route validates on its own too, independent of the client-side check.
    const rogue = new DockerRunnerClient({ socketPath }) as unknown as { call: (path: string, body: unknown) => Promise<unknown> };
    await assert.rejects(() => rogue.call('/v1/release-scratch', { jobId: '../etc' }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
    const released = logs.filter((record) => record.action === 'release-scratch');
    assert.equal(released.length, 3);
    assert.deepEqual([released[0]!.job_id, released[0]!.status, released[0]!.http_status], [jobA, 'RELEASED', 200]);
    assert.deepEqual([released[2]!.status, released[2]!.code, released[2]!.http_status], ['ERROR', 'INVALID_INPUT', 400]);
    assert.equal(released[2]!.job_id, undefined);
  } finally { await shutdownSupervisor(server, { waitMs: 500 }); await rm(paths.root, { recursive: true, force: true }); }
});

test('supervisor release-scratch succeeds as a no-op for a runner without releaseJobScratch', async (t) => {
  const paths = await fixture();
  const socketPath = join(paths.root, 'noop.sock');
  const runner = { runRole: async () => { throw new Error('unused'); }, runChecks: async () => { throw new Error('unused'); }, stop: async () => undefined };
  let server: Awaited<ReturnType<typeof createSupervisorServer>>;
  try { server = await createSupervisorServer({ socketPath, runner: runner as never, clientRoot: paths.root, hostRoot: paths.root, sweepOnStart: false, log: () => undefined }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('environment blocks Unix sockets'); await rm(paths.root, { recursive: true, force: true }); return; } throw error; }
  try { await new DockerRunnerClient({ socketPath }).releaseJobScratch(jobA); }
  finally { await shutdownSupervisor(server, { waitMs: 500 }); await rm(paths.root, { recursive: true, force: true }); }
});
