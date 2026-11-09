import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type GitWorkspace, type RepositoryConfig } from '@autos/contracts';
import { GitRunner } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
const parentJob = '0a4cefe2-4698-44d9-aa12-f6db43e27b90';
const childJob = '1b5df0f3-5789-45ea-bb23-07ec54f38ca1';
const author = { name: 'Autos', email: 'autos@example.test' };
let root: string; let bare: string; let seed: string; let workspaceRoot: string;
let repository: RepositoryConfig;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 10_000_000 })).stdout.trim();
}
function makeRunner(pushEnabled = true): GitRunner {
  return new GitRunner({ allowedRepositories: [repository], pushEnabled, testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });
}
const mapping = { project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'development', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() } } as const;
const startOf = (w: GitWorkspace): string => (w as GitWorkspace & { start_sha: string }).start_sha;

async function prepareInitial(runner: GitRunner): Promise<GitWorkspace> {
  return runner.prepare({ job_id: parentJob, issue_key: 'DEMO-42', repository, mapping, workspaces_root: workspaceRoot });
}
async function commitAll(runner: GitRunner, workspace: GitWorkspace, message = 'work'): Promise<string> {
  const candidate = await runner.inspectCandidate(workspace);
  return (await runner.commit({ workspace, candidate_digest: candidate.digest, approved_paths: candidate.paths, message, author })).commit_sha;
}
function continuation(parent: GitWorkspace, sha: string, overrides: Record<string, unknown> = {}) {
  return { parent_job_id: parentJob, parent_directory: parent.directory, parent_commit_sha: sha, base_sha: parent.base_sha, development_branch: 'development', ...overrides };
}
async function prepareRevision(runner: GitRunner, parent: GitWorkspace, sha: string, overrides: Record<string, unknown> = {}): Promise<GitWorkspace> {
  return runner.prepare({ job_id: childJob, issue_key: 'DEMO-42', repository, mapping, workspaces_root: workspaceRoot, continue_from: continuation(parent, sha, overrides) } as never);
}
async function reviewed(): Promise<{ parent: GitWorkspace; sha: string }> {
  const runner = makeRunner();
  const parent = await prepareInitial(runner);
  await writeFile(join(parent.directory, 'src', 'app.txt'), 'first pass\n');
  return { parent, sha: await commitAll(runner, parent, 'first') };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-revision-'));
  bare = join(root, 'remote.git'); seed = join(root, 'seed'); workspaceRoot = join(root, 'jobs');
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
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('GitRunner revisions', () => {
  it('continues from the parent commit with the original base after the development branch advanced', async () => {
    const { parent, sha } = await reviewed();
    await git(seed, ['checkout', 'development']);
    await writeFile(join(seed, 'src', 'other.txt'), 'moved on\n');
    await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'advance']);
    await git(seed, ['push', 'origin', 'development']);
    const restarted = makeRunner();
    const child = await prepareRevision(restarted, parent, sha);
    assert.equal(child.base_sha, parent.base_sha);
    assert.equal(startOf(child), sha);
    assert.equal(startOf(parent), parent.base_sha);
    assert.equal(await git(child.directory, ['rev-parse', 'HEAD']), sha);
    assert.equal(await git(child.directory, ['branch', '--show-current']), 'deep/DEMO-42');
    assert.equal(await git(child.directory, ['merge-base', '--is-ancestor', parent.base_sha, 'HEAD']).then(() => 'ok'), 'ok');
    assert.equal(await git(child.directory, ['ls-tree', '--name-only', 'HEAD', 'src/other.txt']), '');
  });

  it('refuses when the pinned base is no longer in development history', async () => {
    const { parent, sha } = await reviewed();
    await git(seed, ['checkout', '--orphan', 'rewritten']);
    await writeFile(join(seed, 'src', 'app.txt'), 'rewritten\n');
    await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'rewrite']);
    await git(seed, ['push', '--force', 'origin', 'rewritten:development']);
    await assert.rejects(() => prepareRevision(makeRunner(), parent, sha), { code: 'CONFLICT' });
  });

  it('refuses a parent commit that does not descend from the base', async () => {
    const { parent } = await reviewed();
    await git(parent.directory, ['checkout', '--quiet', '--orphan', 'unrelated']);
    await writeFile(join(parent.directory, 'src', 'u.txt'), 'x\n');
    await git(parent.directory, ['add', '.']);
    await git(parent.directory, ['-c', 'user.name=T', '-c', 'user.email=t@e.test', 'commit', '-m', 'unrelated']);
    const sha = await git(parent.directory, ['rev-parse', 'HEAD']);
    await git(parent.directory, ['branch', '-f', 'deep/DEMO-42', sha]);
    await git(parent.directory, ['checkout', '--quiet', 'deep/DEMO-42']);
    await assert.rejects(() => prepareRevision(makeRunner(), parent, sha), { code: 'CONFLICT' });
  });

  it('refuses a parent directory outside the root or reached through a symlink', async () => {
    const { parent, sha } = await reviewed();
    const outside = join(root, 'outside');
    await git(root, ['clone', '--quiet', parent.directory, outside]);
    await assert.rejects(() => prepareRevision(makeRunner(), parent, sha, { parent_directory: outside }), { code: 'POLICY' });
    const link = join(workspaceRoot, `${parentJob}-link`);
    await symlink(parent.directory, link);
    await assert.rejects(() => prepareRevision(makeRunner(), parent, sha, { parent_directory: link }), { code: 'POLICY' });
    await assert.rejects(() => prepareRevision(makeRunner(), parent, sha, { parent_job_id: childJob }), { code: 'INVALID_INPUT' });
  });

  it('refuses a stale parent commit and a parent commit with a prohibited path', async () => {
    const { parent, sha } = await reviewed();
    await assert.rejects(() => prepareRevision(makeRunner(), parent, parent.base_sha), { code: 'INVALID_INPUT' });
    await assert.rejects(() => prepareRevision(makeRunner(), parent, 'a'.repeat(40)), { code: 'STALE_CANDIDATE' });
    await mkdir(join(parent.directory, 'secrets'));
    await writeFile(join(parent.directory, 'secrets', 'k.txt'), 'secret\n');
    await git(parent.directory, ['add', '-f', 'secrets/k.txt']);
    await git(parent.directory, ['-c', 'user.name=T', '-c', 'user.email=t@e.test', 'commit', '-m', 'bad']);
    const bad = await git(parent.directory, ['rev-parse', 'HEAD']);
    assert.notEqual(bad, sha);
    await assert.rejects(() => prepareRevision(makeRunner(), parent, bad), { code: 'FORBIDDEN' });
  });

  it('treats a foreign remote feature branch as a collision on prepare and push, leaving the ref alone', async () => {
    const runner = makeRunner();
    const { parent, sha } = await reviewed();
    await git(seed, ['push', 'origin', 'development:refs/heads/deep/DEMO-42']);
    const foreign = await git(bare, ['rev-parse', 'refs/heads/deep/DEMO-42']);
    await assert.rejects(() => prepareRevision(runner, parent, sha), { code: 'BRANCH_COLLISION' });
    // Remote equals parent at prepare time, then someone else moves it before push.
    await git(bare, ['update-ref', '-d', 'refs/heads/deep/DEMO-42']);
    await git(parent.directory, ['push', '--quiet', bare, `${sha}:refs/heads/deep/DEMO-42`]);
    const child = await prepareRevision(runner, parent, sha);
    await writeFile(join(child.directory, 'src', 'app.txt'), 'second pass\n');
    const next = await commitAll(runner, child, 'second');
    await git(bare, ['update-ref', 'refs/heads/deep/DEMO-42', foreign]);
    assert.deepEqual(await runner.push(child, next), { status: 'FAILED', commit_sha: next, error_code: 'BRANCH_COLLISION' });
    assert.equal(await git(bare, ['rev-parse', 'refs/heads/deep/DEMO-42']), foreign);
    assert.equal(await git(child.directory, ['rev-parse', 'HEAD']), next);
  });

  it('creates the feature branch when absent and fast-forwards it when the remote equals the parent commit', async () => {
    const runner = makeRunner();
    const { parent, sha } = await reviewed();
    const child = await prepareRevision(runner, parent, sha);
    await writeFile(join(child.directory, 'src', 'app.txt'), 'second pass\n');
    const next = await commitAll(runner, child, 'second');
    assert.equal((await runner.push(child, next)).status, 'PUSHED');
    assert.equal(await git(bare, ['rev-parse', 'refs/heads/deep/DEMO-42']), next);

    await git(bare, ['update-ref', '-d', 'refs/heads/deep/DEMO-42']);
    await git(parent.directory, ['push', '--quiet', bare, `${sha}:refs/heads/deep/DEMO-42`]);
    const runner2 = makeRunner();
    const again = await prepareRevision(runner2, parent, sha);
    await writeFile(join(again.directory, 'src', 'app.txt'), 'ff\n');
    const ff = await commitAll(runner2, again, 'ff');
    assert.equal((await runner2.push(again, ff)).status, 'PUSHED');
    assert.equal(await git(bare, ['rev-parse', 'refs/heads/deep/DEMO-42']), ff);
    assert.equal(await git(bare, ['merge-base', sha, ff]), sha);
  });

  it('keeps the candidate cumulative against the base while exposing the incremental change', async () => {
    const runner = makeRunner();
    const { parent, sha } = await reviewed();
    const child = await prepareRevision(runner, parent, sha);
    await writeFile(join(child.directory, 'README.md'), 'revised\n');
    await writeFile(join(child.directory, 'src', 'new.txt'), 'new\n');
    const candidate = await runner.inspectCandidate(child);
    assert.deepEqual(candidate.paths, ['README.md', 'src/app.txt', 'src/new.txt']);
    assert.deepEqual(candidate.incremental?.paths, ['README.md', 'src/new.txt']);
    assert.match(candidate.diff, /first pass/);
    assert.doesNotMatch(candidate.incremental?.diff ?? '', /first pass/);
    const initial = await runner.inspectCandidate(parent).catch(() => null);
    assert.equal(initial?.incremental, undefined);
    // Reverting a parent change to the base content drops it from the cumulative candidate.
    await writeFile(join(child.directory, 'src', 'app.txt'), 'development base\n');
    assert.deepEqual((await runner.inspectCandidate(child)).paths, ['README.md', 'src/new.txt']);
  });

  it('commits directly on start_sha, stages only new changes, and refuses stale or empty input', async () => {
    const runner = makeRunner();
    const { parent, sha } = await reviewed();
    const child = await prepareRevision(runner, parent, sha);
    await assert.rejects(() => runner.commit({ workspace: child, candidate_digest: (null as never), approved_paths: [], message: 'x', author }), { code: 'INVALID_INPUT' });
    await writeFile(join(child.directory, 'README.md'), 'revised\n');
    const candidate = await runner.inspectCandidate(child);
    await assert.rejects(() => runner.commit({ workspace: child, candidate_digest: candidate.digest, approved_paths: ['README.md'], message: 'x', author }), { code: 'FORBIDDEN' });
    const result = await runner.commit({ workspace: child, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'revise', author });
    assert.equal(await git(child.directory, ['rev-parse', 'HEAD^']), sha);
    assert.deepEqual(result.paths, ['README.md', 'src/app.txt']);
    assert.equal(await git(child.directory, ['diff', '--name-only', `${sha}`, 'HEAD']), 'README.md');
    assert.equal(await git(child.directory, ['status', '--porcelain']), '');
  });

  it('refuses a commit when HEAD moved off start_sha and when nothing changed', async () => {
    const runner = makeRunner();
    const { parent, sha } = await reviewed();
    const child = await prepareRevision(runner, parent, sha);
    const unchanged = await runner.inspectCandidate(child);
    await assert.rejects(() => runner.commit({ workspace: child, candidate_digest: unchanged.digest, approved_paths: unchanged.paths, message: 'x', author }), { code: 'INVALID_INPUT' });
    await writeFile(join(child.directory, 'README.md'), 'revised\n');
    const candidate = await runner.inspectCandidate(child);
    await git(child.directory, ['reset', '--quiet', '--soft', parent.base_sha]);
    await git(child.directory, ['reset', '--quiet']);
    await assert.rejects(() => runner.commit({ workspace: child, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'x', author }), (e: unknown) => ['POLICY', 'STALE_CANDIDATE'].includes((e as { code: string }).code));
  });

  it('refuses push of an initial attempt when the feature ref exists', async () => {
    const runner = makeRunner();
    const workspace = await prepareInitial(runner);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'x\n');
    const sha = await commitAll(runner, workspace);
    await git(seed, ['push', 'origin', 'development:refs/heads/deep/DEMO-42']);
    assert.equal((await runner.push(workspace, sha)).error_code, 'BRANCH_COLLISION');
  });
});
