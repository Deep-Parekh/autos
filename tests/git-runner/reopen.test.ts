// Sealing and re-adopting a prepared workspace for a paused attempt (disposable local repositories only).
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GitWorkspace, ProjectMapping, RepositoryConfig } from '@autos/contracts';
import { GitRunner } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
const jobId = '5b0c2f8e-6f2d-4d0a-9c39-0f3a4a8d1c11';
let root: string; let bare: string; let workspaceRoot: string; let repository: RepositoryConfig;
const mapping: ProjectMapping = { project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'development', sandbox_branch: null, enabled: true, source: { page_id: '123', version: 1, fetched_at: new Date().toISOString() } };
const git = async (cwd: string, args: string[]) => (await execFile('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
const newRunner = () => new GitRunner({ allowedRepositories: [repository], testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-git-reopen-')); bare = join(root, 'remote.git'); workspaceRoot = join(root, 'jobs');
  const seed = join(root, 'seed'); await mkdir(seed);
  await git(root, ['init', '--bare', bare]); await git(seed, ['init', '-b', 'development']);
  await git(seed, ['config', 'user.name', 'Fixture']); await git(seed, ['config', 'user.email', 'fixture@example.test']);
  await mkdir(join(seed, 'src')); await writeFile(join(seed, 'src', 'app.txt'), 'base\n');
  await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'seed']); await git(seed, ['remote', 'add', 'origin', bare]); await git(seed, ['push', 'origin', 'development']);
  repository = { workspace: 'demo', repository_slug: 'fixture', remote_url: 'https://bitbucket.org/demo/fixture.git', protected_branches: ['main', 'development'], build_profile: 'test', allowed_paths: ['src/**'], prohibited_paths: [] };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const prepare = (runner: GitRunner) => runner.prepare({ job_id: jobId, issue_key: 'DEMO-7', repository, mapping, workspaces_root: workspaceRoot });
const reopenRequest = (workspace: GitWorkspace, seal: string) => ({ workspace: { ...workspace }, mapping, workspaces_root: workspaceRoot, seal });

describe('GitRunner seal and reopen', () => {
  it('re-adopts a paused workspace in a new runner (controller restart) with its partial edits and pinned base', async () => {
    const first = newRunner(); const workspace = await prepare(first);
    await writeFile(join(workspace.directory, 'src', 'app.txt'), 'partial fix\n');
    const before = await first.inspectCandidate(workspace); const seal = await first.sealWorkspace(workspace);
    assert.match(seal, /^[a-f0-9]{64}$/);
    // The remote development branch moves on while paused; resuming must not pick it up.
    const other = join(root, 'other'); await git(root, ['clone', '-q', '-b', 'development', bare, other]);
    await git(other, ['-c', 'user.name=x', '-c', 'user.email=x@example.test', 'commit', '--allow-empty', '-m', 'newer dev']); await git(other, ['push', '-q', 'origin', 'development']);
    const second = newRunner();
    await assert.rejects(second.inspectCandidate(workspace), /not prepared by this runner/);
    const reopened = await second.reopen(reopenRequest(workspace, seal));
    assert.equal(reopened.base_sha, workspace.base_sha);
    const after = await second.inspectCandidate(reopened);
    assert.equal(after.digest, before.digest, 'same candidate after resume');
    assert.equal(await second.reopen(reopenRequest(workspace, seal)), reopened, 'reopening twice in one process is idempotent');
  });

  it('refuses a wrong seal, changed Git metadata, a moved directory, and another job', async () => {
    const first = newRunner(); const workspace = await prepare(first); const seal = await first.sealWorkspace(workspace);
    await assert.rejects(newRunner().reopen(reopenRequest(workspace, 'a'.repeat(64))), /changed while the attempt was paused/);
    await assert.rejects(newRunner().reopen({ ...reopenRequest(workspace, seal), workspace: { ...workspace, job_id: '6b0c2f8e-6f2d-4d0a-9c39-0f3a4a8d1c11' } }), /missing or was moved/);
    await assert.rejects(newRunner().reopen({ ...reopenRequest(workspace, seal), mapping: { ...mapping, development_branch: 'other' } }), /Development branch mapping changed/);
    await appendFile(join(workspace.directory, '.git', 'config'), '[core]\n\tfsmonitor = true\n');
    await assert.rejects(newRunner().reopen(reopenRequest(workspace, seal)), /changed while the attempt was paused/);
    await rename(workspace.directory, `${workspace.directory}-moved`);
    await assert.rejects(newRunner().reopen(reopenRequest(workspace, seal)), /missing or was moved/);
  });
});
