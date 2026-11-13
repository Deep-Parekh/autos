import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { AutosError, fixCommitSchema, type FixCommit, type LineageConfig, type LineageNode } from '@autos/contracts';
import { LineageGit, extractIssueKeys } from '../../packages/git-runner/src/index.js';

const execFile = promisify(execFileCallback);
const DAY = 24 * 3600 * 1000;
let root: string;
let source: string;
let mirrorsDir: string;
let mirror: string;
let lineageGit: LineageGit;
let nodes: LineageNode[];
const shas: Record<string, string> = {};

const lineage: LineageConfig = {
  id: 'core',
  repository: { workspace: 'acme', repository_slug: 'core' },
  root_branch: 'master',
  scan_branches: ['*', 'bugfix/**', 'feature/**'],
  ignore_branches: ['renovate/*'],
  branch_codes: { PROJC: 'cee' },
};
const mappings = [
  { project_key: 'PROJA', development_branch: 'proja' },
  { project_key: 'PROJB', development_branch: 'projb_main' },
  { project_key: 'PROJC', development_branch: 'projc' },
  { project_key: 'PROJD', development_branch: 'projd_missing' },
];
const knownKeysPattern = /^(PROJA|PROJB|PROJC|OLD)-/;

async function git(args: string[], options: { daysAgo?: number; cwd?: string } = {}): Promise<string> {
  const date = new Date(Date.now() - (options.daysAgo ?? 0) * DAY).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const result = await execFile('git', args, { cwd: options.cwd ?? source, env, encoding: 'utf8', maxBuffer: 10_000_000 });
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  const absolute = join(source, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

async function commit(name: string, message: string, daysAgo: number, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) await write(path, content);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', message], { daysAgo });
  shas[name] = await git(['rev-parse', 'HEAD']);
  return shas[name]!;
}

const CALC = 'src/main/java/com/acme/Calc.java';
const calc = (body: string): string => `package com.acme;\n\npublic class Calc {\n  public int add(int a, int b) {\n${body}\n  }\n\n  public int mul(int a, int b) {\n    return a * b;\n  }\n}\n`;

async function snapshot(): Promise<string> {
  return [await git(['rev-parse', 'HEAD']), await git(['symbolic-ref', 'HEAD']), await git(['status', '--porcelain', '--untracked-files=all']), await git(['for-each-ref', '--format=%(objectname) %(refname)'])].join('\n--\n');
}

async function buildFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'autos-lineage-'));
  source = join(root, 'source');
  mirrorsDir = join(root, 'data', 'mirrors');
  await mkdir(source);
  await git(['init', '-q', '-b', 'master']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  // The bug (a - b) predates every fork and the 2-year window.
  await commit('c0', 'OLD-1 initial import', 1100, { [CALC]: calc('    return a - b;'), 'util.txt': 'u1\n' });
  await commit('c1', 'Add docs', 300, { 'docs/readme.md': 'docs\n' });
  await git(['branch', 'proja']);
  await commit('c2', 'Tune util', 250, { 'util.txt': 'u1\nu2\n' });
  await git(['branch', 'projb_main']);
  await commit('c3', 'Unrelated root work', 200, { 'other.txt': 'o\n' });
  await git(['branch', 'projc']);
  await git(['branch', 'orphan_dev']); // root-only history: cannot be attached
  await git(['branch', 'renovate/deps']);

  // Project A: a bug introduced after its fork, and the inherited bug fixed.
  await git(['checkout', '-q', 'proja']);
  await commit('a0', 'Add feature module', 130, { 'feature.txt': 'x\nbadline\ny\n' });
  await commit('a1', 'PROJA-12 fix subtraction in Calc.add', 100, { [CALC]: calc('    return a + b;') });
  await commit('a2', 'PROJA-13 fix feature badline', 95, { 'feature.txt': 'x\ngoodline\ny\n' });
  await git(['checkout', '-q', '-b', 'feature/proja-20-login']);
  await commit('f1', 'tweak login', 90, { 'login.txt': 'login\n' });
  await git(['checkout', '-q', 'proja']);
  await git(['merge', '-q', '--no-ff', '-m', 'Merged in feature/proja-20-login (pull request #4)\n\nLogin tweak', 'feature/proja-20-login'], { daysAgo: 89 });
  shas.merge = await git(['rev-parse', 'HEAD']);
  await git(['branch', 'proja_dev']);
  await git(['branch', 'proja_sbx']);

  // Project B: the same fix cherry-picked under the local ticket key.
  await git(['checkout', '-q', 'projb_main']);
  await git(['cherry-pick', '-n', shas.a1!]);
  await git(['commit', '-q', '-m', 'PROJB-55 port subtraction fix'], { daysAgo: 80 });
  shas.b1 = await git(['rev-parse', 'HEAD']);
  await git(['branch', 'projb_dev']);
  await git(['checkout', '-q', '-b', 'bee_sbx']); // code "bee" differs from the project key: ancestry
  await commit('bee1', 'sandbox experiment', 70, { 'sandbox.txt': 's\n' });
  await git(['checkout', '-q', '-b', 'bugfix/PROJB-60', 'projb_main']);
  await commit('bf1', 'adjust timeout', 60, { 'timeout.txt': '30\n' });

  // Project C: a different change to the same line, a revert, and an override-coded side branch.
  await git(['checkout', '-q', 'projc']);
  await commit('c_fix', 'PROJC-8 different add fix', 75, { [CALC]: calc('    return Math.addExact(a, b);') });
  await commit('c_cfg', 'PROJC-7 change config', 50, { 'config.txt': 'a=1\n' });
  await git(['revert', '--no-edit', 'HEAD'], { daysAgo: 49 });
  shas.revert = await git(['rev-parse', 'HEAD']);
  await git(['branch', 'cee_dev']);
  await git(['checkout', '-q', 'master']);
}

describe('LineageGit', () => {
  before(async () => {
    await buildFixture();
    lineageGit = new LineageGit({ testOnlyAllowLocalRemotes: true });
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it('extracts issue keys with word boundaries', () => {
    assert.deepEqual(extractIssueKeys('PROJA-12: fix; see xPROJA-13 and PROJB-7a, (PROJC-1), UTF-8'), ['PROJA-12', 'PROJC-1']);
    assert.deepEqual(extractIssueKeys('PROJA-12 OTHER-3', /^PROJA-/), ['PROJA-12']);
  });

  it('creates a 0700 bare mirror and refreshes it; rejects unapproved remotes', async () => {
    mirror = await lineageGit.ensureMirror(lineage, source, mirrorsDir);
    assert.equal(mirror.endsWith(join('mirrors', 'core.git')), true);
    assert.equal((await stat(mirror)).mode & 0o777, 0o700);
    assert.equal(await git(['rev-parse', '--is-bare-repository'], { cwd: mirror }), 'true');
    assert.equal(await lineageGit.ensureMirror(lineage, `file://${source}`, mirrorsDir), mirror);
    await assert.rejects(new LineageGit().ensureMirror(lineage, source, mirrorsDir), (e: unknown) => e instanceof AutosError && e.code === 'POLICY');
    await assert.rejects(lineageGit.ensureMirror(lineage, 'https://user:secret@bitbucket.org/acme/core.git', mirrorsDir), (e: unknown) => e instanceof AutosError && !e.message.includes('secret'));
  });

  it('computes fork points and attaches side branches by name, override and ancestry', async () => {
    const result = await lineageGit.computeNodes(mirror, lineage, mappings);
    nodes = result.nodes;
    const byKey = Object.fromEntries(nodes.map((n) => [n.project_key, n]));
    assert.equal(byKey.PROJA!.fork_point, shas.c1);
    assert.equal(byKey.PROJB!.fork_point, shas.c2);
    assert.equal(byKey.PROJC!.fork_point, shas.c3);
    assert.ok(Math.abs(Date.parse(byKey.PROJA!.fork_date) - (Date.now() - 300 * DAY)) < 2 * DAY);
    assert.deepEqual(byKey.PROJA!.side_branches, [{ branch: 'proja_dev', kind: 'dev', method: 'name' }, { branch: 'proja_sbx', kind: 'sbx', method: 'name' }]);
    assert.deepEqual(byKey.PROJB!.side_branches, [{ branch: 'bee_sbx', kind: 'sbx', method: 'ancestry' }, { branch: 'projb_dev', kind: 'dev', method: 'name' }]);
    assert.deepEqual(byKey.PROJC!.side_branches, [{ branch: 'cee_dev', kind: 'dev', method: 'override' }]);
    assert.deepEqual(result.unattached, ['orphan_dev']);
    assert.deepEqual(result.missing, [{ project_key: 'PROJD', development_branch: 'projd_missing' }]);
  });

  let first: { fixes: FixCommit[]; tips: Record<string, string> };
  it('scans fixes from messages, merges and branch names with patch-ids, files, containment and reverts', async () => {
    first = await lineageGit.scanFixes(mirror, lineage, { since: new Date(Date.now() - 730 * DAY), knownKeysPattern });
    for (const fix of first.fixes) fixCommitSchema.parse(fix);
    const bySha = new Map(first.fixes.map((f) => [f.commit_sha, f]));
    assert.equal(bySha.has(shas.c0!), false, 'outside the window');
    assert.equal(first.tips['renovate/deps'], undefined, 'ignored branch');
    assert.equal(first.tips.proja, shas.merge);

    const a1 = bySha.get(shas.a1!)!; const b1 = bySha.get(shas.b1!)!;
    assert.deepEqual([a1.issue_keys, a1.source], [['PROJA-12'], 'commit_message']);
    assert.deepEqual(b1.issue_keys, ['PROJB-55']);
    assert.ok(a1.patch_id && a1.patch_id === b1.patch_id && a1.commit_sha !== b1.commit_sha);
    assert.deepEqual(a1.files, [{ path: CALC, additions: 1, deletions: 1 }]);
    assert.deepEqual(a1.contained_in, ['feature/proja-20-login', 'proja', 'proja_dev', 'proja_sbx']);
    assert.deepEqual(b1.contained_in, ['bee_sbx', 'bugfix/PROJB-60', 'projb_dev', 'projb_main']);

    const merge = bySha.get(shas.merge!)!;
    assert.deepEqual([merge.issue_keys, merge.source, merge.patch_id], [['PROJA-20'], 'merge_message', null]);
    assert.deepEqual(merge.files.map((f) => f.path), ['login.txt']);
    const branchOnly = bySha.get(shas.bf1!)!;
    assert.deepEqual([branchOnly.issue_keys, branchOnly.source, branchOnly.contained_in], [['PROJB-60'], 'branch_name', ['bugfix/PROJB-60']]);
    assert.equal(bySha.has(shas.f1!), false, 'f1 is not only on its branch and has no key');

    assert.equal(bySha.get(shas.c_cfg!)!.reverted_by, shas.revert);
    assert.equal(bySha.has(shas.revert!), false, 'reverts are reported separately');
    assert.equal(bySha.get(shas.a2!)!.reverted_by, null);
  });

  it('finds the same patch on another branch', async () => {
    const patchId = first.fixes.find((f) => f.commit_sha === shas.a1)!.patch_id!;
    assert.equal(await lineageGit.samePatchOn(mirror, patchId, 'projb_main'), shas.b1);
    assert.equal(await lineageGit.samePatchOn(mirror, patchId, 'projb_main', { paths: [CALC] }), shas.b1);
    assert.equal(await lineageGit.samePatchOn(mirror, patchId, 'projc'), null);
    assert.equal(await lineageGit.samePatchOn(mirror, patchId, 'no_such_branch'), null);
  });

  it('decides inheritance from blame against fork points', async () => {
    const inherited = await lineageGit.inheritedBy(mirror, shas.a1!, nodes);
    assert.deepEqual(inherited.map((r) => [r.project_key, r.inherited]), [['PROJA', true], ['PROJB', true], ['PROJC', true]]);
    const notInherited = await lineageGit.inheritedBy(mirror, shas.a2!, nodes);
    assert.deepEqual(notInherited.map((r) => [r.project_key, r.inherited]), [['PROJA', false], ['PROJB', false], ['PROJC', false]]);
    const additionsOnly = await lineageGit.inheritedBy(mirror, shas.bf1!, nodes);
    assert.ok(additionsOnly.every((r) => r.inherited === null));
  });

  it('checks whether a fix applies without touching a worktree', async () => {
    assert.equal(await lineageGit.appliesTo(mirror, shas.a1!, 'orphan_dev'), 'clean');
    assert.equal(await lineageGit.appliesTo(mirror, shas.a1!, 'projc'), 'needs_adaptation');
    const patch = await git(['diff', '--full-index', `${shas.a1}^`, shas.a1!], { cwd: mirror });
    assert.equal(await lineageGit.appliesTo(mirror, `${patch}\n`, 'orphan_dev'), 'clean');
    const foreign = 'diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-a\n+b\n';
    assert.equal(await lineageGit.appliesTo(mirror, foreign, 'orphan_dev'), 'unknown');
    assert.equal(await lineageGit.appliesTo(mirror, 'not a patch', 'orphan_dev'), 'unknown');
    assert.equal(await stat(join(mirror, 'index')).then(() => true, () => false), false, 'no index written into the mirror');
  });

  it('resolves identifiers to tracked paths', async () => {
    const result = await lineageGit.resolvePaths(mirror, 'proja', ['Calc', 'com.acme.Calc', 'Calc.java', 'java/com/acme/Calc.java', 'feature.txt', 'Nope', '../etc/passwd']);
    assert.deepEqual(result.paths, ['feature.txt', CALC]);
    assert.deepEqual(Object.keys(result.matches).sort(), ['Calc', 'Calc.java', 'com.acme.Calc', 'feature.txt', 'java/com/acme/Calc.java']);
    assert.deepEqual((await lineageGit.resolvePaths(mirror, 'master', ['feature.txt'])).paths, []);
  });

  it('bounds diff excerpts', async () => {
    await git(['checkout', '-q', 'master']);
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    await commit('big', 'PROJA-99 big change', 1, { 'big.txt': `${big}\n`, 'small.txt': 'small\n' });
    await lineageGit.ensureMirror(lineage, source, mirrorsDir);
    const excerpt = await lineageGit.diffExcerpt(mirror, shas.big!, { maxBytes: 1000 });
    assert.ok(Buffer.byteLength(excerpt) <= 1000);
    assert.match(excerpt, /files \(2\):\n {2}\+400 -0 big\.txt\n {2}\+1 -0 small\.txt\n/);
    assert.match(excerpt, /\[diff truncated\]\n$/);
    const filtered = await lineageGit.diffExcerpt(mirror, shas.big!, { maxBytes: 1000, paths: ['small.txt'] });
    assert.match(filtered, /\+small/);
    assert.doesNotMatch(filtered, /\[diff truncated\]/);
    await assert.rejects(lineageGit.diffExcerpt(mirror, shas.big!, { maxBytes: 10 }), (e: unknown) => e instanceof AutosError && e.code === 'INVALID_INPUT');
  });

  it('never modifies the source repository', async () => {
    const before = await snapshot();
    const config = await readFile(join(source, '.git', 'config'), 'utf8');
    await lineageGit.ensureMirror(lineage, source, mirrorsDir);
    await lineageGit.computeNodes(mirror, lineage, mappings);
    await lineageGit.scanFixes(mirror, lineage, { since: new Date(Date.now() - 730 * DAY) });
    await lineageGit.appliesTo(mirror, shas.a1!, 'projc');
    await lineageGit.inheritedBy(mirror, shas.a1!, nodes);
    assert.equal(await snapshot(), before);
    assert.equal(await readFile(join(source, '.git', 'config'), 'utf8'), config);
  });

  it('scans incrementally from previous tips', async () => {
    const scan = await lineageGit.scanFixes(mirror, lineage, { since: new Date(Date.now() - 730 * DAY), knownKeysPattern });
    await git(['checkout', '-q', 'proja']);
    await commit('a3', 'PROJA-30 another fix', 0, { 'feature.txt': 'x\nbestline\ny\n' });
    await git(['checkout', '-q', 'master']);
    await lineageGit.ensureMirror(lineage, source, mirrorsDir);
    const next = await lineageGit.scanFixes(mirror, lineage, { since: new Date(Date.now() - 730 * DAY), knownKeysPattern, previousTips: scan.tips });
    assert.deepEqual(next.fixes.map((f) => [f.commit_sha, f.issue_keys]), [[shas.a3, ['PROJA-30']]]);
    assert.equal(next.tips.proja, shas.a3);
  });
});
