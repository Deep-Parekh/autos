import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import {
  AutosError, branchNameSchema, fixCommitSchema, gitShaSchema, lineageConfigSchema, lineageNodeSchema,
  type FixCommit, type LineageConfig, type LineageNode,
} from '@autos/contracts';
import { buildGitEnv, isApprovedBitbucketRemote, spawnGit, type TrustedGitCredentials } from './exec.js';

/**
 * Trusted, read-only Git analysis over per-lineage bare mirrors (docs/semantic-precedents-plan.md §2, §3.3, §5, §7).
 * Nothing here creates a worktree, checks out, commits or pushes. The only writes are the mirror itself
 * (clone/fetch) and throwaway temporary indexes/object directories outside it.
 */

export interface LineageGitOptions {
  /** Trusted controller-only auth channel, as for GitRunner. */
  trustedCredentials?: TrustedGitCredentials;
  /** Test-only: accept absolute local paths or file:// URLs as mirror remotes. */
  testOnlyAllowLocalRemotes?: boolean;
  /** Clone/fetch timeout (default 15 minutes). */
  fetchTimeoutMs?: number;
  /** Timeout for other Git calls (default 120 seconds). */
  timeoutMs?: number;
}

export interface BranchMappingRef { project_key: string; development_branch: string }
export interface ComputedNodes {
  nodes: LineageNode[];
  /** `*_dev` / `*_sbx` branches that could not be attached to exactly one node. */
  unattached: string[];
  /** Mapped development branches that do not exist in the mirror or share no history with the root branch. */
  missing: BranchMappingRef[];
}
export interface ScanFixesOptions {
  /** Only commits committed after this instant are linked (the 2-year window). */
  since: Date;
  /** When given, only issue keys matching this pattern are kept (for example the branch-map project keys). */
  knownKeysPattern?: RegExp;
  /** Tips returned by the previous scan: commits reachable from them are not scanned again. */
  previousTips?: Record<string, string>;
}
export interface ScanFixesResult {
  fixes: FixCommit[];
  /** Scanned branch -> tip sha; pass back as previousTips. */
  tips: Record<string, string>;
  /** Reverts seen in this scan (also applied to reverted_by of fixes in this scan); older stored fixes may need updating. */
  reverts: Array<{ reverted: string; by: string }>;
}
export type ApplyResult = 'clean' | 'needs_adaptation' | 'unknown';
export interface InheritanceResult { project_key: string; branch: string; inherited: boolean | null; origins: number; inherited_origins: number }

const DEFAULT_FETCH_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const LOG_MAX_BYTES = 256 * 1024 * 1024;
const SMALL_MAX_BYTES = 16 * 1024 * 1024;
const PATCH_MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_BRANCH_ONLY_COMMITS = 500;
const MAX_BLAME_RANGES = 40;
const MAX_BLAME_LINES = 5000;
const MAX_RESOLVED_PER_IDENTIFIER = 10;
const MAX_IDENTIFIERS = 200;
const PATCH_ID_CHUNK = 100;
const TREE_CACHE_SIZE = 8;
const WINDOW_MS = 104 * 7 * 24 * 3600 * 1000;

const SIDE_BRANCH = /^(.+)_(dev|sbx)$/;
const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]*-[1-9][0-9]*)(?![A-Za-z0-9])/g;
/** Prefixes that look like issue keys but are not (UTF-8, SHA-256, ...); ignored unless knownKeysPattern says otherwise. */
const NON_KEY_PREFIXES = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'CVE', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'ES', 'EC', 'X', 'V', 'RELEASE', 'HOTFIX', 'BUGFIX', 'FEATURE']);
const MERGE_PATTERNS = [
  /^Merged in (\S+) \(pull request #\d+\)/, // Bitbucket Cloud
  /^Merge pull request #\d+ in \S+ from (\S+) to \S+/, // Bitbucket Data Center
];
const REVERT_PATTERN = /This reverts commit ([a-f0-9]{40})/;
const SHA = /^[a-f0-9]{40}$/;

interface RawCommit { sha: string; parents: string[]; time: number; message: string }

/** Extracts issue keys with a word boundary that excludes alphanumerics on either side. */
export function extractIssueKeys(text: string, knownKeysPattern?: RegExp): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(KEY_PATTERN)) {
    const key = match[1]!;
    if (key.length > 60) continue;
    if (knownKeysPattern) { knownKeysPattern.lastIndex = 0; if (!knownKeysPattern.test(key)) continue; }
    else if (NON_KEY_PREFIXES.has(key.slice(0, key.indexOf('-')))) continue;
    keys.add(key);
  }
  return [...keys].sort();
}

/** Branch names are often lower case (`bugfix/proja-12-x`); keys are matched case-insensitively there. */
function branchKeys(branch: string, knownKeysPattern?: RegExp): string[] {
  return extractIssueKeys(branch.toUpperCase(), knownKeysPattern);
}

export class LineageGit {
  private readonly credentials: TrustedGitCredentials | undefined;
  private readonly allowLocal: boolean;
  private readonly fetchTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly verifiedMirrors = new Set<string>();
  private readonly containsCache = new Map<string, string[]>();
  private readonly patchIdCache = new Map<string, Map<string, string>>();
  private readonly treeCache = new Map<string, string[]>();

  constructor(options: LineageGitOptions = {}) {
    if (options.trustedCredentials?.gitAskPassPath && !isAbsolute(options.trustedCredentials.gitAskPassPath)) throw new AutosError('INVALID_INPUT', 'Git askpass must be an absolute trusted executable path');
    for (const value of [options.fetchTimeoutMs, options.timeoutMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new AutosError('INVALID_INPUT', 'Timeouts must be positive numbers');
    this.credentials = options.trustedCredentials;
    this.allowLocal = options.testOnlyAllowLocalRemotes === true;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---- Mirrors ----

  /** Creates (`clone --mirror`) or refreshes (`fetch --prune`) `<mirrorsDir>/<lineage.id>.git`; returns its path. */
  async ensureMirror(lineageInput: LineageConfig, remoteUrl: string, mirrorsDir: string, signal?: AbortSignal): Promise<string> {
    const lineage = parseLineage(lineageInput);
    const remote = await this.checkRemote(remoteUrl);
    await mkdir(resolve(mirrorsDir), { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(mirrorsDir));
    const path = join(root, `${lineage.id}.git`);
    const info = await lstat(path).catch(() => null);
    const label = `lineage ${lineage.id}`;
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AutosError('POLICY', 'Mirror path is not a real directory');
      this.verifiedMirrors.delete(path);
      await this.openMirror(path, signal);
      const current = await this.git(path, ['config', '--get', 'remote.origin.url'], { signal, allowExitCodes: [1] });
      if (current.stdout.toString().trim() !== remote) await this.git(path, ['remote', 'set-url', 'origin', remote], { signal });
      await this.git(path, ['fetch', '--prune', '--no-recurse-submodules', 'origin'], { signal, timeoutMs: this.fetchTimeoutMs, label, network: true });
    } else {
      const temporary = join(root, `.${lineage.id}.git.tmp-${randomUUID()}`);
      try {
        await this.git(root, ['clone', '--mirror', '--quiet', '--', remote, temporary], { signal, timeoutMs: this.fetchTimeoutMs, label, network: true, gitDir: null });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    await chmod(path, 0o700);
    this.verifiedMirrors.delete(path);
    this.clearCaches();
    await this.openMirror(path, signal);
    return path;
  }

  // ---- Nodes ----

  /** Lineage nodes for the mapped development branches, with fork points and attached `<code>_dev` / `<code>_sbx` branches. */
  async computeNodes(mirror: string, lineageInput: LineageConfig, mappings: BranchMappingRef[], signal?: AbortSignal): Promise<ComputedNodes> {
    const lineage = parseLineage(lineageInput);
    const path = await this.openMirror(mirror, signal);
    const branches = await this.branches(path, signal);
    const rootTip = branches.get(lineage.root_branch);
    if (!rootTip) throw new AutosError('MAPPING', 'Lineage root branch does not exist in the mirror');
    const missing: BranchMappingRef[] = [];
    const nodes: LineageNode[] = [];
    const seen = new Set<string>();
    for (const mapping of mappings) {
      const branch = branchNameSchema.safeParse(mapping.development_branch);
      if (!branch.success || !/^[A-Z][A-Z0-9]*$/.test(mapping.project_key)) throw new AutosError('INVALID_INPUT', 'Invalid branch mapping');
      if (seen.has(mapping.project_key)) continue;
      seen.add(mapping.project_key);
      if (!branches.has(branch.data)) { missing.push({ project_key: mapping.project_key, development_branch: branch.data }); continue; }
      const fork = await this.mergeBase(path, `refs/heads/${branch.data}`, `refs/heads/${lineage.root_branch}`, signal);
      if (!fork) { missing.push({ project_key: mapping.project_key, development_branch: branch.data }); continue; }
      nodes.push({ lineage_id: lineage.id, project_key: mapping.project_key, branch: branch.data, fork_point: fork, fork_date: await this.commitDate(path, fork, signal), side_branches: [] });
    }
    const nodeBranches = new Set(nodes.map((node) => node.branch));
    const sideBranches = [...branches.keys()].filter((name) => SIDE_BRANCH.test(name) && !nodeBranches.has(name) && name !== lineage.root_branch).sort();
    const claimed = new Set<string>();
    // 1. Override and name attachment.
    for (const node of nodes) {
      const override = lineage.branch_codes[node.project_key];
      const candidates: Array<{ code: string; method: 'name' | 'override' }> = override
        ? [{ code: override, method: 'override' }]
        : [...new Set([node.branch, node.branch.split('_')[0]!])].map((code) => ({ code, method: 'name' as const }));
      for (const { code, method } of candidates) {
        for (const kind of ['dev', 'sbx'] as const) {
          const name = `${code}_${kind}`;
          if (!sideBranches.includes(name) || claimed.has(name)) continue;
          claimed.add(name);
          node.side_branches.push({ branch: name, kind, method });
        }
      }
    }
    // 2. Ancestry: the node sharing the newest node-specific (not on the root branch) history with the side branch.
    const unattached: string[] = [];
    for (const name of sideBranches) {
      if (claimed.has(name)) continue;
      const kind = SIDE_BRANCH.exec(name)![2] as 'dev' | 'sbx';
      const shared: Array<{ node: LineageNode; base: string }> = [];
      for (const node of nodes) {
        const base = await this.mergeBase(path, `refs/heads/${name}`, `refs/heads/${node.branch}`, signal);
        if (!base || await this.isAncestor(path, base, rootTip, signal)) continue;
        shared.push({ node, base });
      }
      const nearest: typeof shared = [];
      for (const item of shared) {
        let dominated = false;
        for (const other of shared) {
          if (other === item || other.base === item.base) continue;
          if (await this.isAncestor(path, item.base, other.base, signal)) { dominated = true; break; }
        }
        if (!dominated) nearest.push(item);
      }
      if (nearest.length === 1) nearest[0]!.node.side_branches.push({ branch: name, kind, method: 'ancestry' });
      else unattached.push(name);
    }
    for (const node of nodes) node.side_branches.sort((a, b) => a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0);
    return { nodes: nodes.map((node) => lineageNodeSchema.parse(node)), unattached, missing };
  }

  // ---- Fix scan ----

  /** Fix commits (issue keys from messages, branch names and merge messages) on the scanned branches since `since`. */
  async scanFixes(mirror: string, lineageInput: LineageConfig, options: ScanFixesOptions, signal?: AbortSignal): Promise<ScanFixesResult> {
    const lineage = parseLineage(lineageInput);
    if (!(options.since instanceof Date) || Number.isNaN(options.since.getTime())) throw new AutosError('INVALID_INPUT', 'Invalid scan window');
    const path = await this.openMirror(mirror, signal);
    const all = await this.branches(path, signal);
    const scanned = [...all.keys()].filter((name) => lineage.scan_branches.some((glob) => minimatch(name, glob)) && !lineage.ignore_branches.some((glob) => minimatch(name, glob))).sort();
    const tips: Record<string, string> = Object.fromEntries(scanned.map((name) => [name, all.get(name)!]));
    if (!scanned.length) return { fixes: [], tips, reverts: [] };
    const exclusions: string[] = [];
    for (const sha of new Set(Object.values(options.previousTips ?? {}))) {
      if (SHA.test(sha) && await this.commitExists(path, sha, signal)) exclusions.push(`^${sha}`);
    }
    const since = `--since-as-filter=${options.since.toISOString()}`;
    const commits = await this.log(path, [since, '--end-of-options', ...scanned.map((name) => `refs/heads/${name}`), ...exclusions], signal);
    const byBranchName = new Map<string, Set<string>>();
    for (const name of scanned) {
      const keys = branchKeys(name, options.knownKeysPattern);
      if (!keys.length) continue;
      const others = scanned.filter((other) => other !== name).map((other) => `^refs/heads/${other}`);
      const only = await this.git(path, ['rev-list', `--max-count=${MAX_BRANCH_ONLY_COMMITS}`, since, '--end-of-options', `refs/heads/${name}`, ...others, ...exclusions], { signal, maxBytes: SMALL_MAX_BYTES });
      for (const sha of only.stdout.toString().split('\n').filter((line) => SHA.test(line))) {
        const set = byBranchName.get(sha) ?? new Set<string>();
        for (const key of keys) set.add(key);
        byBranchName.set(sha, set);
      }
    }
    const reverts: Array<{ reverted: string; by: string }> = [];
    const revertedBy = new Map<string, string>();
    const candidates: Array<{ commit: RawCommit; keys: string[]; source: FixCommit['source'] }> = [];
    for (const commit of commits) {
      const revert = REVERT_PATTERN.exec(commit.message);
      if (revert) { reverts.push({ reverted: revert[1]!, by: commit.sha }); if (!revertedBy.has(revert[1]!)) revertedBy.set(revert[1]!, commit.sha); continue; }
      const subject = commit.message.split('\n', 1)[0] ?? '';
      const mergedBranch = commit.parents.length > 1 ? MERGE_PATTERNS.map((pattern) => pattern.exec(subject)?.[1]).find(Boolean) : undefined;
      let keys: string[]; let source: FixCommit['source'];
      if (mergedBranch) {
        keys = [...new Set([...branchKeys(mergedBranch, options.knownKeysPattern), ...extractIssueKeys(commit.message, options.knownKeysPattern)])].sort();
        source = 'merge_message';
      } else {
        keys = extractIssueKeys(commit.message, options.knownKeysPattern);
        source = 'commit_message';
        const fromBranch = byBranchName.get(commit.sha);
        if (fromBranch) {
          if (!keys.length) source = 'branch_name';
          keys = [...new Set([...keys, ...fromBranch])].sort();
        }
      }
      if (keys.length) candidates.push({ commit, keys, source });
    }
    const patchIds = await this.patchIds(path, candidates.filter((c) => c.commit.parents.length === 1).map((c) => c.commit.sha), signal);
    const tipsKey = scanned.map((name) => `${name}=${tips[name]}`).join('\0');
    const scannedSet = new Set(scanned);
    const fixes: FixCommit[] = [];
    for (const { commit, keys, source } of candidates) {
      const contained = await this.containedIn(path, commit.sha, tipsKey, signal);
      const parsed = fixCommitSchema.safeParse({
        lineage_id: lineage.id,
        commit_sha: commit.sha,
        patch_id: patchIds.get(commit.sha) ?? null,
        issue_keys: keys,
        source,
        committed_at: new Date(commit.time * 1000).toISOString(),
        subject: (commit.message.split('\n', 1)[0] ?? '').slice(0, 500),
        files: await this.numstat(path, commit, signal),
        contained_in: contained.filter((name) => scannedSet.has(name)),
        reverted_by: revertedBy.get(commit.sha) ?? null,
      });
      if (parsed.success) fixes.push(parsed.data);
    }
    return { fixes, tips, reverts };
  }

  // ---- Evidence helpers ----

  /** The sha of a non-merge commit on `branch` (within the window) whose stable patch-id equals `patchId`, or null. */
  async samePatchOn(mirror: string, patchId: string, branch: string, options: { since?: Date; paths?: string[] } = {}, signal?: AbortSignal): Promise<string | null> {
    if (!SHA.test(patchId)) throw new AutosError('INVALID_INPUT', 'Invalid patch-id');
    const path = await this.openMirror(mirror, signal);
    const tip = await this.branchTip(path, branch, signal);
    if (!tip) return null;
    const since = options.since ?? new Date(Date.now() - WINDOW_MS);
    const paths = [...new Set(options.paths ?? [])].sort().slice(0, MAX_FILES);
    const cacheKey = [path, tip, since.toISOString().slice(0, 10), ...paths].join('\0');
    let ids = this.patchIdCache.get(cacheKey);
    if (!ids) {
      const listed = await this.git(path, ['rev-list', '--no-merges', `--since-as-filter=${since.toISOString()}`, '--end-of-options', tip, ...(paths.length ? ['--', ...paths] : [])], { signal, maxBytes: LOG_MAX_BYTES });
      const shas = listed.stdout.toString().split('\n').filter((line) => SHA.test(line));
      ids = new Map();
      for (const [sha, id] of await this.patchIds(path, shas, signal)) if (!ids.has(id)) ids.set(id, sha);
      this.patchIdCache.set(cacheKey, ids);
    }
    return ids.get(patchId) ?? null;
  }

  /**
   * Whether the code a fix removed or changed was inherited by each node: blames the fix's removed lines on its parent
   * and checks every blamed origin commit against the node's fork point. null when unknown (no removed lines, binary,
   * too large, root commit, or only some origins inherited).
   */
  async inheritedBy(mirror: string, fixSha: string, nodes: LineageNode[], signal?: AbortSignal): Promise<InheritanceResult[]> {
    if (!SHA.test(fixSha)) throw new AutosError('INVALID_INPUT', 'Invalid commit');
    const path = await this.openMirror(mirror, signal);
    const unknown = (): InheritanceResult[] => nodes.map((node) => ({ project_key: node.project_key, branch: node.branch, inherited: null, origins: 0, inherited_origins: 0 }));
    const parent = await this.firstParent(path, fixSha, signal);
    if (!parent) return unknown();
    const diff = await this.git(path, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--end-of-options', parent, fixSha], { signal, maxBytes: PATCH_MAX_BYTES, allowOverflow: true });
    if (!diff) return unknown();
    const ranges = removedRanges(diff.stdout.toString('utf8'));
    if (!ranges) return unknown();
    const byFile = new Map<string, Array<[number, number]>>();
    let count = 0; let lines = 0;
    for (const range of ranges) {
      count++; lines += range.end - range.start + 1;
      const list = byFile.get(range.path) ?? [];
      list.push([range.start, range.end]);
      byFile.set(range.path, list);
    }
    if (!count || count > MAX_BLAME_RANGES || lines > MAX_BLAME_LINES) return unknown();
    const origins = new Set<string>();
    for (const [file, fileRanges] of byFile) {
      const blame = await this.git(path, ['blame', '--porcelain', ...fileRanges.flatMap(([start, end]) => ['-L', `${start},${end}`]), parent, '--', file], { signal, maxBytes: SMALL_MAX_BYTES, allowOverflow: true, allowExitCodes: [128] });
      if (!blame || blame.code !== 0) return unknown();
      for (const line of blame.stdout.toString('utf8').split('\n')) {
        const match = /^([a-f0-9]{40}) \d+ \d+/.exec(line);
        if (match) origins.add(match[1]!);
      }
    }
    if (!origins.size) return unknown();
    const results: InheritanceResult[] = [];
    for (const node of nodes) {
      if (!SHA.test(node.fork_point)) throw new AutosError('INVALID_INPUT', 'Invalid lineage node');
      let inherited = 0;
      for (const origin of origins) if (await this.isAncestor(path, origin, node.fork_point, signal)) inherited++;
      results.push({ project_key: node.project_key, branch: node.branch, inherited: inherited === origins.size ? true : inherited === 0 ? false : null, origins: origins.size, inherited_origins: inherited });
    }
    return results;
  }

  /**
   * Whether a fix (commit sha or patch text such as Autos' changes.patch) applies to `branch`'s tip, checked in a
   * temporary index (`read-tree`) with a temporary object directory: never a worktree, never the mirror's objects.
   * clean: applies as is or by a conflict-free 3-way merge; needs_adaptation: 3-way merge conflicts; unknown otherwise.
   */
  async appliesTo(mirror: string, patchOrSha: string, branch: string, signal?: AbortSignal): Promise<ApplyResult> {
    const path = await this.openMirror(mirror, signal);
    const tip = await this.branchTip(path, branch, signal);
    if (!tip) return 'unknown';
    let patch: Buffer;
    if (SHA.test(patchOrSha)) {
      if (!await this.commitExists(path, patchOrSha, signal)) return 'unknown';
      const parent = await this.firstParent(path, patchOrSha, signal);
      if (!parent) return 'unknown';
      const diff = await this.git(path, ['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--end-of-options', parent, patchOrSha], { signal, maxBytes: PATCH_MAX_BYTES, allowOverflow: true });
      if (!diff) return 'unknown';
      patch = diff.stdout;
    } else {
      patch = Buffer.from(patchOrSha, 'utf8');
      if (patch.length > PATCH_MAX_BYTES || !/^diff --git /m.test(patchOrSha)) return 'unknown';
    }
    if (!patch.length) return 'unknown';
    const scratch = await mkdtemp(join(tmpdir(), 'autos-apply-'));
    try {
      await chmod(scratch, 0o700);
      const patchFile = join(scratch, 'fix.patch');
      await writeFile(patchFile, patch, { mode: 0o600 });
      const objects = join(scratch, 'objects');
      await mkdir(objects, { mode: 0o700 });
      const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(path, 'objects') };
      await this.git(path, ['read-tree', '--end-of-options', tip], { signal, env });
      const plain = await this.git(path, ['apply', '--check', '--cached', patchFile], { signal, env, allowExitCodes: [1, 128] });
      if (plain.code === 0) return 'clean';
      const threeWay = await this.git(path, ['apply', '--cached', '--3way', patchFile], { signal, env, allowExitCodes: [1, 128] });
      if (threeWay.code === 0) return 'clean';
      const unmerged = await this.git(path, ['ls-files', '--unmerged'], { signal, env });
      return unmerged.stdout.length ? 'needs_adaptation' : 'unknown';
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Maps class names, file names and path fragments to tracked files on `branch` by exact basename/suffix matching. */
  async resolvePaths(mirror: string, branch: string, identifiers: string[], options: { max?: number } = {}, signal?: AbortSignal): Promise<{ paths: string[]; matches: Record<string, string[]> }> {
    const path = await this.openMirror(mirror, signal);
    const tip = await this.branchTip(path, branch, signal);
    const max = Math.max(1, Math.min(options.max ?? 50, 500));
    if (!tip) return { paths: [], matches: {} };
    const files = await this.trackedFiles(path, tip, signal);
    const matches: Record<string, string[]> = {};
    const all = new Set<string>();
    for (const raw of [...new Set(identifiers)].slice(0, MAX_IDENTIFIERS)) {
      const id = raw.trim().replace(/^\.?\//, '');
      if (!id || id.length > 300 || /[\0\n\r]/.test(id) || id.split('/').includes('..')) continue;
      const matcher = identifierMatcher(id);
      const found: string[] = [];
      for (const file of files) {
        if (matcher(file)) { found.push(file); if (found.length >= MAX_RESOLVED_PER_IDENTIFIER) break; }
      }
      if (!found.length) continue;
      matches[raw] = found;
      for (const file of found) all.add(file);
    }
    return { paths: [...all].sort().slice(0, max), matches };
  }

  /** Bounded text for a commit: subject, file list with numstat (always), then hunks truncated with a marker. */
  async diffExcerpt(mirror: string, sha: string, options: { paths?: string[]; maxBytes: number }, signal?: AbortSignal): Promise<string> {
    if (!SHA.test(sha)) throw new AutosError('INVALID_INPUT', 'Invalid commit');
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 256 || options.maxBytes > 1024 * 1024) throw new AutosError('INVALID_INPUT', 'maxBytes must be between 256 and 1048576');
    const path = await this.openMirror(mirror, signal);
    if (!await this.commitExists(path, sha, signal)) throw new AutosError('NOT_FOUND', 'Commit not found in the mirror');
    const [commit] = await this.log(path, ['--no-walk', '--end-of-options', sha], signal);
    if (!commit) throw new AutosError('NOT_FOUND', 'Commit not found in the mirror');
    const files = await this.numstat(path, commit, signal);
    let header = `commit ${sha}\n${(commit.message.split('\n', 1)[0] ?? '').slice(0, 500)}\nfiles (${files.length}${files.length >= MAX_FILES ? '+' : ''}):\n`;
    for (const file of files) header += `  +${file.additions ?? '-'} -${file.deletions ?? '-'} ${file.path}\n`;
    const budget = options.maxBytes - Buffer.byteLength(header);
    if (budget <= 64) return `${header}[diff omitted: size limit]\n`;
    const parent = await this.firstParent(path, sha, signal);
    const pathspec = (options.paths ?? []).filter((p) => p && !p.startsWith('-') && !p.split('/').includes('..')).slice(0, MAX_FILES);
    const range = parent ? [parent, sha] : [sha];
    const diffArgs = parent ? ['diff'] : ['diff-tree', '-p', '--root'];
    const diff = await this.git(path, ['-c', 'core.quotePath=false', ...diffArgs, '--no-color', '--no-ext-diff', '--no-textconv', '--end-of-options', ...range, ...(pathspec.length ? ['--', ...pathspec] : [])], { signal, maxBytes: budget, truncate: true });
    let text = diff.stdout.toString('utf8');
    if (diff.truncated) {
      const marker = '\n[diff truncated]\n';
      text = text.slice(0, Math.max(0, budget - marker.length));
      while (Buffer.byteLength(text) > budget - marker.length) text = text.slice(0, -1);
      text += marker;
    }
    return header + text;
  }

  // ---- Internals ----

  private clearCaches(): void {
    this.containsCache.clear();
    this.patchIdCache.clear();
    this.treeCache.clear();
  }

  private async checkRemote(remote: string): Promise<string> {
    if (isApprovedBitbucketRemote(remote)) return remote;
    if (this.allowLocal) {
      const local = remote.startsWith('file://') ? new URL(remote).pathname : remote;
      if (isAbsolute(local)) {
        const real = await realpath(local).catch(() => null);
        if (real && (await lstat(real)).isDirectory()) return real;
      }
    }
    throw new AutosError('POLICY', 'Mirror remote is not an approved Bitbucket URL');
  }

  /** Validates a mirror path: an absolute, real (not symlinked) bare repository directory. */
  private async openMirror(mirror: string, signal?: AbortSignal): Promise<string> {
    if (typeof mirror !== 'string' || !isAbsolute(mirror)) throw new AutosError('INVALID_INPUT', 'Mirror path must be absolute');
    const path = resolve(mirror);
    if (this.verifiedMirrors.has(path)) return path;
    const info = await lstat(path).catch(() => null);
    const real = await realpath(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || real !== path) throw new AutosError('POLICY', 'Mirror is not a real directory');
    const bare = await this.git(path, ['rev-parse', '--is-bare-repository'], { signal });
    if (bare.stdout.toString().trim() !== 'true') throw new AutosError('POLICY', 'Mirror is not a bare repository');
    this.verifiedMirrors.add(path);
    return path;
  }

  private async git(cwd: string, args: string[], options: { signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv; allowExitCodes?: number[]; timeoutMs?: number; maxBytes?: number; truncate?: boolean; label?: string; network?: boolean; gitDir?: null; allowOverflow: true }): Promise<{ stdout: Buffer; code: number; truncated: boolean } | null>;
  private async git(cwd: string, args: string[], options?: { signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv; allowExitCodes?: number[]; timeoutMs?: number; maxBytes?: number; truncate?: boolean; label?: string; network?: boolean; gitDir?: null; allowOverflow?: false }): Promise<{ stdout: Buffer; code: number; truncated: boolean }>;
  private async git(cwd: string, args: string[], options: { signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv; allowExitCodes?: number[]; timeoutMs?: number; maxBytes?: number; truncate?: boolean; label?: string; network?: boolean; gitDir?: null; allowOverflow?: boolean } = {}): Promise<{ stdout: Buffer; code: number; truncated: boolean } | null> {
    const prefix = options.gitDir === null ? [] : [`--git-dir=${cwd}`];
    try {
      const result = await spawnGit([...prefix, ...args], {
        cwd,
        env: buildGitEnv(cwd, { credentials: options.network ? this.credentials : undefined, allowFileProtocol: this.allowLocal }, options.env),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        maxBytes: options.maxBytes ?? SMALL_MAX_BYTES,
        truncate: options.truncate,
        allowExitCodes: options.allowExitCodes,
        label: options.label,
      });
      return { stdout: result.stdout, code: result.code, truncated: result.truncated };
    } catch (error) {
      if (options.allowOverflow && error instanceof AutosError && error.code === 'POLICY') return null;
      throw error;
    }
  }

  private async branches(path: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const listed = await this.git(path, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/'], { signal, maxBytes: SMALL_MAX_BYTES });
    const map = new Map<string, string>();
    for (const line of listed.stdout.toString('utf8').split('\n')) {
      const match = /^([a-f0-9]{40}) refs\/heads\/(.+)$/.exec(line);
      if (match && branchNameSchema.safeParse(match[2]).success) map.set(match[2]!, match[1]!);
    }
    return map;
  }

  private async branchTip(path: string, branch: string, signal?: AbortSignal): Promise<string | null> {
    if (!branchNameSchema.safeParse(branch).success) throw new AutosError('INVALID_INPUT', 'Invalid branch name');
    const result = await this.git(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], { signal, allowExitCodes: [1, 128] });
    const sha = result.stdout.toString().trim();
    return result.code === 0 && SHA.test(sha) ? sha : null;
  }

  private async commitExists(path: string, sha: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(path, ['cat-file', '-e', `${sha}^{commit}`], { signal, allowExitCodes: [1, 128] });
    return result.code === 0;
  }

  private async mergeBase(path: string, a: string, b: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.git(path, ['merge-base', '--end-of-options', a, b], { signal, allowExitCodes: [1] });
    const sha = result.stdout.toString().trim();
    return result.code === 0 && gitShaSchema.safeParse(sha).success ? sha : null;
  }

  private async isAncestor(path: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
    if (ancestor === descendant) return true;
    const result = await this.git(path, ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant], { signal, allowExitCodes: [1, 128] });
    return result.code === 0;
  }

  private async commitDate(path: string, sha: string, signal?: AbortSignal): Promise<string> {
    const result = await this.git(path, ['show', '-s', '--format=%ct', '--end-of-options', sha], { signal });
    const seconds = Number(result.stdout.toString().trim());
    if (!Number.isFinite(seconds)) throw new AutosError('UPSTREAM', 'Git returned an invalid commit date');
    return new Date(seconds * 1000).toISOString();
  }

  private async firstParent(path: string, sha: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.git(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^1`], { signal, allowExitCodes: [1, 128] });
    const parent = result.stdout.toString().trim();
    return result.code === 0 && SHA.test(parent) ? parent : null;
  }

  private async log(path: string, args: string[], signal?: AbortSignal): Promise<RawCommit[]> {
    const result = await this.git(path, ['log', '--no-color', '--format=%x1e%H%x00%P%x00%ct%x00%B', ...args], { signal, maxBytes: LOG_MAX_BYTES, timeoutMs: Math.max(this.timeoutMs, 10 * 60_000) });
    const commits: RawCommit[] = [];
    for (const record of result.stdout.toString('utf8').split('\x1e')) {
      const [sha, parents, time, ...rest] = record.split('\0');
      if (!sha || !SHA.test(sha) || time === undefined) continue;
      const seconds = Number(time);
      if (!Number.isFinite(seconds)) continue;
      commits.push({ sha, parents: (parents ?? '').split(' ').filter((p) => SHA.test(p)), time: seconds, message: rest.join('\0').trim() });
    }
    return commits;
  }

  /** Stable patch-ids for non-merge commits, computed in batches; commits with empty diffs have none. */
  private async patchIds(path: string, shas: string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (let index = 0; index < shas.length; index += PATCH_ID_CHUNK) {
      const chunk = shas.slice(index, index + PATCH_ID_CHUNK);
      const shown = await this.git(path, ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H', '-p', '--end-of-options', ...chunk], { signal, maxBytes: LOG_MAX_BYTES, allowOverflow: true });
      if (!shown) continue; // Too large to fingerprint: those commits keep a null patch-id.
      const result = await spawnGit(['patch-id', '--stable'], { cwd: path, env: buildGitEnv(path, { allowFileProtocol: false }), signal, timeoutMs: this.timeoutMs, maxBytes: SMALL_MAX_BYTES, input: shown.stdout });
      for (const line of result.stdout.toString().split('\n')) {
        const match = /^([a-f0-9]{40}) ([a-f0-9]{40})$/.exec(line);
        if (match && chunk.includes(match[2]!)) ids.set(match[2]!, match[1]!);
      }
    }
    return ids;
  }

  private async numstat(path: string, commit: RawCommit, signal?: AbortSignal): Promise<FixCommit['files']> {
    const args = commit.parents.length ? ['diff-tree', '-r', '--numstat', '-z', '--no-renames', '--end-of-options', commit.parents[0]!, commit.sha] : ['diff-tree', '-r', '--numstat', '-z', '--no-renames', '--root', '--end-of-options', commit.sha];
    const result = await this.git(path, args, { signal, maxBytes: SMALL_MAX_BYTES, allowOverflow: true });
    if (!result) return [];
    const files: FixCommit['files'] = [];
    for (const entry of result.stdout.toString('utf8').split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry.replace(/^\n/, ''));
      if (!match) continue;
      const file = match[3]!;
      if (file.startsWith('/') || file.split('/').includes('..') || file.length > 1000) continue;
      files.push({ path: file, additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) });
      if (files.length >= MAX_FILES) break;
    }
    return files;
  }

  private async containedIn(path: string, sha: string, tipsKey: string, signal?: AbortSignal): Promise<string[]> {
    const key = `${path}\0${tipsKey}\0${sha}`;
    const cached = this.containsCache.get(key);
    if (cached) return cached;
    const result = await this.git(path, ['for-each-ref', '--format=%(refname)', `--contains=${sha}`, 'refs/heads/'], { signal, maxBytes: SMALL_MAX_BYTES });
    const branches = result.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('refs/heads/')).map((line) => line.slice('refs/heads/'.length)).filter((name) => branchNameSchema.safeParse(name).success).sort();
    if (this.containsCache.size > 50_000) this.containsCache.clear();
    this.containsCache.set(key, branches);
    return branches;
  }

  private async trackedFiles(path: string, tip: string, signal?: AbortSignal): Promise<string[]> {
    const key = `${path}\0${tip}`;
    const cached = this.treeCache.get(key);
    if (cached) return cached;
    const result = await this.git(path, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', tip], { signal, maxBytes: LOG_MAX_BYTES });
    const files = result.stdout.toString('utf8').split('\0').filter(Boolean);
    if (this.treeCache.size >= TREE_CACHE_SIZE) this.treeCache.delete(this.treeCache.keys().next().value!);
    this.treeCache.set(key, files);
    return files;
  }
}

function parseLineage(input: LineageConfig): LineageConfig {
  const parsed = lineageConfigSchema.safeParse(input);
  if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Invalid lineage configuration');
  return parsed.data;
}

/** Old-side line ranges removed or changed by a -U0 diff; null when any file is binary or a path is quoted (unknown). */
function removedRanges(diff: string): Array<{ path: string; start: number; end: number }> | null {
  const ranges: Array<{ path: string; start: number; end: number }> = [];
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) return null;
    if (line.startsWith('--- ')) {
      const target = line.slice(4);
      if (target === '/dev/null') { current = null; continue; }
      if (target.startsWith('"') || !target.startsWith('a/')) return null;
      current = target.slice(2);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) ranges.push({ path: current, start, end: start + count - 1 });
    }
  }
  return ranges;
}

/** Exact matching: path fragments by suffix, file names by basename, dotted class names by package path, bare names by stem. */
function identifierMatcher(id: string): (file: string) => boolean {
  const stem = (file: string): string => { const base = file.slice(file.lastIndexOf('/') + 1); const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(0, dot) : base; };
  const withoutExtension = (file: string): string => { const dot = file.lastIndexOf('.'); return dot > file.lastIndexOf('/') + 1 ? file.slice(0, dot) : file; };
  if (id.includes('/')) return (file) => file === id || file.endsWith(`/${id}`);
  const parts = id.split('.');
  if (parts.length === 2 && /^[a-z0-9]{1,10}$/.test(parts[1]!)) return (file) => file === id || file.endsWith(`/${id}`);
  if (parts.length > 2 || (parts.length === 2 && /^[A-Z]/.test(parts[1]!))) {
    const asPath = parts.join('/');
    return (file) => { const bare = withoutExtension(file); return bare === asPath || bare.endsWith(`/${asPath}`); };
  }
  return (file) => stem(file) === id;
}
