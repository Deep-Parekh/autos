import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, readlink, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { minimatch } from 'minimatch';
import {
  AutosError, HANDOFF_DIR, HANDOFF_FILE, HANDOFF_MAX_BYTES, INSTRUCTION_FILE_PATTERNS, branchNameSchema, digestSchema, gitShaSchema, issueKeySchema,
  projectMappingSchema, relativePathSchema, repositoryConfigSchema,
  type GitCandidate, type GitCommitRequest, type GitCommitResult, type GitPrepareRequest,
  type GitPushResult, type GitRunnerPort, type GitWorkspace, type RepositoryConfig, type RepositoryInstructionFile,
} from '@autos/contracts';

const execFile = promisify(execFileCallback);
const shaSchema = gitShaSchema;
const workspaceSchema = z.strictObject({
  job_id: z.uuid(), issue_key: issueKeySchema, repository: repositoryConfigSchema,
  directory: z.string().min(1), base_sha: shaSchema, development_branch: branchNameSchema,
  feature_branch: branchNameSchema, start_sha: shaSchema.optional(),
});
const continuationSchema = z.strictObject({
  parent_job_id: z.uuid(), parent_directory: z.string().min(1), parent_commit_sha: shaSchema,
  base_sha: shaSchema, development_branch: branchNameSchema,
});
const prepareSchema = z.strictObject({
  job_id: z.uuid(), issue_key: issueKeySchema, repository: repositoryConfigSchema,
  mapping: projectMappingSchema, workspaces_root: z.string().min(1),
  continue_from: continuationSchema.optional(),
});
const commitSchema = z.strictObject({
  workspace: workspaceSchema, candidate_digest: digestSchema,
  approved_paths: z.array(z.string().min(1)), message: z.string().min(1).max(1000),
  author: z.strictObject({ name: z.string().min(1).max(200), email: z.string().min(1).max(300) }),
}).refine((r) => !/[\0\r]/.test(r.message) && !/[\0\r\n]/.test(r.author.name) && !/[\0\r\n]/.test(r.author.email));

export interface GitRunnerOptions {
  /** Exact allowlist copied from trusted application configuration. */
  allowedRepositories: RepositoryConfig[];
  /** Push remains off unless the trusted controller explicitly enables it. */
  pushEnabled?: boolean;
  /** Test-only map from exact repository identity to an absolute disposable bare remote. */
  testOnlyRemoteOverrides?: Array<{ repository: string; path: string }>;
  /** Trusted controller-only auth channel; never populated from role or repository data. */
  trustedCredentials?: { gitAskPassPath?: string; sshAuthSocket?: string };
  /** Timeout for fetch/clone operations in milliseconds (default 15 minutes). Other Git calls keep 120 seconds. */
  fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const CANDIDATE_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_VIOLATION_PATHS = 50;

/** Raised when candidate paths violate the repository path policy; carries the sanitized offending paths. */
export class PolicyViolationError extends AutosError {
  readonly paths: string[];
  constructor(message: string, paths: string[]) {
    super('FORBIDDEN', message);
    this.name = 'PolicyViolationError';
    this.paths = sanitizeViolationPaths(paths);
  }
}

/** Repository-relative offending paths (max 50) when the error is a path-policy violation, otherwise null. */
export function policyViolationPaths(error: unknown): string[] | null {
  if (!(error instanceof AutosError) || error.code !== 'FORBIDDEN') return null;
  const paths = (error as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return null;
  return sanitizeViolationPaths(paths as string[]);
}

function sanitizeViolationPaths(paths: string[]): string[] {
  const safe = paths.filter((path) => path.length <= 1024 && relativePathSchema.safeParse(path).success && !/[\u0000-\u001f\u007f]/.test(path));
  return [...new Set(safe)].sort().slice(0, MAX_VIOLATION_PATHS);
}

/** Maps a failed Git process to a safe, authored error. Never includes stderr text, URLs or tokens. */
function classifyGitFailure(e: { code?: number | string; killed?: boolean; signal?: string | null; stderr?: Buffer | string }, label?: string): AutosError {
  if (e.code === 'ENOENT') return new AutosError('UNAVAILABLE', 'Git executable is unavailable');
  if (e.code === 'ETIMEDOUT' || (e.killed === true && e.signal === 'SIGTERM')) return new AutosError('TIMEOUT', 'Git operation timed out', { retryable: true });
  const text = String(e.stderr ?? '');
  if (/authentication failed|\b40[13]\b|could not read (username|password)|permission denied \(publickey|terminal prompts disabled|invalid credentials/i.test(text)) {
    return new AutosError('AUTH', `Git authentication failed for ${label ?? 'the repository'}`);
  }
  if (/couldn't find remote ref|remote branch .* not found/i.test(text)) return new AutosError('MAPPING', 'Development branch not found on the remote');
  if (/repository .*not found|\b404\b/i.test(text)) return new AutosError('NOT_FOUND', 'Git repository not found on the remote');
  if (/could not resolve host|connection refused|connection timed out|operation timed out|network is unreachable|failed to connect|connection reset|temporary failure in name resolution|could not resolve hostname/i.test(text)) {
    return new AutosError('UPSTREAM', 'Git remote unreachable', { retryable: true });
  }
  return new AutosError('UPSTREAM', 'Git operation failed', { retryable: true });
}

export interface PruneWorkspacesOptions {
  workspacesRoot: string;
  keepJobIds: Iterable<string>;
  olderThanMs: number;
  dryRun?: boolean;
}
export interface PruneWorkspacesResult {
  dryRun: boolean;
  /** Directories actually removed (empty on a dry run). */
  removed: string[];
  /** Directories that match the criteria (equals removed unless dryRun). */
  wouldRemove: string[];
  skipped: Array<{ name: string; reason: 'not_canonical' | 'symlink' | 'not_directory' | 'kept' | 'too_new' }>;
}

const WORKSPACE_DIR_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operator helper: removes only canonical `<job-uuid>-<uuid>` workspace directories (never symlinks) not kept and older than the threshold. */
export async function pruneWorkspaces(options: PruneWorkspacesOptions): Promise<PruneWorkspacesResult> {
  if (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0) throw new AutosError('INVALID_INPUT', 'olderThanMs must be a non-negative number');
  const dryRun = options.dryRun === true;
  const root = await realpath(resolve(options.workspacesRoot)).catch(() => null);
  const result: PruneWorkspacesResult = { dryRun, removed: [], wouldRemove: [], skipped: [] };
  if (!root) return result;
  const keep = new Set([...options.keepJobIds].map((id) => id.toLowerCase()));
  const now = Date.now();
  for (const name of (await readdir(root)).sort()) {
    const match = WORKSPACE_DIR_PATTERN.exec(name);
    if (!match) { result.skipped.push({ name, reason: 'not_canonical' }); continue; }
    const directory = join(root, name);
    const info = await lstat(directory).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) { result.skipped.push({ name, reason: 'symlink' }); continue; }
    if (!info.isDirectory()) { result.skipped.push({ name, reason: 'not_directory' }); continue; }
    if (keep.has(match[1]!.toLowerCase())) { result.skipped.push({ name, reason: 'kept' }); continue; }
    let newest = info.mtimeMs;
    for (const inner of ['.git', join('.git', 'index'), join('.git', 'HEAD')]) {
      const innerInfo = await lstat(join(directory, inner)).catch(() => null);
      if (innerInfo && !innerInfo.isSymbolicLink()) newest = Math.max(newest, innerInfo.mtimeMs);
    }
    if (now - newest < options.olderThanMs) { result.skipped.push({ name, reason: 'too_new' }); continue; }
    result.wouldRemove.push(directory);
    if (!dryRun) {
      // rm never follows symbolic links inside the tree.
      await rm(directory, { recursive: true, force: true });
      result.removed.push(directory);
    }
  }
  return result;
}

/** Workspace as returned by prepare(): start_sha is the commit the attempt began from (base_sha for initial attempts). */
type RunnerWorkspace = GitWorkspace & { start_sha?: string };
type CandidateEntry = { path: string; mode: string; content: Buffer };
type RawEntry = CandidateEntry & { rawMode: string };

interface WorkspaceRecord {
  workspace: GitWorkspace;
  startSha: string;
  workspaceRoot: string;
  gitDir: string;
  configDigest: string;
  indexDigest: string;
  infoDigest: string;
  remote: string;
  committedSha?: string;
}

/** Trusted Git operations. This is not a process or filesystem sandbox. */
export class GitRunner implements GitRunnerPort {
  private readonly repositories: Map<string, RepositoryConfig>;
  private readonly pushEnabled: boolean;
  private readonly testRemotes: Map<string, string>;
  private readonly trustedCredentials: GitRunnerOptions['trustedCredentials'];
  private readonly fetchTimeoutMs: number;
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(options: GitRunnerOptions) {
    this.repositories = new Map(options.allowedRepositories.map((repo) => {
      const parsed = repositoryConfigSchema.parse(repo);
      return [repositoryId(parsed), parsed];
    }));
    this.pushEnabled = options.pushEnabled === true;
    const fetchTimeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    if (!Number.isFinite(fetchTimeout) || fetchTimeout <= 0) throw new AutosError('INVALID_INPUT', 'fetchTimeoutMs must be a positive number');
    this.fetchTimeoutMs = fetchTimeout;
    if (options.trustedCredentials?.gitAskPassPath && !isAbsolute(options.trustedCredentials.gitAskPassPath)) throw new AutosError('INVALID_INPUT', 'Git askpass must be an absolute trusted executable path');
    this.trustedCredentials = options.trustedCredentials;
    this.testRemotes = new Map((options.testOnlyRemoteOverrides ?? []).map(({ repository, path }) => {
      if (!repository.includes('/') || !isAbsolute(path)) throw new AutosError('INVALID_INPUT', 'Test remote overrides require an exact repository and absolute path');
      return [repository, resolve(path)];
    }));
  }

  async resolveBase(repository: RepositoryConfig, mapping: GitPrepareRequest['mapping'], signal?: AbortSignal): Promise<{ base_sha: string; development_branch: string }> {
    this.assertAllowedRepository(repository);
    const parsed = projectMappingSchema.safeParse(mapping);
    if (!parsed.success || !parsed.data.enabled || parsed.data.workspace !== repository.workspace || parsed.data.repository_slug !== repository.repository_slug) throw new AutosError('MAPPING', 'Development branch mapping is invalid');
    const remote = this.resolveRemote(repository.remote_url, repositoryId(repository));
    const directory = await mkdtemp(join(tmpdir(), 'autos-remote-read-'));
    try {
      const ref = `refs/heads/${parsed.data.development_branch}`;
      const result = await this.run(['ls-remote', '--heads', remote, ref], { cwd: directory, signal, label: repositoryId(repository) });
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) throw new AutosError('NOT_FOUND', 'Mapped development branch does not exist');
      const fields = lines[0]!.split(/\s+/);
      if (lines.length !== 1 || fields[1] !== ref || !gitShaSchema.safeParse(fields[0]).success) throw new AutosError('UPSTREAM', 'Git returned invalid branch metadata');
      return { base_sha: fields[0]!, development_branch: parsed.data.development_branch };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async prepare(raw: GitPrepareRequest, signal?: AbortSignal): Promise<GitWorkspace> {
    const request = prepareSchema.safeParse(raw);
    if (!request.success) throw new AutosError('INVALID_INPUT', 'Invalid Git prepare request');
    const { job_id, issue_key, repository, mapping, workspaces_root, continue_from: continuation } = request.data;
    this.assertAllowedRepository(repository);
    if (!mapping.enabled || mapping.workspace !== repository.workspace || mapping.repository_slug !== repository.repository_slug || !issueKeySchema.parse(issue_key).startsWith(`${mapping.project_key}-`)) {
      throw new AutosError('FORBIDDEN', 'Project mapping does not authorize this repository and issue');
    }
    const developmentBranch = mapping.development_branch;
    branchNameSchema.parse(developmentBranch);
    const featureBranch = `deep/${issue_key}`;
    branchNameSchema.parse(featureBranch);
    if (repository.protected_branches.includes(featureBranch)) throw new AutosError('POLICY', 'Feature branch matches a protected branch');
    let remote = this.resolveRemote(repository.remote_url, repositoryId(repository));
    if (this.testRemotes.has(repositoryId(repository))) {
      const canonical = await realpath(remote).catch(() => null);
      const info = canonical ? await lstat(canonical).catch(() => null) : null;
      if (!canonical || !info?.isDirectory()) throw new AutosError('POLICY', 'Test remote must be an existing local directory');
      remote = canonical;
    }
    const requestedRoot = resolve(workspaces_root);
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(requestedRoot);
    if (continuation) {
      if (continuation.parent_job_id === job_id) throw new AutosError('INVALID_INPUT', 'A revision needs a different parent job');
      if (continuation.development_branch !== developmentBranch) throw new AutosError('MAPPING', 'Revision development branch does not match the mapping');
      if (continuation.parent_commit_sha === continuation.base_sha) throw new AutosError('INVALID_INPUT', 'The parent commit must differ from its base');
      await this.assertParentDirectory(continuation.parent_directory, continuation.parent_job_id, root);
    }
    const directory = join(root, `${job_id}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    try {
      await this.run(['init', '--quiet', directory], { cwd: root, signal });
      const gitDir = await this.gitDir(directory, signal);
      await this.run(['-C', directory, 'remote', 'add', 'origin', remote], { cwd: root, signal });
      await this.run(['-C', directory, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${developmentBranch}:refs/remotes/origin/${developmentBranch}`], { cwd: root, signal, timeoutMs: this.fetchTimeoutMs, label: repositoryId(repository) });
      const developmentHead = (await this.run(['-C', directory, 'rev-parse', `refs/remotes/origin/${developmentBranch}^{commit}`], { cwd: root, signal })).stdout.trim();
      if (!shaSchema.safeParse(developmentHead).success) throw new AutosError('UPSTREAM', 'Git returned an invalid base revision');
      // Initial attempts pin the fetched head; revisions keep the reviewed base even if the development branch moved.
      const baseSha = continuation ? continuation.base_sha : developmentHead;
      let startSha = baseSha;
      if (continuation) {
        const reachable = await this.run(['-C', directory, 'merge-base', '--is-ancestor', baseSha, developmentHead], { cwd: root, signal, allowExitCodes: [1, 128] });
        if (reachable.code !== 0) throw new AutosError('CONFLICT', 'The reviewed base is no longer part of the development branch history');
        await this.fetchParentCommit(directory, root, continuation, featureBranch, signal);
        startSha = continuation.parent_commit_sha;
        await this.assertRevisionFeatureRef(directory, featureBranch, startSha, signal);
        for (const sha of new Set([baseSha, startSha])) await this.assertSupportedRepository(directory, sha, root, signal);
        await this.run(['-C', directory, 'checkout', '--quiet', '-b', featureBranch, startSha], { cwd: root, signal });
      } else {
        await this.assertNoFeatureCollision(directory, featureBranch, signal, repositoryId(repository));
        await this.assertSupportedRepository(directory, baseSha, root, signal);
        await this.run(['-C', directory, 'checkout', '--quiet', '-b', featureBranch, baseSha], { cwd: root, signal });
      }
      for (const sha of new Set([baseSha, startSha])) await this.assertNoHandoffInTree(directory, sha, root, signal);
      const stableRepository = Object.freeze({
        ...repository,
        protected_branches: Object.freeze([...repository.protected_branches]),
        allowed_paths: Object.freeze([...repository.allowed_paths]),
        prohibited_paths: Object.freeze([...repository.prohibited_paths]),
      }) as RepositoryConfig;
      const workspace: RunnerWorkspace = Object.freeze({ job_id, issue_key, repository: stableRepository, directory, base_sha: baseSha, development_branch: developmentBranch, feature_branch: featureBranch, start_sha: startSha });
      if (continuation) {
        // Re-check the materialized parent paths (symlink containment) with the same policy as candidates.
        for (const path of await this.parentPaths(directory, baseSha, startSha, workspace.repository, signal)) {
          await this.workingEntry(workspace, path);
        }
      }
      const configDigest = await this.gitConfigDigest(directory);
      const metadata = await this.metadataDigests(directory);
      this.records.set(directory, { workspace, startSha, workspaceRoot: root, gitDir, configDigest, ...metadata, remote });
      return workspace;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async inspectCandidate(workspace: GitWorkspace, signal?: AbortSignal): Promise<GitCandidate> {
    await this.verifyWorkspace(workspace, signal);
    this.throwIfAborted(signal);
    const status = await this.run(['-C', workspace.directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'], { cwd: workspace.directory, signal, maxBuffer: CANDIDATE_MAX_BUFFER, candidateOutput: true });
    const staged = await this.run(['-C', workspace.directory, 'diff', '--cached', '--quiet', 'HEAD'], { cwd: workspace.directory, signal, allowExitCodes: [0, 1] });
    if (staged.code !== 0) throw new AutosError('POLICY', 'Pre-staged changes are not allowed');
    const statusPaths = this.parseStatus(status.stdout).filter((path) => !isHandoffPath(path));
    this.assertPolicyPaths(statusPaths, workspace.repository);
    const entries: CandidateEntry[] = [];
    for (const path of statusPaths) entries.push(await this.workingEntry(workspace, path));
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const untracked = await this.untrackedDiff(workspace.directory, this.untrackedPaths(status.stdout).filter((path) => !isHandoffPath(path)), signal);
    const incrementalDiff = (await this.run(['-C', workspace.directory, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', ...statusPaths], { cwd: workspace.directory, signal, maxBuffer: CANDIDATE_MAX_BUFFER, candidateOutput: true })).stdout + untracked;
    if (startOf(workspace) === workspace.base_sha) {
      // Digest and paths cover binary/new/deleted files even when Git's textual diff is empty.
      return { digest: digestEntries(entries, workspace), paths: statusPaths, diff: incrementalDiff };
    }
    // Revision: the cumulative candidate (what is handed off) is everything that differs from the pinned base.
    const merged = new Map<string, CandidateEntry>();
    const committedEntries = (await this.rawDiffEntries(workspace.directory, ['diff', '--raw', '--abbrev=40', '-z', '--no-renames', '-r', workspace.base_sha, 'HEAD'], signal)).filter((e) => !isHandoffPath(e.path));
    this.assertPolicyPaths(committedEntries.map((e) => e.path), workspace.repository);
    for (const entry of committedEntries) merged.set(entry.path, entry);
    for (const entry of entries) merged.set(entry.path, entry);
    const cumulative: CandidateEntry[] = [];
    for (const entry of merged.values()) {
      const original = await this.baseEntry(workspace, entry.path, signal);
      const unchanged = original ? original.mode === entry.mode && original.content.equals(entry.content) : entry.mode === 'deleted';
      if (!unchanged) cumulative.push({ path: entry.path, mode: entry.mode, content: entry.content });
    }
    cumulative.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const paths = cumulative.map((entry) => entry.path);
    const diff = paths.length ? (await this.run(['-C', workspace.directory, 'diff', '--no-ext-diff', '--no-textconv', '--binary', workspace.base_sha, '--', ...paths], { cwd: workspace.directory, signal, maxBuffer: CANDIDATE_MAX_BUFFER, candidateOutput: true })).stdout : '';
    return { digest: digestEntries(cumulative, workspace), paths, diff: diff + untracked, incremental: { paths: statusPaths, diff: incrementalDiff } };
  }

  async commit(raw: GitCommitRequest, signal?: AbortSignal): Promise<GitCommitResult> {
    const parsed = commitSchema.safeParse(raw);
    if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Invalid Git commit request');
    const request = { ...parsed.data, workspace: raw.workspace };
    const workspace = raw.workspace;
    await this.verifyWorkspace(workspace, signal);
    const current = await this.inspectCandidate(workspace, signal);
    if (current.digest !== request.candidate_digest) throw new AutosError('STALE_CANDIDATE', 'Candidate changed after review');
    const approved = [...new Set(request.approved_paths)].sort();
    if (approved.some(isHandoffPath)) throw new AutosError('POLICY', 'The reserved handoff directory can never be committed');
    if (approved.length !== request.approved_paths.length || approved.join('\0') !== [...current.paths].sort().join('\0')) throw new AutosError('FORBIDDEN', 'Approved paths must exactly match the current candidate');
    this.assertPolicyPaths(approved, workspace.repository);
    this.throwIfAborted(signal);
    const fresh = await this.inspectCandidate(workspace, signal);
    if (fresh.digest !== request.candidate_digest || fresh.paths.join('\0') !== current.paths.join('\0')) throw new AutosError('STALE_CANDIDATE', 'Candidate changed before commit');
    if (approved.length === 0) throw new AutosError('INVALID_INPUT', 'Cannot commit an empty candidate');
    // Stage only what changed since the attempt's start; for initial attempts that equals the approved paths.
    const stagePaths = current.incremental ? current.incremental.paths : approved;
    if (stagePaths.length === 0) throw new AutosError('INVALID_INPUT', 'Cannot commit a revision without new changes');
    const startSha = startOf(workspace);
    const headBefore = (await this.run(['-C', workspace.directory, 'rev-parse', 'HEAD^{commit}'], { cwd: workspace.directory, signal })).stdout.trim();
    if (headBefore !== startSha) throw new AutosError('STALE_CANDIDATE', 'Workspace no longer points to its starting revision');
    await this.run(['-C', workspace.directory, 'add', '--', ...stagePaths], { cwd: workspace.directory, signal });
    // The index is compared with the pinned base so revisions still bind the cumulative handoff.
    const staged = await this.digestRawDiff(workspace.directory, ['diff', '--cached', '--raw', '--abbrev=40', '-z', '--no-renames', '-r', workspace.base_sha, '--', ...approved], approved, signal);
    if (staged.digest !== request.candidate_digest || staged.paths.join('\0') !== approved.join('\0')) throw new AutosError('STALE_CANDIDATE', 'Staged content differs from the reviewed candidate');
    const record = this.records.get(workspace.directory);
    if (!record) throw new AutosError('FORBIDDEN', 'Git workspace was not prepared by this runner');
    Object.assign(record, await this.metadataDigests(workspace.directory));
    const stagedAgain = await this.digestRawDiff(workspace.directory, ['diff', '--cached', '--raw', '--abbrev=40', '-z', '--no-renames', '-r', workspace.base_sha, '--', ...approved], approved, signal);
    const metadataAgain = await this.metadataDigests(workspace.directory);
    if (stagedAgain.digest !== request.candidate_digest || metadataAgain.indexDigest !== record.indexDigest || metadataAgain.infoDigest !== record.infoDigest) throw new AutosError('STALE_CANDIDATE', 'Git index changed before commit');
    const env = this.gitEnv(workspace.directory, {
      GIT_AUTHOR_NAME: request.author.name, GIT_AUTHOR_EMAIL: request.author.email,
      GIT_COMMITTER_NAME: request.author.name, GIT_COMMITTER_EMAIL: request.author.email,
    });
    await this.run(['-C', workspace.directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--no-verify', '-m', request.message], { cwd: workspace.directory, signal, env });
    const sha = (await this.run(['-C', workspace.directory, 'rev-parse', 'HEAD^{commit}'], { cwd: workspace.directory, signal })).stdout.trim();
    if (!shaSchema.safeParse(sha).success) throw new AutosError('INTERNAL', 'Git returned an invalid commit revision');
    const parents = (await this.run(['-C', workspace.directory, 'rev-list', '--parents', '-n', '1', sha], { cwd: workspace.directory, signal })).stdout.trim().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== startSha) throw new AutosError('CONFLICT', 'Committed revision does not descend directly from its starting revision');
    const committed = await this.digestRawDiff(workspace.directory, ['diff', '--raw', '--abbrev=40', '-z', '--no-renames', '-r', workspace.base_sha, sha, '--', ...approved], approved, signal);
    if (committed.digest !== request.candidate_digest || committed.paths.join('\0') !== approved.join('\0')) throw new AutosError('CONFLICT', 'Committed tree differs from the reviewed candidate');
    const clean = await this.run(['-C', workspace.directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace.directory, signal });
    if (this.parseStatusLoose(clean.stdout).some((path) => !isHandoffPath(path))) throw new AutosError('CONFLICT', 'Workspace changed during commit');
    await this.assertNoHandoffInTree(workspace.directory, sha, workspace.directory, signal);
    const committedPaths = committed.paths;
    record.committedSha = sha;
    Object.assign(record, await this.metadataDigests(workspace.directory));
    return { commit_sha: sha, candidate_digest: current.digest, paths: committedPaths };
  }

  async push(workspace: GitWorkspace, commitSha: string, signal?: AbortSignal): Promise<GitPushResult> {
    if (!this.pushEnabled) return { status: 'DISABLED', commit_sha: commitSha };
    if (!shaSchema.safeParse(commitSha).success) throw new AutosError('INVALID_INPUT', 'Invalid commit revision');
    try {
      const record = await this.verifyWorkspace(workspace, signal);
      if (record.committedSha !== commitSha) throw new AutosError('FORBIDDEN', 'Only this workspace commit may be pushed');
      const head = (await this.run(['-C', workspace.directory, 'rev-parse', 'HEAD^{commit}'], { cwd: workspace.directory, signal })).stdout.trim();
      if (head !== commitSha) throw new AutosError('STALE_CANDIDATE', 'Workspace no longer points to the approved commit');
      const ref = `refs/heads/${workspace.feature_branch}`;
      const remoteValue = await this.remoteRefValue(workspace.directory, ref, signal);
      const startSha = record.startSha;
      let lease = '';
      if (remoteValue !== null) {
        // Only a revision may update an existing ref, and only from exactly the commit it started from.
        if (startSha === workspace.base_sha || remoteValue !== startSha) throw new AutosError('BRANCH_COLLISION', 'Feature branch already exists remotely');
        const descends = await this.run(['-C', workspace.directory, 'merge-base', '--is-ancestor', startSha, commitSha], { cwd: workspace.directory, signal, allowExitCodes: [1, 128] });
        if (descends.code !== 0) throw new AutosError('BRANCH_COLLISION', 'Revision is not a fast-forward of the remote feature branch');
        lease = startSha;
      }
      // Lease is the exact expected remote value: empty (create-only) or the revision's start commit (fast-forward only).
      // Never use plain --force, a + refspec, or a lease that permits arbitrary replacement.
      await this.run(['-C', workspace.directory, 'push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${lease}`, 'origin', `${commitSha}:${ref}`], { cwd: workspace.directory, signal, timeoutMs: this.fetchTimeoutMs, label: repositoryId(workspace.repository) });
      return { status: 'PUSHED', commit_sha: commitSha };
    } catch (error) {
      // Preserve the local commit and never surface raw Git output or credential-bearing remote data.
      const code = error instanceof AutosError ? error.code : signal?.aborted ? 'CANCELLED' : 'UPSTREAM';
      return { status: 'FAILED', commit_sha: commitSha, error_code: code };
    }
  }

  async readInstructionFiles(workspace: GitWorkspace, commitSha: string, signal?: AbortSignal): Promise<RepositoryInstructionFile[]> {
    const record = await this.knownWorkspace(workspace);
    if (!shaSchema.safeParse(commitSha).success) throw new AutosError('INVALID_INPUT', 'Invalid commit revision');
    // The commit must be the trusted attempt start, its committed result, or one of their ancestors (immutable by hash).
    const anchors = [record.startSha, ...(record.committedSha ? [record.committedSha] : [])];
    let reachable = false;
    for (const anchor of anchors) {
      const result = await this.run(['-C', workspace.directory, 'merge-base', '--is-ancestor', `${commitSha}^{commit}`, anchor], { cwd: workspace.directory, signal, allowExitCodes: [1, 128] });
      if (result.code === 0) { reachable = true; break; }
    }
    if (!reachable) throw new AutosError('NOT_FOUND', 'Commit is not part of this workspace history');
    const listed = await this.run(['-C', workspace.directory, 'ls-tree', '-r', '-l', '-z', '--full-tree', commitSha], { cwd: workspace.directory, signal });
    const matches: Array<{ path: string; blob: string; size: number }> = [];
    for (const line of listed.stdout.split('\0')) {
      if (!line) continue;
      const match = /^([0-7]{6}) (\w+) ([a-f0-9]{40}) +(\d+|-)\t([\s\S]+)$/.exec(line);
      if (!match) throw new AutosError('POLICY', 'Git returned malformed tree metadata');
      const path = match[5]!;
      if (!isInstructionPath(path)) continue;
      if (match[1] !== '100644' && match[1] !== '100755' || match[2] !== 'blob') throw new AutosError('POLICY', 'Repository instruction file is not a regular file');
      if (!relativePathSchema.safeParse(path).success) throw new AutosError('POLICY', 'Repository instruction file has an unsafe path');
      matches.push({ path, blob: match[3]!, size: Number(match[4]) });
    }
    matches.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    let total = 0;
    for (const item of matches) {
      if (!Number.isFinite(item.size) || item.size > INSTRUCTION_FILE_MAX_BYTES) throw new AutosError('POLICY', 'Repository instruction file exceeds the size limit');
      total += item.size;
      if (total > INSTRUCTION_TOTAL_MAX_BYTES) throw new AutosError('POLICY', 'Repository instruction files exceed the total size limit');
    }
    const files: RepositoryInstructionFile[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (const item of matches) {
      const bytes = await this.readBlob(workspace.directory, item.blob, signal);
      if (bytes.length > INSTRUCTION_FILE_MAX_BYTES) throw new AutosError('POLICY', 'Repository instruction file exceeds the size limit');
      let content: string;
      try { content = decoder.decode(bytes); } catch { throw new AutosError('POLICY', 'Repository instruction file is not valid UTF-8'); }
      files.push({ path: item.path, blob_sha: item.blob, content });
    }
    return files;
  }

  async takeHandoff(workspace: GitWorkspace, signal?: AbortSignal): Promise<string | null> {
    await this.knownWorkspace(workspace);
    this.throwIfAborted(signal);
    const dir = join(workspace.directory, HANDOFF_DIR);
    const file = join(workspace.directory, ...HANDOFF_FILE.split('/'));
    const dirInfo = await lstat(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(new AutosError('UPSTREAM', 'Handoff directory could not be inspected')));
    if (!dirInfo) return null;
    try {
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new AutosError('POLICY', 'Handoff path is not a real directory');
      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(new AutosError('UPSTREAM', 'Handoff file could not be inspected')));
      if (!info) return null;
      if (info.isSymbolicLink() || !info.isFile()) throw new AutosError('POLICY', 'Handoff file is not a regular file');
      let handle;
      try { handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new AutosError('POLICY', 'Handoff file could not be opened safely'); }
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new AutosError('POLICY', 'Handoff file is not a regular file');
        const buffer = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const truncated = filled > HANDOFF_MAX_BYTES;
        const text = buffer.subarray(0, Math.min(filled, HANDOFF_MAX_BYTES)).toString('utf8');
        return truncated ? `${text}\n[truncated]` : text;
      } finally {
        await handle.close();
      }
    } finally {
      // rm never follows symbolic links; a link is unlinked itself.
      await rm(dir, { recursive: true, force: true });
      if (await lstat(dir).then(() => true, () => false)) throw new AutosError('INTERNAL', 'Handoff directory could not be removed');
    }
  }

  /** Light validation (no head/index checks): the workspace was prepared by this runner and still lives at its canonical path. */
  private async knownWorkspace(workspace: GitWorkspace): Promise<WorkspaceRecord> {
    const parsed = workspaceSchema.safeParse(workspace);
    if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Invalid Git workspace');
    this.assertAllowedRepository(parsed.data.repository);
    const record = this.records.get(workspace.directory);
    if (!record || !sameWorkspace(record.workspace, workspace) || startOf(workspace) !== record.startSha) throw new AutosError('FORBIDDEN', 'Git workspace was not prepared by this runner');
    const real = await realpath(workspace.directory).catch(() => null);
    if (real !== workspace.directory || !this.isWithin(record.workspaceRoot, real)) throw new AutosError('POLICY', 'Git workspace path is invalid');
    return record;
  }

  /** Rejects Git LFS and submodules from the pinned commit's tree before any workspace branch exists. */
  private async assertSupportedRepository(directory: string, sha: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const listed = await this.run(['-C', directory, 'ls-tree', '-r', '-z', '--full-tree', sha], { cwd, signal, maxBuffer: 256 * 1024 * 1024 });
    const attributeBlobs: string[] = [];
    let submodules = false;
    for (const line of listed.stdout.split('\0')) {
      if (!line) continue;
      const match = /^([0-7]{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
      if (!match) throw new AutosError('POLICY', 'Git returned malformed tree metadata');
      const path = match[4]!;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (match[1] === '160000' || name === '.gitmodules') submodules = true;
      if (name === '.gitattributes' && match[2] === 'blob') attributeBlobs.push(match[3]!);
    }
    if (submodules) throw new AutosError('POLICY', 'Repository uses submodules, which Autos does not support yet');
    for (const blob of attributeBlobs) {
      const text = (await this.readBlob(directory, blob, signal)).toString('utf8');
      if (/(^|\s)filter=lfs(\s|$)/m.test(text)) throw new AutosError('POLICY', 'Repository uses Git LFS, which Autos does not support yet');
    }
  }

  private async assertNoHandoffInTree(directory: string, sha: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const listed = await this.run(['-C', directory, 'ls-tree', '-z', '--full-tree', sha, '--', HANDOFF_DIR], { cwd, signal });
    if (listed.stdout.split('\0').some(Boolean)) throw new AutosError('POLICY', 'Repository contains the reserved handoff directory');
  }

  private parseStatusLoose(output: string): string[] {
    const fields = output.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < fields.length;) {
      const entry = fields[i++] ?? '';
      if (!entry) continue;
      paths.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') { const second = fields[i++]; if (second) paths.push(second); }
    }
    return paths;
  }

  private async verifyWorkspace(workspace: GitWorkspace, signal?: AbortSignal): Promise<WorkspaceRecord> {
    const parsed = workspaceSchema.safeParse(workspace);
    if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Invalid Git workspace');
    this.assertAllowedRepository(parsed.data.repository);
    const record = this.records.get(workspace.directory);
    if (!record || !sameWorkspace(record.workspace, workspace) || startOf(workspace) !== record.startSha) throw new AutosError('FORBIDDEN', 'Git workspace was not prepared by this runner');
    const real = await realpath(workspace.directory).catch(() => null);
    if (real !== workspace.directory || !this.isWithin(record.workspaceRoot, real)) throw new AutosError('POLICY', 'Git workspace path is invalid');
    const gitDir = await this.gitDir(workspace.directory, signal);
    if (gitDir !== record.gitDir || await this.gitConfigDigest(workspace.directory) !== record.configDigest) throw new AutosError('POLICY', 'Git metadata changed after workspace preparation');
    const metadata = await this.metadataDigests(workspace.directory);
    if (metadata.indexDigest !== record.indexDigest || metadata.infoDigest !== record.infoDigest) throw new AutosError('POLICY', 'Git index or metadata changed after workspace preparation');
    const head = (await this.run(['-C', workspace.directory, 'rev-parse', 'HEAD^{commit}'], { cwd: workspace.directory, signal })).stdout.trim();
    const branch = (await this.run(['-C', workspace.directory, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: workspace.directory, signal })).stdout.trim();
    const expected = record.committedSha ?? record.startSha;
    if (head !== expected || branch !== workspace.feature_branch) throw new AutosError('STALE_CANDIDATE', 'Git branch or revision changed unexpectedly');
    const origin = (await this.run(['-C', workspace.directory, 'remote', 'get-url', 'origin'], { cwd: workspace.directory, signal })).stdout.trim();
    if (origin !== record.remote) throw new AutosError('POLICY', 'Git remote changed after workspace preparation');
    return record;
  }

  private assertAllowedRepository(repository: RepositoryConfig): void {
    const parsed = repositoryConfigSchema.safeParse(repository);
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(this.repositories.get(repositoryId(parsed.data)))) throw new AutosError('FORBIDDEN', 'Repository is not in the configured allowlist');
  }

  private resolveRemote(remote: string, identity: string): string {
    const testOverride = this.testRemotes.get(identity);
    if (testOverride) return testOverride;
    let parsed: URL | null = null;
    try { parsed = new URL(remote); } catch { /* checked below */ }
    if (parsed && parsed.protocol === 'https:' && parsed.hostname === 'bitbucket.org' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.git$/.test(parsed.pathname)) return remote;
    const ssh = /^git@bitbucket\.org:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.git$/.exec(remote);
    if (ssh) return remote;
    throw new AutosError('POLICY', 'Repository remote is not an approved Bitbucket URL');
  }

  private async assertNoFeatureCollision(directory: string, branch: string, signal?: AbortSignal, label?: string): Promise<void> {
    const local = await this.run(['-C', directory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: directory, signal, allowExitCodes: [0, 1] });
    if (local.code === 0) throw new AutosError('BRANCH_COLLISION', 'Feature branch already exists locally');
    const remoteList = await this.run(['-C', directory, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: directory, signal, label });
    if (remoteList.stdout.trim()) throw new AutosError('BRANCH_COLLISION', 'Feature branch already exists remotely');
  }

  private async remoteRefValue(directory: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    const list = await this.run(['-C', directory, 'ls-remote', '--heads', 'origin', ref], { cwd: directory, signal });
    const lines = list.stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const fields = lines[0]!.split(/\s+/);
    if (lines.length !== 1 || fields[1] !== ref || !shaSchema.safeParse(fields[0]).success) throw new AutosError('UPSTREAM', 'Git returned invalid branch metadata');
    return fields[0]!;
  }

  private async assertRevisionFeatureRef(directory: string, branch: string, parentSha: string, signal?: AbortSignal): Promise<void> {
    const value = await this.remoteRefValue(directory, `refs/heads/${branch}`, signal);
    if (value !== null && value !== parentSha) throw new AutosError('BRANCH_COLLISION', 'Feature branch changed remotely after the reviewed commit');
  }

  private async assertParentDirectory(parentDirectory: string, parentJobId: string, root: string): Promise<void> {
    const canonical = await realpath(parentDirectory).catch(() => null);
    if (!isAbsolute(parentDirectory) || !canonical || canonical !== parentDirectory || !this.isWithin(root, canonical) || canonical === root) throw new AutosError('POLICY', 'Parent workspace must be a canonical directory inside the workspaces root');
    if (dirname(canonical) !== root || !basename(canonical).startsWith(`${parentJobId}-`)) throw new AutosError('POLICY', 'Parent workspace does not belong to the parent job');
    const info = await lstat(canonical).catch(() => null);
    const gitInfo = await lstat(join(canonical, '.git')).catch(() => null);
    if (!info?.isDirectory() || !gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) throw new AutosError('POLICY', 'Parent workspace is not a Git working directory');
  }

  /** Trusted fetch of the reviewed commit from the on-disk parent workspace; no in-memory runner state is consulted. */
  private async fetchParentCommit(directory: string, root: string, continuation: z.infer<typeof continuationSchema>, featureBranch: string, signal?: AbortSignal): Promise<void> {
    const parentRef = 'refs/autos/parent-head';
    await this.run(['-c', 'transfer.fsckObjects=true', '-C', directory, 'fetch', '--no-tags', '--no-recurse-submodules', continuation.parent_directory, `refs/heads/${featureBranch}:${parentRef}`], { cwd: root, signal, env: { GIT_ALLOW_PROTOCOL: 'file' }, timeoutMs: this.fetchTimeoutMs });
    const fetched = (await this.run(['-C', directory, 'rev-parse', `${parentRef}^{commit}`], { cwd: root, signal })).stdout.trim();
    if (fetched !== continuation.parent_commit_sha) throw new AutosError('STALE_CANDIDATE', 'Parent workspace no longer points to the reviewed commit');
    await this.run(['-C', directory, 'update-ref', '-d', parentRef], { cwd: root, signal });
    const descends = await this.run(['-C', directory, 'merge-base', '--is-ancestor', continuation.base_sha, continuation.parent_commit_sha], { cwd: root, signal, allowExitCodes: [1, 128] });
    if (descends.code !== 0) throw new AutosError('CONFLICT', 'The reviewed commit does not descend from its pinned base');
  }

  private async parentPaths(directory: string, baseSha: string, startSha: string, repository: RepositoryConfig, signal?: AbortSignal): Promise<string[]> {
    const entries = await this.rawDiffEntries(directory, ['diff', '--raw', '--abbrev=40', '-z', '--no-renames', '-r', baseSha, startSha], signal);
    for (const entry of entries) {
      this.assertAllowedPath(entry.path, repository);
      if (entry.rawMode === '160000') throw new AutosError('POLICY', 'Candidate contains a submodule entry');
    }
    return entries.filter((entry) => entry.mode !== 'deleted').map((entry) => entry.path);
  }

  private async baseEntry(workspace: GitWorkspace, path: string, signal?: AbortSignal): Promise<CandidateEntry | null> {
    const listed = await this.run(['-C', workspace.directory, 'ls-tree', '-z', workspace.base_sha, '--', path], { cwd: workspace.directory, signal });
    const record = listed.stdout.split('\0').filter(Boolean)[0];
    if (!record) return null;
    const match = /^([0-7]{6}) (\w+) ([a-f0-9]{40})\t/.exec(record);
    if (!match || match[2] !== 'blob') return null;
    const mode = match[1] === '100755' ? 'executable' : match[1] === '120000' ? 'symlink' : 'file';
    return { path, mode, content: await this.readBlob(workspace.directory, match[3]!, signal) };
  }

  private async workingEntry(workspace: GitWorkspace, path: string): Promise<CandidateEntry> {
    this.assertAllowedPath(path, workspace.repository);
    const absolute = resolve(workspace.directory, ...path.split('/'));
    if (!this.isWithin(workspace.directory, absolute)) throw new AutosError('POLICY', 'Candidate path escapes its workspace');
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const parentReal = await realpath(dirname(absolute)).catch(() => null);
    if (parentReal && !this.isWithin(workspace.directory, parentReal)) throw new AutosError('POLICY', 'Candidate path escapes its workspace through a symbolic link');
    if (!info) return { path, mode: 'deleted', content: Buffer.alloc(0) };
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute).catch(() => null);
      if (!target || !this.isWithin(workspace.directory, target)) throw new AutosError('POLICY', 'Candidate contains an escaping or broken symbolic link');
      return { path, mode: 'symlink', content: Buffer.from(await readlink(absolute)) };
    }
    if (info.isFile()) return { path, mode: info.mode & 0o111 ? 'executable' : 'file', content: await readFile(absolute) };
    throw new AutosError('POLICY', 'Candidate contains a non-file path');
  }

  private parseStatus(output: string): string[] {
    const fields = output.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < fields.length;) {
      const entry = fields[i++] ?? '';
      if (!entry) continue;
      const status = entry.slice(0, 2);
      let path = entry.slice(3);
      if (status.includes('R') || status.includes('C')) {
        const second = fields[i++];
        if (!second) throw new AutosError('POLICY', 'Candidate contains an invalid rename record');
        paths.push(path, second);
        continue;
      }
      if (status !== '??' && status[0] !== ' ' && status[1] !== ' ' && status[0] !== 'D' && status[1] !== 'D' && status !== ' M' && status !== 'M ' && status !== 'MM' && status !== 'AM' && status !== ' A') {
        throw new AutosError('POLICY', 'Candidate contains an unsupported Git state');
      }
      if (path) paths.push(path);
    }
    const unique = [...new Set(paths)].sort();
    if (unique.length !== paths.length) throw new AutosError('POLICY', 'Candidate contains duplicate path records');
    return unique;
  }

  private untrackedPaths(output: string): string[] {
    return output.split('\0').filter((entry) => entry.slice(0, 2) === '??').map((entry) => entry.slice(3));
  }

  private async untrackedDiff(directory: string, paths: string[], signal?: AbortSignal): Promise<string> {
    let output = '';
    for (const path of paths) {
      const file = await readFile(resolve(directory, ...path.split('/')));
      if (output.length + file.length > CANDIDATE_MAX_BUFFER) throw new AutosError('POLICY', 'Candidate diff exceeds size limit');
      output += `\n+++ ${path} (new file, ${file.length} bytes; sha256 ${createHash('sha256').update(file).digest('hex')})\n`;
      output += file.toString('utf8');
      if (!output.endsWith('\n')) output += '\n';
    }
    return output;
  }

  /** Checks every path and reports all FORBIDDEN violations together; other policy errors surface immediately. */
  private assertPolicyPaths(paths: string[], repository: RepositoryConfig): void {
    const violations: string[] = [];
    for (const path of paths) {
      try { this.assertAllowedPath(path, repository); } catch (error) {
        if (error instanceof PolicyViolationError) violations.push(path); else throw error;
      }
    }
    if (violations.length) throw new PolicyViolationError('Candidate changes violate the repository path policy', violations);
  }

  private assertAllowedPath(path: string, repository: RepositoryConfig): void {
    if (!relativePathSchema.safeParse(path).success) throw new AutosError('POLICY', 'Candidate contains an unsafe path');
    if (isHandoffPath(path)) throw new AutosError('POLICY', 'The reserved handoff directory can never be part of a candidate');
    if (isInstructionPath(path)) throw new PolicyViolationError('Agents may not modify repository instruction files', [path]);
    if (repository.prohibited_paths.some((pattern) => minimatch(path, pattern, { dot: true }))) throw new PolicyViolationError('Candidate contains a prohibited path', [path]);
    if (!repository.allowed_paths.some((pattern) => minimatch(path, pattern, { dot: true }))) throw new PolicyViolationError('Candidate path is outside the allowed path policy', [path]);
  }

  private async gitDir(directory: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(['-C', directory, 'rev-parse', '--absolute-git-dir'], { cwd: directory, signal });
    const gitDir = await realpath(result.stdout.trim());
    if (!this.isWithin(directory, gitDir) || gitDir !== join(directory, '.git')) throw new AutosError('POLICY', 'Unexpected Git metadata location');
    const info = await lstat(gitDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AutosError('POLICY', 'Git metadata directory is unsafe');
    return gitDir;
  }

  private async gitConfigDigest(directory: string): Promise<string> {
    const path = join(directory, '.git', 'config');
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile()) throw new AutosError('POLICY', 'Git metadata configuration is unsafe');
    return createHash('sha256').update(await readFile(path)).digest('hex');
  }

  private async metadataDigests(directory: string): Promise<{ indexDigest: string; infoDigest: string }> {
    const digestFile = async (path: string): Promise<string> => {
      const info = await lstat(path).catch(() => null);
      if (!info) return 'absent';
      if (info.isSymbolicLink() || !info.isFile()) throw new AutosError('POLICY', 'Git metadata file is unsafe');
      return createHash('sha256').update(await readFile(path)).digest('hex');
    };
    const indexDigest = await digestFile(join(directory, '.git', 'index'));
    const metadataRoot = join(directory, '.git');
    const hash = createHash('sha256');
    const addTree = async (relativePath: string): Promise<void> => {
      const absolute = join(metadataRoot, relativePath);
      const info = await lstat(absolute).catch(() => null);
      if (!info) { hash.update(`absent:${relativePath}\0`); return; }
      if (info.isSymbolicLink()) throw new AutosError('POLICY', 'Git metadata contains a symbolic link');
      if (info.isDirectory()) {
        hash.update(`directory:${relativePath}\0`);
        for (const entry of (await readdir(absolute)).sort()) await addTree(`${relativePath}/${entry}`);
        return;
      }
      if (!info.isFile()) throw new AutosError('POLICY', 'Git metadata contains an unsafe file');
      hash.update(`file:${relativePath}:${createHash('sha256').update(await readFile(absolute)).digest('hex')}\0`);
    };
    for (const path of ['HEAD', 'packed-refs', 'shallow', 'info', 'refs', 'objects/info/alternates', 'objects/info/http-alternates']) await addTree(path);
    return { indexDigest, infoDigest: hash.digest('hex') };
  }

  private async digestRawDiff(directory: string, command: string[], expectedPaths: string[], signal?: AbortSignal): Promise<{ digest: string; paths: string[] }> {
    const entries = await this.rawDiffEntries(directory, command, signal);
    const paths = entries.map((entry) => entry.path);
    if (paths.join('\0') !== [...expectedPaths].sort().join('\0')) throw new AutosError('STALE_CANDIDATE', 'Staged paths differ from the reviewed candidate');
    const workspace = this.records.get(directory)?.workspace;
    if (!workspace) throw new AutosError('FORBIDDEN', 'Git workspace was not prepared by this runner');
    return { digest: digestEntries(entries, workspace), paths };
  }

  private async rawDiffEntries(directory: string, command: string[], signal?: AbortSignal): Promise<RawEntry[]> {
    const result = await this.run(['-C', directory, ...command], { cwd: directory, signal });
    const fields = result.stdout.split('\0').filter(Boolean);
    const entries: RawEntry[] = [];
    for (let index = 0; index < fields.length;) {
      const header = fields[index++];
      const path = fields[index++];
      if (!header || !path || !header.startsWith(':')) throw new AutosError('POLICY', 'Git returned malformed candidate metadata');
      const parts = header.slice(1).split(' ');
      const modeRaw = parts[1] ?? '';
      const oid = parts[3] ?? '';
      if (parts.length !== 5 || !/^[0-7]{6}$/.test(parts[0] ?? '') || !/^[0-7]{6}$/.test(modeRaw) || !/^[a-f0-9]{40}$/.test(parts[2] ?? '') || !/^[a-f0-9]{40}$/.test(oid) || !/^[A-Z]$/.test(parts[4] ?? '')) throw new AutosError('POLICY', 'Git returned malformed candidate metadata');
      let mode = 'deleted';
      let content: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      if (modeRaw !== '000000') {
        mode = modeRaw === '100755' ? 'executable' : modeRaw === '120000' ? 'symlink' : 'file';
        content = await this.readBlob(directory, oid, signal);
      }
      entries.push({ path, mode, content, rawMode: modeRaw === '000000' ? (parts[0] ?? '') : modeRaw });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return entries;
  }

  private async readBlob(directory: string, oid: string, signal?: AbortSignal): Promise<Buffer> {
    this.throwIfAborted(signal);
    try {
      const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--literal-pathspecs', '-C', directory, 'cat-file', 'blob', oid];
      const result = await execFile('git', args, { cwd: directory, env: this.gitEnv(directory), signal, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 120_000, windowsHide: true });
      return Buffer.from(result.stdout);
    } catch (error) {
      if (signal?.aborted) throw new AutosError('CANCELLED', 'Git operation cancelled');
      const e = error as { code?: number | string; killed?: boolean; signal?: string | null };
      if (e.code === 'ENOENT' || e.code === 'ETIMEDOUT' || e.killed === true) throw classifyGitFailure(e);
      throw new AutosError('UPSTREAM', 'Git object could not be read');
    }
  }

  private async run(args: string[], options: { cwd: string; signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv | undefined; allowExitCodes?: number[] | undefined; timeoutMs?: number | undefined; maxBuffer?: number | undefined; candidateOutput?: boolean | undefined; label?: string | undefined }): Promise<{ stdout: string; stderr: string; code: number }> {
    this.throwIfAborted(options.signal);
    const env = this.gitEnv(options.cwd, options.env);
    try {
      const safeArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args];
      const result = await execFile('git', safeArgs, { cwd: options.cwd, env, signal: options.signal, encoding: 'buffer', maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, killSignal: 'SIGTERM', windowsHide: true });
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: 0 };
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string };
      if (options.signal?.aborted || e.name === 'AbortError') throw new AutosError('CANCELLED', 'Git operation cancelled');
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && options.candidateOutput) throw new AutosError('POLICY', 'Candidate diff exceeds size limit');
      const code = typeof e.code === 'number' ? e.code : 1;
      if (options.allowExitCodes?.includes(code) && !e.killed) return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), code };
      throw classifyGitFailure(e, options.label);
    }
  }

  private gitEnv(cwd: string, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const path = process.env.PATH ?? '/usr/bin:/bin';
    return {
      PATH: path, HOME: homedir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOW_PROTOCOL: this.testRemotes.size ? 'https:ssh:file' : 'https:ssh', GIT_CEILING_DIRECTORIES: dirname(cwd),
      ...(this.trustedCredentials?.gitAskPassPath ? { GIT_ASKPASS: this.trustedCredentials.gitAskPassPath } : {}),
      ...(this.trustedCredentials?.sshAuthSocket ? { SSH_AUTH_SOCK: this.trustedCredentials.sshAuthSocket } : {}),
      ...extras,
    };
  }

  private isWithin(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AutosError('CANCELLED', 'Git operation cancelled');
  }
}

const INSTRUCTION_FILE_MAX_BYTES = 64 * 1024;
const INSTRUCTION_TOTAL_MAX_BYTES = 512 * 1024;
const INSTRUCTION_DIRECTORY_ROOTS = ['.github/instructions', '.cursor/rules', '.claude/rules'];

function isHandoffPath(path: string): boolean {
  return path === HANDOFF_DIR || path.startsWith(`${HANDOFF_DIR}/`);
}

/** Repository instruction files (INSTRUCTION_FILE_PATTERNS, dotfiles included) plus the bare instruction directory roots. */
function isInstructionPath(path: string): boolean {
  return INSTRUCTION_DIRECTORY_ROOTS.includes(path) || INSTRUCTION_FILE_PATTERNS.some((pattern) => minimatch(path, pattern, { dot: true }));
}

function repositoryId(repository: Pick<RepositoryConfig, 'workspace' | 'repository_slug'>): string {
  return `${repository.workspace}/${repository.repository_slug}`;
}

function startOf(workspace: GitWorkspace): string {
  return (workspace as RunnerWorkspace).start_sha ?? workspace.base_sha;
}

function sameWorkspace(expected: GitWorkspace, supplied: GitWorkspace): boolean {
  return expected.job_id === supplied.job_id && expected.issue_key === supplied.issue_key &&
    expected.directory === supplied.directory && expected.base_sha === supplied.base_sha &&
    startOf(expected) === startOf(supplied) && expected.development_branch === supplied.development_branch && expected.feature_branch === supplied.feature_branch &&
    JSON.stringify(expected.repository) === JSON.stringify(supplied.repository);
}

function digestEntries(entries: Array<{ path: string; mode: string; content: Buffer }>, workspace: GitWorkspace): string {
  const hash = createHash('sha256');
  // Identical edited files on another base, repository, or attempt need fresh evidence.
  hash.update(JSON.stringify(['autos-candidate-v1', repositoryId(workspace.repository), workspace.base_sha, workspace.job_id, workspace.issue_key])).update('\0');
  for (const item of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const name = Buffer.from(item.path);
    const mode = Buffer.from(item.mode);
    hash.update(String(name.length)).update(':').update(name).update(String(mode.length)).update(':').update(mode).update(String(item.content.length)).update(':').update(item.content);
  }
  return hash.digest('hex');
}
