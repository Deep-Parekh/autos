import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, afterEach, before, describe, it } from 'node:test';
import { AutosError, type RepositoryConfig } from '@autos/contracts';
import { GitRunner, policyViolationPaths, pruneWorkspaces } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
const jobId = '0a4cefe2-4698-44d9-aa12-f6db43e27b90';
let root: string;
let counter = 0;
let realGit = '';
const originalPath = process.env.PATH;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

const repository: RepositoryConfig = {
  workspace: 'demo', repository_slug: 'fixture', remote_url: 'https://bitbucket.org/demo/fixture.git',
  protected_branches: ['main', 'development'], build_profile: 'test',
  allowed_paths: ['src/**', 'README.md'], prohibited_paths: ['.env', 'secrets/**'],
};
const mapping = {
  project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'development',
  sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() },
};

/** Creates a bare remote whose development branch holds the given files. */
async function makeRemote(files: Record<string, string>, extra?: (seed: string) => Promise<void>): Promise<string> {
  const dir = join(root, `case-${counter++}`);
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await mkdir(seed, { recursive: true });
  await git(dir, ['init', '--bare', bare]);
  await git(seed, ['init', '-b', 'development']);
  await git(seed, ['config', 'user.name', 'F']);
  await git(seed, ['config', 'user.email', 'f@example.test']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  await git(seed, ['add', '-A']);
  if (extra) await extra(seed);
  await git(seed, ['commit', '-m', 'seed']);
  await git(seed, ['remote', 'add', 'origin', bare]);
  await git(seed, ['push', 'origin', 'development']);
  return bare;
}

function runnerFor(bare: string, options: { fetchTimeoutMs?: number } = {}): GitRunner {
  return new GitRunner({ allowedRepositories: [repository], testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }], ...options });
}

function prepare(runner: GitRunner, development_branch = 'development') {
  return runner.prepare({ job_id: jobId, issue_key: 'DEMO-1', repository, mapping: { ...mapping, development_branch }, workspaces_root: join(root, `jobs-${counter++}`) });
}

/** Installs a fake `git` first on PATH that fails network-ish subcommands with the given stderr, otherwise delegates to real git. */
async function installShim(stderr: string, options: { exitCode?: number; sleepSeconds?: number } = {}): Promise<void> {
  const dir = await mkdtemp(join(root, 'shim-'));
  const body = options.sleepSeconds
    ? `exec sleep ${options.sleepSeconds}`
    : `printf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit ${options.exitCode ?? 128}`;
  const script = `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = fetch ] || [ "$a" = ls-remote ]; then\n    ${body}\n  fi\ndone\nexec ${realGit} "$@"\n`;
  await writeFile(join(dir, 'git'), script);
  await chmod(join(dir, 'git'), 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
}

async function failure(promise: Promise<unknown>): Promise<AutosError> {
  try { await promise; } catch (error) { assert.ok(error instanceof AutosError); return error; }
  assert.fail('expected rejection');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-git-diag-'));
  realGit = (await execFile('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim();
});
afterEach(() => { process.env.PATH = originalPath; });
after(async () => { process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); });

describe('git failure classification', () => {
  const secret = 'https://user:s3cr3t-token@bitbucket.org/demo/fixture.git';
  const cases: Array<[string, string, string, boolean]> = [
    [`remote: Authentication failed for '${secret}'`, 'AUTH', 'Git authentication failed for demo/fixture', false],
    ['fatal: could not read Username for \'https://bitbucket.org\': terminal prompts disabled', 'AUTH', 'Git authentication failed for demo/fixture', false],
    ['git@bitbucket.org: Permission denied (publickey).', 'AUTH', 'Git authentication failed for demo/fixture', false],
    ['fatal: unable to access: The requested URL returned error: 403', 'AUTH', 'Git authentication failed for demo/fixture', false],
    ['fatal: repository \'https://bitbucket.org/demo/gone.git/\' not found', 'NOT_FOUND', 'Git repository not found on the remote', false],
    ['fatal: unable to access: The requested URL returned error: 404', 'NOT_FOUND', 'Git repository not found on the remote', false],
    ['fatal: unable to access: Could not resolve host: bitbucket.org', 'UPSTREAM', 'Git remote unreachable', true],
    ['fatal: unable to connect: Connection refused', 'UPSTREAM', 'Git remote unreachable', true],
    ['fatal: something exotic happened', 'UPSTREAM', 'Git operation failed', true],
  ];
  for (const [stderr, code, message, retryable] of cases) {
    it(`${code}: ${stderr.slice(0, 40)}`, async () => {
      const bare = await makeRemote({ 'README.md': 'x\n' });
      await installShim(stderr);
      const error = await failure(prepare(runnerFor(bare)));
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      assert.equal(error.retryable, retryable);
      assert.ok(!/s3cr3t|https?:|stderr/i.test(error.message));
    });
  }

  it('maps a missing development branch to MAPPING', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' });
    const error = await failure(prepare(runnerFor(bare), 'no-such-branch'));
    assert.equal(error.code, 'MAPPING');
    assert.equal(error.message, 'Development branch not found on the remote');
  });

  it('reports a process timeout as retryable TIMEOUT using fetchTimeoutMs', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' });
    await installShim('', { sleepSeconds: 10 });
    const started = Date.now();
    const error = await failure(prepare(runnerFor(bare, { fetchTimeoutMs: 300 })));
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.retryable, true);
    assert.ok(Date.now() - started < 5000);
  });

  it('reports a missing git executable as UNAVAILABLE', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' });
    const runner = runnerFor(bare);
    process.env.PATH = join(root, 'empty-path');
    const error = await failure(prepare(runner));
    assert.equal(error.code, 'UNAVAILABLE');
  });

  it('rejects an invalid fetchTimeoutMs', () => {
    assert.throws(() => new GitRunner({ allowedRepositories: [repository], fetchTimeoutMs: 0 }), { code: 'INVALID_INPUT' });
  });
});

describe('unsupported repository features', () => {
  it('rejects Git LFS repositories at prepare', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n', 'src/.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
    const jobs = join(root, 'lfs-jobs');
    const runner = runnerFor(bare);
    const error = await failure(runner.prepare({ job_id: jobId, issue_key: 'DEMO-1', repository, mapping, workspaces_root: jobs }));
    assert.equal(error.code, 'POLICY');
    assert.equal(error.message, 'Repository uses Git LFS, which Autos does not support yet');
    assert.deepEqual((await (await import('node:fs/promises')).readdir(jobs)), []);
  });

  it('rejects repositories with submodule gitlinks', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' }, async (seed) => {
      await writeFile(join(seed, 'tmp'), 'y');
      const blob = await git(seed, ['hash-object', '-w', 'tmp']);
      await rm(join(seed, 'tmp'));
      // Gitlink pointing at an arbitrary commit id; no .gitmodules needed.
      await git(seed, ['update-index', '--add', '--cacheinfo', `160000,${blob},vendor/lib`]);
    });
    const error = await failure(prepare(runnerFor(bare)));
    assert.equal(error.code, 'POLICY');
    assert.equal(error.message, 'Repository uses submodules, which Autos does not support yet');
  });

  it('rejects repositories with a .gitmodules file', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n', '.gitmodules': '[submodule "a"]\n\tpath = a\n\turl = ../a\n' });
    const error = await failure(prepare(runnerFor(bare)));
    assert.equal(error.code, 'POLICY');
    assert.match(error.message, /submodules/);
  });

  it('accepts a repository with ordinary attributes', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n', '.gitattributes': '* text=auto\n' });
    const workspace = await prepare(runnerFor(bare));
    assert.equal(workspace.feature_branch, 'deep/DEMO-1');
  });
});

describe('policy violation paths', () => {
  it('exposes sanitized offending paths through the guard', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n', 'src/app.txt': 'a\n' });
    const runner = runnerFor(bare);
    const workspace = await prepare(runner);
    await mkdir(join(workspace.directory, 'secrets'));
    await writeFile(join(workspace.directory, 'secrets', 'key.txt'), 'k');
    await writeFile(join(workspace.directory, 'docs.txt'), 'outside');
    await writeFile(join(workspace.directory, 'AGENTS.md'), 'instruction');
    await writeFile(join(workspace.directory, 'src', 'ok.txt'), 'fine');
    const error = await failure(runner.inspectCandidate(workspace));
    assert.equal(error.code, 'FORBIDDEN');
    assert.deepEqual(policyViolationPaths(error), ['AGENTS.md', 'docs.txt', 'secrets/key.txt']);
  });

  it('caps the list at 50 paths and ignores other errors', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' });
    const runner = runnerFor(bare);
    const workspace = await prepare(runner);
    for (let i = 0; i < 60; i++) await writeFile(join(workspace.directory, `out-${String(i).padStart(2, '0')}.txt`), 'x');
    const error = await failure(runner.inspectCandidate(workspace));
    assert.equal(policyViolationPaths(error)?.length, 50);
    assert.equal(policyViolationPaths(new AutosError('FORBIDDEN', 'x')), null);
    assert.equal(policyViolationPaths(new AutosError('POLICY', 'x')), null);
    assert.equal(policyViolationPaths(new Error('x')), null);
    assert.equal(policyViolationPaths(null), null);
  });
});

describe('candidate size limit', () => {
  it('fails clearly with POLICY when the candidate diff is too large', async () => {
    const bare = await makeRemote({ 'README.md': 'x\n' });
    const runner = runnerFor(bare);
    const workspace = await prepare(runner);
    // 65 MiB of untracked bytes exceeds the 64 MiB candidate cap.
    await writeFile(join(workspace.directory, 'src-big.txt'), 'x');
    await mkdir(join(workspace.directory, 'src'));
    await writeFile(join(workspace.directory, 'src', 'big.txt'), Buffer.alloc(65 * 1024 * 1024, 0x61));
    const error = await failure(runner.inspectCandidate(workspace).catch((e: unknown) => {
      // The stray out-of-policy file is reported first; remove it to reach the size check.
      if (policyViolationPaths(e)) return rm(join(workspace.directory, 'src-big.txt')).then(() => runner.inspectCandidate(workspace));
      throw e;
    }));
    assert.equal(error.code, 'POLICY');
    assert.equal(error.message, 'Candidate diff exceeds size limit');
  });
});

describe('pruneWorkspaces', () => {
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  async function fixture() {
    const jobs = await mkdtemp(join(root, 'prune-'));
    const old = new Date(Date.now() - 10 * 24 * 3600_000);
    const names = { oldDir: `${uuid(1)}-${uuid(2)}`, kept: `${uuid(3)}-${uuid(4)}`, fresh: `${uuid(5)}-${uuid(6)}`, link: `${uuid(7)}-${uuid(8)}` };
    for (const name of [names.oldDir, names.kept]) {
      await mkdir(join(jobs, name, '.git'), { recursive: true });
      await writeFile(join(jobs, name, 'f.txt'), 'x');
      for (const p of [join(jobs, name, '.git'), join(jobs, name)]) await utimes(p, old, old);
    }
    await mkdir(join(jobs, names.fresh));
    await mkdir(join(jobs, 'not-canonical'));
    await utimes(join(jobs, 'not-canonical'), old, old);
    const outside = await mkdtemp(join(root, 'outside-'));
    await writeFile(join(outside, 'precious.txt'), 'keep me');
    await symlink(outside, join(jobs, names.link));
    return { jobs, names, outside };
  }
  const exists = (p: string) => stat(p).then(() => true, () => false);

  it('dry run reports without deleting', async () => {
    const { jobs, names } = await fixture();
    const result = await pruneWorkspaces({ workspacesRoot: jobs, keepJobIds: [uuid(3)], olderThanMs: 24 * 3600_000, dryRun: true });
    assert.deepEqual(result.wouldRemove.map((p) => p.split('/').pop()), [names.oldDir]);
    assert.deepEqual(result.removed, []);
    assert.ok(await exists(join(jobs, names.oldDir)));
  });

  it('removes only old, unkept canonical directories and never follows symlinks', async () => {
    const { jobs, names, outside } = await fixture();
    const result = await pruneWorkspaces({ workspacesRoot: jobs, keepJobIds: new Set([uuid(3)]), olderThanMs: 24 * 3600_000 });
    assert.deepEqual(result.removed.map((p) => p.split('/').pop()), [names.oldDir]);
    assert.equal(await exists(join(jobs, names.oldDir)), false);
    assert.ok(await exists(join(jobs, names.kept)));
    assert.ok(await exists(join(jobs, names.fresh)));
    assert.ok(await exists(join(jobs, 'not-canonical')));
    assert.ok(await exists(join(outside, 'precious.txt')));
    assert.ok(result.skipped.some((s) => s.name === names.link && s.reason === 'symlink'));
    assert.ok(result.skipped.some((s) => s.name === names.kept && s.reason === 'kept'));
    assert.ok(result.skipped.some((s) => s.name === names.fresh && s.reason === 'too_new'));
    assert.ok(result.skipped.some((s) => s.name === 'not-canonical' && s.reason === 'not_canonical'));
  });

  it('refuses a symlink even when it would otherwise be eligible', async () => {
    const { jobs, names, outside } = await fixture();
    await pruneWorkspaces({ workspacesRoot: jobs, keepJobIds: [], olderThanMs: 0 });
    assert.ok(await exists(join(outside, 'precious.txt')));
    assert.ok((await import('node:fs/promises').then((m) => m.lstat(join(jobs, names.link)))).isSymbolicLink());
  });

  it('validates the age threshold and tolerates a missing root', async () => {
    await assert.rejects(() => pruneWorkspaces({ workspacesRoot: root, keepJobIds: [], olderThanMs: -1 }), { code: 'INVALID_INPUT' });
    const result = await pruneWorkspaces({ workspacesRoot: join(root, 'nope'), keepJobIds: [], olderThanMs: 0 });
    assert.deepEqual(result.removed, []);
  });
});
