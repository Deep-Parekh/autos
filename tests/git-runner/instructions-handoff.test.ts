import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, HANDOFF_DIR, HANDOFF_MAX_BYTES, type GitWorkspace, type RepositoryConfig } from '@autos/contracts';
import { GitRunner } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
const job = '2c6e0a04-689a-4afb-8c34-18f4c6a2d3e5';
const author = { name: 'Autos', email: 'autos@example.test' };
let root: string; let bare: string; let seed: string; let workspaceRoot: string; let repository: RepositoryConfig;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 10_000_000 })).stdout.trim();
}
const mapping = { project_key: 'DEMO', workspace: 'demo', repository_slug: 'fixture', development_branch: 'development', sandbox_branch: null, enabled: true, source: { page_id: '1', version: 1, fetched_at: new Date().toISOString() } } as const;
const runner = (): GitRunner => new GitRunner({ allowedRepositories: [repository], testOnlyRemoteOverrides: [{ repository: 'demo/fixture', path: bare }] });
const prepare = (r: GitRunner): Promise<GitWorkspace> => r.prepare({ job_id: job, issue_key: 'DEMO-7', repository, mapping, workspaces_root: workspaceRoot });
async function put(base: string, path: string, content: string): Promise<void> {
  const full = join(base, ...path.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}
async function publish(): Promise<void> {
  await git(seed, ['add', '-A']); await git(seed, ['commit', '-m', 'update']);
  await git(seed, ['push', '--force', 'origin', 'development']);
}
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AutosError && error.code === code);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autos-instr-'));
  bare = join(root, 'remote.git'); seed = join(root, 'seed'); workspaceRoot = join(root, 'jobs');
  await mkdir(seed);
  await git(root, ['init', '--bare', bare]);
  await git(seed, ['init', '-b', 'development']);
  await git(seed, ['config', 'user.name', 'Fixture']); await git(seed, ['config', 'user.email', 'fixture@example.test']);
  await git(seed, ['remote', 'add', 'origin', bare]);
  await put(seed, 'AGENTS.md', 'root agents\n');
  await put(seed, 'CLAUDE.md', 'claude\n');
  await put(seed, 'services/api/AGENTS.md', 'nested agents\n');
  await put(seed, '.cursor/rules/style.mdc', 'style\n');
  await put(seed, '.github/copilot-instructions.md', 'copilot\n');
  await put(seed, '.github/instructions/deep/ts.instructions.md', 'ts\n');
  await put(seed, '.claude/rules/a.md', 'rule\n');
  await put(seed, 'README.md', 'readme\n');
  await put(seed, 'docs/agents.md', 'not an instruction file\n');
  await put(seed, 'src/app.txt', 'base\n');
  await git(seed, ['add', '-A']); await git(seed, ['commit', '-m', 'seed']);
  await git(seed, ['push', 'origin', 'development']);
  repository = {
    workspace: 'demo', repository_slug: 'fixture', remote_url: 'https://bitbucket.org/demo/fixture.git',
    protected_branches: ['main', 'development'], build_profile: 'test',
    allowed_paths: ['**'], prohibited_paths: ['.env'],
  };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('readInstructionFiles', () => {
  it('reads instruction files from the commit, never the working tree', async () => {
    const r = runner(); const ws = await prepare(r);
    await writeFile(join(ws.directory, 'AGENTS.md'), 'TAMPERED\n');
    await rm(join(ws.directory, 'CLAUDE.md'));
    const files = await r.readInstructionFiles(ws, ws.base_sha);
    assert.deepEqual(files.map((f) => f.path), [
      '.claude/rules/a.md', '.cursor/rules/style.mdc', '.github/copilot-instructions.md',
      '.github/instructions/deep/ts.instructions.md', 'AGENTS.md', 'CLAUDE.md', 'services/api/AGENTS.md',
    ]);
    assert.equal(files.find((f) => f.path === 'AGENTS.md')!.content, 'root agents\n');
    assert.equal(files.find((f) => f.path === 'CLAUDE.md')!.content, 'claude\n');
    assert.match(files[0]!.blob_sha, /^[a-f0-9]{40}$/);
  });

  it('rejects unknown commits and unprepared workspaces', async () => {
    const r = runner(); const ws = await prepare(r);
    await rejectsWith(r.readInstructionFiles(ws, 'f'.repeat(40)), 'NOT_FOUND');
    await rejectsWith(r.readInstructionFiles(ws, 'nope'), 'INVALID_INPUT');
    await rejectsWith(runner().readInstructionFiles(ws, ws.base_sha), 'FORBIDDEN');
  });

  it('refuses symlinked instruction files', async () => {
    await rm(join(seed, 'AGENTS.md')); await symlink('README.md', join(seed, 'AGENTS.md')); await publish();
    const r = runner(); const ws = await prepare(r);
    await rejectsWith(r.readInstructionFiles(ws, ws.base_sha), 'POLICY');
  });

  it('enforces per-file and total size limits and UTF-8', async () => {
    await put(seed, 'AGENTS.md', 'x'.repeat(64 * 1024 + 1)); await publish();
    let r = runner(); let ws = await prepare(r);
    await rejectsWith(r.readInstructionFiles(ws, ws.base_sha), 'POLICY');
    await rm(join(root, 'jobs'), { recursive: true, force: true });
    await put(seed, 'AGENTS.md', 'ok\n');
    for (let i = 0; i < 9; i++) await put(seed, `pkg${i}/AGENTS.md`, `${i}`.repeat(60 * 1024));
    await publish();
    r = runner(); ws = await prepare(r);
    await rejectsWith(r.readInstructionFiles(ws, ws.base_sha), 'POLICY');
  });

  it('rejects invalid UTF-8', async () => {
    await writeFile(join(seed, 'AGENTS.md'), Buffer.from([0xff, 0xfe, 0x41])); await publish();
    const r = runner(); const ws = await prepare(r);
    await rejectsWith(r.readInstructionFiles(ws, ws.base_sha), 'POLICY');
  });
});

describe('instruction file immutability', () => {
  const cases: Array<[string, (dir: string) => Promise<void>]> = [
    ['editing AGENTS.md', (d) => writeFile(join(d, 'AGENTS.md'), 'changed\n')],
    ['adding a nested AGENTS.md', (d) => put(d, 'src/AGENTS.md', 'new\n')],
    ['deleting CLAUDE.md', (d) => rm(join(d, 'CLAUDE.md'))],
    ['adding a cursor rule', (d) => put(d, '.cursor/rules/new.mdc', 'new\n')],
  ];
  for (const [name, mutate] of cases) {
    it(`refuses ${name} at inspect and commit`, async () => {
      const r = runner(); const ws = await prepare(r);
      await put(ws.directory, 'src/ok.txt', 'fine\n');
      const clean = await r.inspectCandidate(ws);
      await mutate(ws.directory);
      await rejectsWith(r.inspectCandidate(ws), 'FORBIDDEN');
      await rejectsWith(r.commit({ workspace: ws, candidate_digest: clean.digest, approved_paths: clean.paths, message: 'm', author }), 'FORBIDDEN');
    });
  }

  it('refuses instruction changes in revisions (parent commit and new edits)', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, 'src/ok.txt', 'fine\n');
    const c = await r.inspectCandidate(ws);
    const first = (await r.commit({ workspace: ws, candidate_digest: c.digest, approved_paths: c.paths, message: 'm', author })).commit_sha;
    const child = await r.prepare({ job_id: '3d7f1b15-79ab-4b0d-9d45-29a5d7b3e4f6', issue_key: 'DEMO-7', repository, mapping, workspaces_root: workspaceRoot, continue_from: { parent_job_id: job, parent_directory: ws.directory, parent_commit_sha: first, base_sha: ws.base_sha, development_branch: 'development' } } as never);
    await writeFile(join(child.directory, 'services', 'api', 'AGENTS.md'), 'edited\n');
    await rejectsWith(r.inspectCandidate(child), 'FORBIDDEN');
  });

  it('refuses a parent commit that touched an instruction file', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, 'src/ok.txt', 'fine\n');
    await writeFile(join(ws.directory, 'AGENTS.md'), 'sneaky\n');
    await git(ws.directory, ['add', '-A']);
    await git(ws.directory, ['-c', 'user.name=x', '-c', 'user.email=x@x.test', 'commit', '-m', 'forged']);
    const forged = await git(ws.directory, ['rev-parse', 'HEAD']);
    await rejectsWith(r.prepare({ job_id: '4e8a2c26-8abc-4c1e-8e56-3ab6e8c4f507', issue_key: 'DEMO-7', repository, mapping, workspaces_root: workspaceRoot, continue_from: { parent_job_id: job, parent_directory: ws.directory, parent_commit_sha: forged, base_sha: ws.base_sha, development_branch: 'development' } } as never), 'FORBIDDEN');
  });
});

describe('reserved handoff directory', () => {
  it('is ignored by inspectCandidate and never committed', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, 'src/ok.txt', 'fine\n');
    const without = await r.inspectCandidate(ws);
    await put(ws.directory, `${HANDOFF_DIR}/progress.md`, '- [ ] todo\n');
    await put(ws.directory, `${HANDOFF_DIR}/extra/other.txt`, 'x\n');
    const withDir = await r.inspectCandidate(ws);
    assert.equal(withDir.digest, without.digest);
    assert.deepEqual(withDir.paths, without.paths);
    assert.equal(withDir.diff.includes(HANDOFF_DIR), false);
    await rejectsWith(r.commit({ workspace: ws, candidate_digest: without.digest, approved_paths: [...without.paths, `${HANDOFF_DIR}/progress.md`], message: 'm', author }), 'POLICY');
    const commit = await r.commit({ workspace: ws, candidate_digest: without.digest, approved_paths: without.paths, message: 'm', author });
    assert.equal(commit.paths.some((p) => p.startsWith(HANDOFF_DIR)), false);
    assert.equal(await git(ws.directory, ['ls-tree', '-r', '--name-only', commit.commit_sha, '--', HANDOFF_DIR]), '');
  });

  it('is excluded from revision cumulative and incremental views', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, 'src/ok.txt', 'fine\n');
    const c = await r.inspectCandidate(ws);
    const first = (await r.commit({ workspace: ws, candidate_digest: c.digest, approved_paths: c.paths, message: 'm', author })).commit_sha;
    const child = await r.prepare({ job_id: '3d7f1b15-79ab-4b0d-9d45-29a5d7b3e4f6', issue_key: 'DEMO-7', repository, mapping, workspaces_root: workspaceRoot, continue_from: { parent_job_id: job, parent_directory: ws.directory, parent_commit_sha: first, base_sha: ws.base_sha, development_branch: 'development' } } as never);
    await put(child.directory, 'src/more.txt', 'more\n');
    const a = await r.inspectCandidate(child);
    await put(child.directory, `${HANDOFF_DIR}/progress.md`, 'notes\n');
    const b = await r.inspectCandidate(child);
    assert.equal(b.digest, a.digest);
    assert.deepEqual(b.incremental?.paths, a.incremental?.paths);
    assert.equal(b.diff.includes(HANDOFF_DIR), false);
    assert.equal(b.incremental?.diff.includes(HANDOFF_DIR), false);
  });

  it('takeHandoff returns content and removes the directory', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, `${HANDOFF_DIR}/progress.md`, '- [x] a\n');
    await put(ws.directory, `${HANDOFF_DIR}/junk/y.txt`, 'junk\n');
    assert.equal(await r.takeHandoff(ws), '- [x] a\n');
    assert.equal(await exists(join(ws.directory, HANDOFF_DIR)), false);
    assert.equal(await r.takeHandoff(ws), null);
  });

  it('takeHandoff returns null when the directory has no file and removes it', async () => {
    const r = runner(); const ws = await prepare(r);
    await mkdir(join(ws.directory, HANDOFF_DIR, 'sub'), { recursive: true });
    assert.equal(await r.takeHandoff(ws), null);
    assert.equal(await exists(join(ws.directory, HANDOFF_DIR)), false);
  });

  it('truncates oversize handoff files', async () => {
    const r = runner(); const ws = await prepare(r);
    await put(ws.directory, `${HANDOFF_DIR}/progress.md`, 'a'.repeat(HANDOFF_MAX_BYTES + 500));
    const text = (await r.takeHandoff(ws))!;
    assert.equal(text, `${'a'.repeat(HANDOFF_MAX_BYTES)}\n[truncated]`);
    assert.equal(await exists(join(ws.directory, HANDOFF_DIR)), false);
  });

  it('refuses symlinked handoff directory or file without following them', async () => {
    const r = runner(); const ws = await prepare(r);
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'progress.md'), 'secret\n');
    await symlink(outside, join(ws.directory, HANDOFF_DIR));
    await rejectsWith(r.takeHandoff(ws), 'POLICY');
    assert.equal(await exists(join(ws.directory, HANDOFF_DIR)), false);
    assert.equal(await exists(join(outside, 'progress.md')), true);
    await mkdir(join(ws.directory, HANDOFF_DIR));
    await symlink(join(outside, 'progress.md'), join(ws.directory, HANDOFF_DIR, 'progress.md'));
    await rejectsWith(r.takeHandoff(ws), 'POLICY');
    assert.equal(await exists(join(ws.directory, HANDOFF_DIR)), false);
    assert.equal(await exists(join(outside, 'progress.md')), true);
  });

  it('refuses to prepare when the base commit contains the handoff directory', async () => {
    await put(seed, `${HANDOFF_DIR}/progress.md`, 'planted\n'); await publish();
    const r = runner();
    await rejectsWith(prepare(r), 'POLICY');
  });
});
