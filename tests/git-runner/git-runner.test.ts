import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, type GitWorkspace, type RepositoryConfig } from '@autos/contracts';
import { GitRunner } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
let root: string;
let bare: string;
let seed: string;
let workspaceRoot: string;
let repository: RepositoryConfig;
let runner: GitRunner;
const jobId = '0a4cefe2-4698-44d9-aa12-f6db43e27b90';

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 10_000_000 });
  return result.stdout.trim();
}

async function setupRemote(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'autos-git-runner-'));
  bare = join(root, 'remote.git');
  seed = join(root, 'seed');
  workspaceRoot = join(root, 'jobs');
  await mkdir(seed);
  await git(root, ['init', '--bare', bare]);
  await git(seed, ['init', '-b', 'local-only']);
  await git(seed, ['config', 'user.name', 'Fixture']);
  await git(seed, ['config', 'user.email', 'fixture@example.test']);
  await mkdir(join(seed, 'src'));
  await writeFile(join(seed, 'src', 'app.txt'), 'development base\n');
  await writeFile(join(seed, 'README.md'), 'fixture\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'seed']);
  await git(seed, ['branch', 'development']);
  await git(seed, ['remote', 'add', 'origin', bare]);
  await git(seed, ['push', 'origin', 'development']);
  repository = {
    workspace: 'demo', repository_slug: 'fixture', remote_url: 'https://bitbucket.org/demo/fixture.git',
    protected_branches: ['main', 'development'], build_profile: 'test',
    allowed_paths: ['src/**', 'README.md'], prohibited_paths: ['.env', '.env.*', 'secrets/**'],
  };
  runner = new GitRunner({
    allowedRepositories: [repository],
    testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }],
  });
}

async function prepare(current = runner): Promise<GitWorkspace> {
  return current.prepare({
    job_id: jobId, issue_key: 'DEMO-42', repository,
    mapping: {
      project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture',
      development_branch: 'development', sandbox_branch: null, enabled: true,
      source: { page_id: '123', version: 1, fetched_at: new Date().toISOString() },
    },
    workspaces_root: workspaceRoot,
  });
}

async function commit(workspace: GitWorkspace, candidate?: Awaited<ReturnType<GitRunner['inspectCandidate']>>) {
  const reviewed = candidate ?? await runner.inspectCandidate(workspace);
  return runner.commit({
    workspace, candidate_digest: reviewed.digest, approved_paths: reviewed.paths,
    message: 'Fix fixture', author: { name: 'Autos', email: 'autos@example.test' },
  });
}

beforeEach(async () => setupRemote());
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('GitRunner', () => {
  it('pins the mapped remote branch even when the seed checkout has another HEAD', async () => {
    const expected = await git(seed, ['rev-parse', 'development']);
    const workspace = await prepare();
    assert.equal(workspace.base_sha, expected);
    assert.equal(workspace.feature_branch, 'deep/DEMO-42');
    assert.equal(await git(workspace.directory, ['branch', '--show-current']), 'deep/DEMO-42');
  });

  it('rejects malformed refs, invalid issue keys, mismatched mappings, and unallowlisted repositories', async () => {
    await assert.rejects(() => runner.prepare({
      job_id: jobId, issue_key: 'demo-42', repository,
      mapping: { project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'development', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() } },
      workspaces_root: workspaceRoot,
    }), { code: 'INVALID_INPUT' });
    await assert.rejects(() => runner.prepare({
      job_id: jobId, issue_key: 'demo-42', repository,
      mapping: { project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'bad..ref', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() } },
      workspaces_root: workspaceRoot,
    }), { code: 'INVALID_INPUT' });
    await assert.rejects(() => runner.prepare({
      job_id: jobId, issue_key: 'DEMO-42', repository: { ...repository, repository_slug: 'other', remote_url: 'https://bitbucket.org/demo/other.git' },
      mapping: { project_key: 'DEMO', workspace: 'demo', repository_slug: 'other', development_branch: 'development', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() } },
      workspaces_root: workspaceRoot,
    }), { code: 'FORBIDDEN' });
  });

  it('refuses a remote feature branch collision and a prohibited candidate path', async () => {
    await git(seed, ['push', 'origin', 'development:refs/heads/deep/DEMO-42']);
    await assert.rejects(() => prepare(), { code: 'BRANCH_COLLISION' });
    await git(bare, ['update-ref', '-d', 'refs/heads/deep/DEMO-42']);
    const workspace = await prepare();
    await writeFile(join(workspace.directory, '.env'), 'secret');
    await assert.rejects(() => runner.inspectCandidate(workspace), { code: 'FORBIDDEN' });
  });

  it('digests modified, new, deleted, and executable-bit changes and refuses escaping symlinks', async () => {
    const workspace = await prepare();
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'changed\n');
    await writeFile(join(workspace.directory, 'src', 'new.txt'), 'new file\n');
    await rm(join(workspace.directory, 'README.md'));
    await chmod(join(workspace.directory, 'src', 'new.txt'), 0o755);
    const first = await runner.inspectCandidate(workspace);
    assert.deepEqual(first.paths, ['README.md', 'src/app.txt', 'src/new.txt']);
    assert.match(first.diff, /new file/);
    const second = await runner.inspectCandidate(workspace);
    assert.equal(first.digest, second.digest);
    await rm(join(workspace.directory, 'src', 'new.txt'));
    await symlink(join(root, 'outside'), join(workspace.directory, 'src', 'escape.txt'));
    await assert.rejects(() => runner.inspectCandidate(workspace), { code: 'POLICY' });
  });

  it('blocks a stale candidate and disables repository hooks before commit', async () => {
    const workspace = await prepare();
    const hookMarker = join(root, 'hook-ran');
    await mkdir(join(workspace.directory, '.git', 'hooks'), { recursive: true });
    const hookPath = join(workspace.directory, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
    await chmod(hookPath, 0o755);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'reviewed\n');
    const candidate = await runner.inspectCandidate(workspace);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'changed after review\n');
    await assert.rejects(() => runner.commit({ workspace, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'Fix', author: { name: 'Autos', email: 'autos@example.test' } }), { code: 'STALE_CANDIDATE' });
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'reviewed\n');
    const result = await commit(workspace, candidate);
    assert.match(result.commit_sha, /^[a-f0-9]{40}$/);
    await assert.rejects(() => readFile(hookMarker));
  });

  it('refuses index flags and Git info metadata changed by an untrusted session', async () => {
    const workspace = await prepare();
    await git(workspace.directory, ['update-index', '--skip-worktree', 'src/app.txt']);
    await assert.rejects(() => runner.inspectCandidate(workspace), { code: 'POLICY' });
  });

  it('keeps push disabled by default, and pushes only the verified feature ref when enabled', async () => {
    const workspace = await prepare();
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'push me\n');
    const result = await commit(workspace);
    assert.deepEqual(await runner.push(workspace, result.commit_sha), { status: 'DISABLED', commit_sha: result.commit_sha });

    const pushingRunner = new GitRunner({ allowedRepositories: [repository], pushEnabled: true, testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });
    const pushingWorkspace = await prepare(pushingRunner);
    await writeFile(join(pushingWorkspace.directory, 'src', 'app.txt'), 'push me too\n');
    const pushingCommit = await pushingRunner.commit({
      workspace: pushingWorkspace, candidate_digest: (await pushingRunner.inspectCandidate(pushingWorkspace)).digest,
      approved_paths: ['src/app.txt'], message: 'Push fix', author: { name: 'Autos', email: 'autos@example.test' },
    });
    const pushed = await pushingRunner.push(pushingWorkspace, pushingCommit.commit_sha);
    assert.deepEqual(pushed, { status: 'PUSHED', commit_sha: pushingCommit.commit_sha });
    assert.equal(await git(bare, ['rev-parse', 'refs/heads/deep/DEMO-42']), pushingCommit.commit_sha);
    assert.equal((await git(bare, ['show-ref', '--verify', 'refs/heads/development'])).split(' ')[0], await git(seed, ['rev-parse', 'development']));
  });

  it('reports push failures without losing the local commit and handles cancellation', async () => {
    const pushingRunner = new GitRunner({ allowedRepositories: [repository], pushEnabled: true, testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });
    const workspace = await prepare(pushingRunner);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'local commit survives\n');
    const candidate = await pushingRunner.inspectCandidate(workspace);
    const result = await pushingRunner.commit({ workspace, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'Keep local commit', author: { name: 'Autos', email: 'autos@example.test' } });
    await rm(bare, { recursive: true, force: true });
    assert.deepEqual(await pushingRunner.push(workspace, result.commit_sha), { status: 'FAILED', commit_sha: result.commit_sha, error_code: 'UPSTREAM' });
    assert.equal(await git(workspace.directory, ['rev-parse', 'HEAD']), result.commit_sha);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => pushingRunner.inspectCandidate(workspace, controller.signal), (error: unknown) => error instanceof AutosError && error.code === 'CANCELLED');
  });

  it('never replaces a feature ref that appears before push', async () => {
    const pushingRunner = new GitRunner({ allowedRepositories: [repository], pushEnabled: true, testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });
    const workspace = await prepare(pushingRunner);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'candidate\n');
    const candidate = await pushingRunner.inspectCandidate(workspace);
    const result = await pushingRunner.commit({ workspace, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'Candidate', author: { name: 'Autos', email: 'autos@example.test' } });
    const collisionSha = await git(seed, ['rev-parse', 'development']);
    await git(seed, ['push', 'origin', 'development:refs/heads/deep/DEMO-42']);
    const outcome = await pushingRunner.push(workspace, result.commit_sha);
    assert.equal(outcome.status, 'FAILED');
    assert.equal((await git(bare, ['show-ref', '--verify', 'refs/heads/deep/DEMO-42'])).split(' ')[0], collisionSha);
    assert.equal(await git(workspace.directory, ['rev-parse', 'HEAD']), result.commit_sha);
  });
});
