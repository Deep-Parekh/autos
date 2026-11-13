import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import {
  AutosError, parseConfigYaml, precedentIndexStatusSchema, precedentsConfigSchema, semanticPrecedentResultSchema,
  type AutosConfig, type IndexedIssue, type LineageConfig, type ProjectMapping, type SemanticPrecedentResult,
} from '@autos/contracts';
import { LineageGit } from '../../packages/git-runner/src/index.js';
import {
  createPrecedentService, stablePatchId, type AutosAttemptRecord, type Judge, type JudgeRequest, type JiraIndexSource, type LineageGitLike, type PrecedentService,
} from '../../packages/precedents/src/index.js';
import { abstainQuery, corpusIssues, embedder, queryIssue } from './corpus.js';
import { issue } from './fixtures.js';

const execFile = promisify(execFileCallback);
const DAY = 86_400_000;
const PRICING = 'src/main/java/com/acme/pricing/PricingEngine.java';
const COUPON = 'web/src/pages/CouponPage.tsx';
const NONCE = '0123456789abcdef0123';
const exampleYaml = readFileSync(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');

// ---- Fakes ----------------------------------------------------------------------------------------------

class FakeJira implements JiraIndexSource {
  issues = new Map<string, IndexedIssue>();
  searches: Array<{ projects: string[]; since: string | null; token: string | null }> = [];
  lists = 0;
  failWith: AutosError | null = null;
  delayMs = 0;
  constructor(issues: IndexedIssue[]) { for (const i of issues) this.issues.set(i.id, i); }
  async searchIssuesForIndex(opts: { projects: string[]; updatedSince: string | null; pageToken: string | null; pageSize: number }) {
    this.searches.push({ projects: opts.projects, since: opts.updatedSince, token: opts.pageToken });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    const all = [...this.issues.values()].filter((i) => opts.projects.includes(i.project_key) && (!opts.updatedSince || i.updated_at >= opts.updatedSince))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || Number(a.id) - Number(b.id));
    const start = Number(opts.pageToken ?? 0);
    return { issues: all.slice(start, start + opts.pageSize), nextPageToken: start + opts.pageSize < all.length ? String(start + opts.pageSize) : null, skipped_restricted: 0, skipped_invalid: 0 };
  }
  async getIndexComments() { return { comments: [], next_start_at: null, skipped_invalid: 0 }; }
  async listIssueIds(opts: { projects: string[] }) {
    this.lists++;
    if (this.failWith) throw this.failWith;
    return { ids: [...this.issues.values()].filter((i) => opts.projects.includes(i.project_key)).map((i) => ({ id: i.id, key: i.key, updated: i.updated_at })), nextPageToken: null };
  }
}

type JudgeMode = 'yes' | 'throw';
function fakeJudge(): Judge & { mode: JudgeMode; requests: JudgeRequest[] } {
  const j = {
    mode: 'yes' as JudgeMode, requests: [] as JudgeRequest[],
    async judge(req: JudgeRequest) {
      j.requests.push(req);
      if (j.mode === 'throw') throw new Error('provider failed');
      return JSON.stringify({ schema_version: 1, verdicts: req.keys.map((k) => ({ issue_key: k, same_defect: 'yes', confidence: 0.8, shared_evidence: [], differences: [] })) });
    },
  };
  return j;
}

const mapping = (project_key: string, development_branch: string, repo = 'core', enabled = true): ProjectMapping => ({
  project_key, workspace: 'acme', repository_slug: repo, development_branch, sandbox_branch: null, enabled,
  source: { page_id: '1', version: 1, fetched_at: '2026-11-01T00:00:00.000Z' },
});
const BRANCH_MAP: ProjectMapping[] = [
  mapping('PROJA', 'proja'), mapping('PROJB', 'projb'), mapping('PROJC', 'projc'), mapping('PROJE', 'proje'),
  mapping('PROJD', 'main', 'platform'), mapping('PROJX', 'projx'), mapping('PROJZ', 'projz', 'core', false),
];

function config(over: Record<string, unknown> = {}): AutosConfig {
  const c = structuredClone(parseConfigYaml(exampleYaml));
  const base = c.bitbucket.allowed_repositories[0]!;
  c.bitbucket.allowed_repositories.push({ ...base, workspace: 'acme', repository_slug: 'core', remote_url: 'https://bitbucket.org/acme/core.git' });
  c.precedents = precedentsConfigSchema.parse({
    enabled: true, source: 'semantic', lineages: [{ id: 'core', repository: { workspace: 'acme', repository_slug: 'core' }, root_branch: 'master' }],
    index: { exclude_projects: ['PROJX'], min_request_interval_ms: 0 }, prompt: { roles: ['swe', 'reviewer'] }, ...over,
  });
  return c;
}

// ---- Disposable Git lineage -----------------------------------------------------------------------------

let root: string;
let source: string;
let fixSha: string;
let fixPatch: string;

async function git(args: string[], daysAgo = 0): Promise<string> {
  const date = new Date(Date.now() - daysAgo * DAY).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  return (await execFile('git', args, { cwd: source, env, encoding: 'utf8', maxBuffer: 10_000_000 })).stdout.trim();
}
async function commit(message: string, daysAgo: number, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), content); }
  await git(['add', '-A']); await git(['commit', '-q', '-m', message], daysAgo);
  return git(['rev-parse', 'HEAD']);
}
const pricing = (line: string) => `package com.acme.pricing;\n\npublic class PricingEngine {\n  public int total(int price, int discount, boolean reapplied) {\n    int t = price - discount;\n${line}\n    return t;\n  }\n}\n`;

async function buildRepo(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'autos-precedent-service-'));
  source = join(root, 'source');
  await mkdir(source);
  await git(['init', '-q', '-b', 'master']);
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.test']);
  await commit('Initial import', 400, { [PRICING]: pricing('    if (reapplied) t = t - discount;'), [COUPON]: 'export const CouponPage = () => render();\n' });
  await commit('Add docs', 300, { 'docs/readme.md': 'docs\n' });
  for (const b of ['proja', 'projb', 'projc', 'proje']) await git(['branch', b]);
  await git(['checkout', '-q', 'projb']);
  fixSha = await commit('PROJB-55 apply discount once', 60, { [PRICING]: pricing('    if (reapplied) { /* applied once */ }') });
  fixPatch = await git(['diff', `${fixSha}^`, fixSha]) + '\n';
  await git(['checkout', '-q', 'projc']);
  await git(['cherry-pick', '--no-commit', fixSha]);
  await git(['commit', '-q', '-m', 'PROJC-90 apply discount once'], 50);
  await commit('PROJC-77 lazy-load coupon page', 40, { [COUPON]: 'export const CouponPage = lazy(() => render());\n' });
  await git(['checkout', '-q', 'master']);
}

class LocalLineageGit extends LineageGit {
  ensureCalls = 0;
  constructor() { super({ testOnlyAllowLocalRemotes: true }); }
  override ensureMirror(lineage: LineageConfig, _remote: string, mirrorsDir: string, signal?: AbortSignal): Promise<string> {
    this.ensureCalls++;
    return super.ensureMirror(lineage, source, mirrorsDir, signal);
  }
}

const lookupRequest = (i: IndexedIssue, job = 'job-1') => ({ job_id: job, issue_key: i.key, project_key: i.project_key, development_branch: 'proja', summary: i.summary, description: i.description, link_keys: [] });

// ---- Tests ----------------------------------------------------------------------------------------------

describe('precedent service with a disposable lineage', () => {
  let service: PrecedentService;
  let jira: FakeJira;
  let judge: ReturnType<typeof fakeJudge>;
  let lineageGit: LocalLineageGit;
  let found: SemanticPrecedentResult;

  before(async () => {
    await buildRepo();
    jira = new FakeJira([...corpusIssues, queryIssue, issue({ id: '900', key: 'PROJX-1', summary: 'Excluded project ticket' })]);
    judge = fakeJudge();
    lineageGit = new LocalLineageGit();
    const typed: LineageGitLike = new LineageGit({ testOnlyAllowLocalRemotes: true }); // LineageGit satisfies the structural interface
    assert.ok(typed);
    service = createPrecedentService({ config: config(), dataDir: join(root, 'data'), jira, branchMap: async () => BRANCH_MAP, lineageGit, embedding: embedder(), judge });
  });
  after(async () => { service?.close(); await rm(root, { recursive: true, force: true }); });

  it('reports INDEX_NOT_READY before the first full sync', async () => {
    const { result, markdown } = await service.lookup(lookupRequest(queryIssue));
    assert.equal(result.outcome, 'INDEX_NOT_READY');
    assert.ok(semanticPrecedentResultSchema.safeParse(result).success);
    assert.match(markdown, /not ready/);
    assert.equal((await service.status()).ready, false);
  });

  it('full sync indexes in-scope projects, scans the lineage and builds nodes', async () => {
    const reports = await service.sync({ full: true });
    assert.deepEqual(reports.map((r) => [r.mode, r.complete, r.error_code]), [['full', true, null], ['mirrors', true, null]]);
    assert.ok((reports[1]?.fixes_found ?? 0) >= 3, JSON.stringify(reports));
    assert.ok(jira.searches.every((s) => !s.projects.includes('PROJX') && !s.projects.includes('PROJZ')), 'excluded and disabled projects are out of scope');
    const status = await service.status();
    assert.ok(precedentIndexStatusSchema.safeParse(status).success);
    assert.equal(status.ready, true);
    assert.deepEqual(status.projects, ['PROJA', 'PROJB', 'PROJC', 'PROJD']);
    assert.ok(status.last_full_sync_at && status.last_mirror_scan_at && status.last_sync_at);
    assert.equal(status.last_error_code, null);
    assert.equal(status.embedding_model, 'fake-embed');
    const lineage = await service.lineage();
    assert.deepEqual(lineage.nodes.map((n) => n.project_key).sort(), ['PROJA', 'PROJB', 'PROJC', 'PROJE']);
    assert.deepEqual(lineage.missing, []);
  });

  it('finds the fixed relative with real lineage evidence and keeps also-reported tickets separate', async () => {
    judge.mode = 'yes'; judge.requests.length = 0;
    const { result, markdown } = await service.lookup(lookupRequest(queryIssue));
    assert.equal(result.outcome, 'FOUND', markdown);
    assert.equal(result.judge, 'RAN');
    assert.deepEqual(result.items.map((i) => [i.issue_key, i.kind]), [['PROJB-55', 'FIXED_IN_RELATIVE']], markdown);
    const fix = result.items[0]!.fix!;
    assert.equal(fix.branch, 'projb');
    assert.deepEqual(fix.commit_shas, [fixSha]);
    assert.equal(fix.inherited, true, 'the buggy line predates the proja fork');
    assert.equal(fix.applies_cleanly, true);
    assert.deepEqual(fix.ported_to, ['projc']);
    assert.match(fix.evidence_url, new RegExp(`^https://bitbucket\\.org/acme/core/commits/${fixSha}$`));
    assert.match(fix.diff_excerpt ?? '', /PricingEngine\.java/);
    assert.deepEqual(result.also_reported.map((i) => i.issue_key), ['PROJB-60']);
    assert.match(markdown, /Same bug may be open in other projects/);
    assert.equal(judge.requests.length, 1);
    assert.equal(judge.requests[0]?.job_id, 'job-1');
    assert.equal(judge.requests[0]?.issue_key, 'PROJA-100');
    found = result;
  });

  it('abstains with NO_MATCH on a keyword trap', async () => {
    const { result, markdown } = await service.lookup(lookupRequest(abstainQuery, 'job-2'));
    assert.equal(result.outcome, 'NO_MATCH', markdown);
    assert.deepEqual(result.items, []);
    assert.match(markdown, /NO_MATCH/);
  });

  it('falls back to NOT_RUN with the strict threshold when the judge fails', async () => {
    judge.mode = 'throw';
    const { result } = await service.lookup(lookupRequest(queryIssue, 'job-3'));
    judge.mode = 'yes';
    assert.equal(result.judge, 'NOT_RUN');
    assert.deepEqual(result.items.map((i) => i.issue_key), ['PROJB-55']);
    assert.deepEqual(result.also_reported, []);
  });

  it('renders the SWE block with diffs and the reviewer block with files only', () => {
    const swe = service.referenceBlock(found, 'swe', NONCE, 20_480);
    assert.ok(swe.includes(`<<<REFERENCE id=${NONCE}`) && swe.includes('PROJB-55') && /diff --git/.test(swe));
    assert.ok(!swe.includes('PROJB-60'), 'also-reported tickets never reach agents');
    const reviewer = service.referenceBlock(found, 'reviewer', NONCE, 20_480);
    assert.ok(reviewer.includes('PROJB-55') && reviewer.includes(PRICING));
    assert.ok(!/diff --git|@@/.test(reviewer) && !reviewer.includes('PROJB-60'));
    assert.ok(Buffer.byteLength(service.referenceBlock(found, 'swe', NONCE, 2048)) <= 2048);
    const none: SemanticPrecedentResult = { ...found, outcome: 'NO_MATCH', items: [], also_reported: [] };
    assert.equal(service.referenceBlock(none, 'swe', NONCE, 20_480), '');
    assert.equal(service.referenceBlock(none, 'reviewer', NONCE, 20_480), '');
  });

  it('lists possibly affected open tickets and branches without the same patch', async () => {
    const { affected, markdown } = await service.possiblyAffected({ job_id: 'job-1', issue_key: 'PROJA-100', project_key: 'PROJA', development_branch: 'proja',
      commit_sha: 'f'.repeat(40), patch: fixPatch, changed_paths: [PRICING], routing: found });
    assert.deepEqual(affected.open_tickets.map((t) => t.issue_key), ['PROJB-60']);
    assert.match(affected.open_tickets[0]!.evidence.join(' '), /Same error signature/);
    assert.deepEqual(affected.branches.map((b) => [b.project_key, b.branch, b.applies]), [['PROJE', 'proje', 'clean']], 'projb/projc already carry the patch; PROJD is another lineage');
    assert.match(markdown, /May also affect/);
    assert.match(markdown, /should be checked/);
    const none = await service.possiblyAffected({ job_id: 'job-1', issue_key: 'PROJA-100', project_key: 'PROJA', development_branch: 'proja',
      commit_sha: 'f'.repeat(40), patch: fixPatch, changed_paths: [PRICING], routing: null });
    assert.deepEqual(none.affected.open_tickets, []);
  });

  it('computes the same stable patch-id as git', async () => {
    const fromGit = (await execFile('sh', ['-c', `git show ${fixSha} | git patch-id --stable`], { cwd: source, encoding: 'utf8' })).stdout.split(' ')[0];
    assert.equal(stablePatchId(fixPatch), fromGit);
  });

  it('searches by key or text, and shows indexed facts', async () => {
    const byKey = await service.search({ issue_key: 'PROJA-100', explain: true, judge: false });
    assert.ok(semanticPrecedentResultSchema.safeParse(byKey.result).success);
    assert.ok(byKey.explain.length > 0);
    const byText = await service.search({ text: 'Discount applied twice when the coupon is re-entered. PricingRuleException in PricingEngine.java', judge: false });
    assert.ok(semanticPrecedentResultSchema.safeParse(byText.result).success);
    assert.deepEqual(byText.explain, []);
    await assert.rejects(service.search({ issue_key: 'PROJA-999' }), (e: unknown) => e instanceof AutosError && e.code === 'NOT_FOUND');
    const shown = await service.show('PROJB-55') as { fixes: Array<{ commit_sha: string }>; issue: { key: string } };
    assert.equal(shown.issue.key, 'PROJB-55');
    assert.ok(shown.fixes.some((f) => f.commit_sha === fixSha));
    assert.equal(await service.show('PROJA-999'), null);
  });

  it('purges a project', async () => {
    const before = (await service.status()).issues;
    assert.deepEqual(await service.purgeProject('PROJC'), { issues_deleted: 3 });
    const status = await service.status();
    assert.equal(status.issues, before - 3);
    assert.ok(!status.projects.includes('PROJC'));
    await assert.rejects(service.purgeProject('projc'), (e: unknown) => e instanceof AutosError && e.code === 'INVALID_INPUT');
  });
});

describe('precedent service scheduling', () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'autos-precedent-tick-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  function setup(name: string, over: { config?: Record<string, unknown>; attempts?: AutosAttemptRecord[]; branchMap?: () => Promise<ProjectMapping[]> } = {}) {
    const clock = { t: Date.parse('2026-11-12T08:00:00.000Z') };
    const jira = new FakeJira(corpusIssues);
    const logs: Array<Record<string, unknown>> = [];
    const service = createPrecedentService({
      config: config(over.config), dataDir: join(dir, name), jira, branchMap: over.branchMap ?? (async () => BRANCH_MAP), lineageGit: null, embedding: null, judge: null,
      ...(over.attempts ? { autosAttempts: async () => over.attempts! } : {}), now: () => new Date(clock.t), log: (r) => logs.push(r),
    });
    return { clock, jira, service, logs, advance: (minutes: number) => { clock.t += minutes * 60_000; } };
  }

  it('runs Jira sync and reconcile only when due', async () => {
    const { jira, service, advance, logs } = setup('due');
    await service.tick();
    assert.equal(jira.searches.length, 1); assert.equal(jira.searches[0]?.since, null, 'first run is a full sync');
    assert.equal(jira.lists, 0, 'no reconcile before the first full sync');
    const s1 = await service.status();
    assert.equal(s1.ready, true); assert.ok(s1.last_sync_at); assert.equal(s1.last_reconcile_at, null);
    await service.tick();
    assert.equal(jira.searches.length, 1, 'not due yet');
    advance(16);
    await service.tick();
    assert.equal(jira.searches.length, 2); assert.ok(jira.searches[1]?.since, 'incremental with overlap');
    assert.equal(jira.lists, 1, 'reconcile due after the first full sync');
    assert.ok((await service.status()).last_reconcile_at);
    advance(16); await service.tick();
    assert.equal(jira.searches.length, 3); assert.equal(jira.lists, 1, 'reconcile not due again yet');
    advance(25 * 60); await service.tick();
    assert.equal(jira.lists, 2);
    const text = JSON.stringify(logs);
    assert.ok(!text.includes('applied twice') && !text.includes('Coupon'), 'logs carry no ticket text');
    service.close();
  });

  it('is single-flight', async () => {
    const { jira, service } = setup('single');
    jira.delayMs = 30;
    await Promise.all([service.tick(), service.tick(), service.tick()]);
    assert.equal(jira.searches.filter((s) => s.token === null).length, 1);
    const running = service.tick();
    assert.equal((await service.status()).running, true);
    await running;
    service.close();
  });

  it('never throws: Jira 401 and branch-map failures become last_error_code', async () => {
    const a = setup('auth');
    a.jira.failWith = new AutosError('AUTH', 'Jira authentication failed');
    await a.service.tick();
    const s = await a.service.status();
    assert.equal(s.last_error_code, 'AUTH'); assert.equal(s.ready, false);
    a.service.close();
    const b = setup('map', { branchMap: async () => { throw new AutosError('UPSTREAM', 'Confluence unavailable'); } });
    await b.service.tick();
    assert.equal((await b.service.status()).last_error_code, 'UPSTREAM');
    assert.equal(b.jira.searches.length, 0);
    b.service.close();
  });

  it('does nothing when auto_sync is off; sync() still works', async () => {
    const { jira, service } = setup('manual', { config: { index: { auto_sync: false, exclude_projects: ['PROJX'], min_request_interval_ms: 0 } } });
    await service.tick();
    assert.equal(jira.searches.length, 0);
    const reports = await service.sync({});
    assert.equal(reports[0]?.mode, 'full');
    service.close();
  });

  it('records Autos attempts as fixes; abandoned attempts never count', async () => {
    const attempts: AutosAttemptRecord[] = [
      { job_id: 'j1', issue_key: 'PROJB-60', repository_id: 'acme/core', commit_sha: 'd'.repeat(40), changed_paths: [PRICING, '../etc/passwd'], outcome: 'merged' },
      { job_id: 'j2', issue_key: 'PROJC-78', repository_id: 'acme/core', commit_sha: 'e'.repeat(40), changed_paths: ['x/Y.java'], outcome: 'abandoned' },
      { job_id: 'j3', issue_key: 'PROJD-9', repository_id: 'acme/platform', commit_sha: 'c'.repeat(40), changed_paths: ['a.ts'], outcome: 'merged' },
    ];
    const { service } = setup('autos', { attempts });
    await service.tick();
    const merged = await service.show('PROJB-60') as { fixes: Array<{ autos_outcome: string; files: string[]; reverted: boolean }> };
    assert.deepEqual(merged.fixes.map((f) => [f.autos_outcome, f.files, f.reverted]), [['merged', [PRICING], false]]);
    const abandoned = await service.show('PROJC-78') as { fixes: Array<{ reverted: boolean }> };
    assert.deepEqual(abandoned.fixes.map((f) => f.reverted), [true]);
    assert.deepEqual((await service.show('PROJD-9') as { fixes: unknown[] }).fixes, [], 'no lineage for that repository');
    service.close();
  });

  it('rejects configurations without semantic precedents', () => {
    const c = config(); delete c.precedents;
    assert.throws(() => createPrecedentService({ config: c, dataDir: join(dir, 'x'), jira: new FakeJira([]), branchMap: async () => [], lineageGit: null, embedding: null, judge: null }),
      (e: unknown) => e instanceof AutosError && e.code === 'INVALID_CONFIG');
    assert.throws(() => createPrecedentService({ config: config({ source: 'legacy' }), dataDir: join(dir, 'y'), jira: new FakeJira([]), branchMap: async () => [], lineageGit: null, embedding: null, judge: null }),
      (e: unknown) => e instanceof AutosError && e.code === 'INVALID_CONFIG');
  });

  it('returns no reference block for roles not configured', () => {
    const { service } = setup('roles', { config: { prompt: { roles: [] } } });
    const r = semanticPrecedentResultSchema.parse({ schema_version: 1, outcome: 'NO_MATCH', judge: 'SKIPPED', items: [], also_reported: [], rejected: [], checked: 0, index: null });
    assert.equal(service.referenceBlock(r, 'swe', NONCE, 20_480), '');
    service.close();
  });
});
