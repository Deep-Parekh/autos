/** Shared fakes for the semantic-precedent and fix-document workflow tests (not a test file itself). */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfigYaml, precedentsConfigSchema, type ConfluenceDraftRef, type FixDocumentData, type FixDocumentDraftPort, type GitWorkspace, type IssueSnapshot, type PossiblyAffected,
  type ProjectMapping, type ProviderResult, type SemanticPrecedent, type SemanticPrecedentPort, type SemanticPrecedentResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

export const BASE = 'b'.repeat(40);
export const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
export const sha = (n: number) => n.toString(16).padStart(64, '0');
export const commitSha = (n: number) => String(n).repeat(40).slice(0, 40);

export const precedent = (key: string, kind: SemanticPrecedent['kind']): SemanticPrecedent => ({
  issue_key: key, issue_url: `https://example.atlassian.net/browse/${key}`, project_key: key.split('-')[0]!, summary: `Order total wrong (${key})`, status: kind === 'ALSO_REPORTED' ? 'Open' : 'Done',
  resolution: kind === 'ALSO_REPORTED' ? null : 'Fixed', kind, score: 0.9, signals: ['semantic', 'error_signature'], judge: { verdict: 'yes', confidence: 0.86 },
  fix: kind === 'ALSO_REPORTED' ? null : { lineage_id: 'core', branch: 'release/projb', commit_shas: ['d'.repeat(40)], patch_id: 'e'.repeat(40), evidence_url: 'https://bitbucket.org/example/sample-app/commits/' + 'd'.repeat(40),
    files: ['src/Order.java'], diff_excerpt: '+fixed rounding', applies_cleanly: true, inherited: true, ported_to: [] },
  caveats: [],
});
export const foundResult = (): SemanticPrecedentResult => ({ schema_version: 1, outcome: 'FOUND', judge: 'RAN', items: [precedent('PROJB-881', 'FIXED_IN_RELATIVE'), precedent('PROJD-12', 'ALREADY_PRESENT_HERE')],
  also_reported: [precedent('PROJC-7', 'ALSO_REPORTED')], rejected: [{ issue_key: 'PROJC-77', reason: 'keyword overlap only' }], checked: 4, index: null });
export const noMatch = (): SemanticPrecedentResult => ({ schema_version: 1, outcome: 'NO_MATCH', judge: 'SKIPPED', items: [], also_reported: [], rejected: [], checked: 2, index: null });
export const affectedFor = (commit: string): PossiblyAffected => ({ schema_version: 1, issue_key: 'SAMPLE-1', commit_sha: commit,
  open_tickets: [{ issue_key: 'PROJC-7', project_key: 'PROJC', summary: 'Same total bug', status: 'Open', evidence: ['same file src/Fix.java'] }],
  branches: [{ lineage_id: 'core', project_key: 'PROJD', branch: 'projd_dev', applies: 'clean', inherited: true, evidence: ['changed lines predate the fork'] }] });
export const draftRef = (page: string, version = 1): ConfluenceDraftRef => ({ page_id: page, space_id: '55', version, status: 'draft', edit_url: `https://example.atlassian.net/wiki/pages/resumedraft.action?draftId=${page}` });

export interface Harness {
  root: string; config: ReturnType<typeof parseConfigYaml>; ids: number; digest: number; commits: number; issue: Partial<IssueSnapshot>; diff: string;
  prompts: Array<{ role: string; text: string }>; calls: string[];
  lookups: Array<Parameters<SemanticPrecedentPort['lookup']>[0]>; blocks: Array<{ role: string; nonce: string; maxBytes: number }>; affectedRequests: Array<Parameters<SemanticPrecedentPort['possiblyAffected']>[0]>;
  drafts: Array<{ data: FixDocumentData; previous: ConfluenceDraftRef | null }>;
  lookup: SemanticPrecedentPort['lookup']; referenceBlock: SemanticPrecedentPort['referenceBlock']; possiblyAffected: SemanticPrecedentPort['possiblyAffected']; createOrUpdate: FixDocumentDraftPort['createOrUpdate'];
}

/** Default reference block: a nonce-delimited block filled to `size` bytes (never above maxBytes). */
export const defaultBlock = (size = 2048, extra = '') => (_r: SemanticPrecedentResult, _role: 'swe' | 'reviewer', nonce: string, maxBytes: number): string => {
  const open = `## Reference (untrusted, id=${nonce})\n<<<REFERENCE id=${nonce}\nFIXED_IN_RELATIVE PROJB-881\n${extra}`; const close = `\nREFERENCE id=${nonce}>>>`;
  const target = Math.min(size, maxBytes); const fill = Math.max(0, target - Buffer.byteLength(open + close));
  return `${open}${'r'.repeat(fill)}${close}`;
};

export async function newHarness(root: string): Promise<Harness> {
  const config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
  const h: Harness = { root, config, ids: 0, digest: 1, commits: 0, issue: {}, diff: '', prompts: [], calls: [], lookups: [], blocks: [], affectedRequests: [], drafts: [],
    lookup: async () => ({ result: foundResult(), markdown: '# Precedents (4 checked, 2 shown; judge RAN)\n\nSemantic markdown.\n' }),
    referenceBlock: defaultBlock(),
    possiblyAffected: async (req) => ({ affected: affectedFor(req.commit_sha), markdown: '## May also affect\n\nAdvisory only.\n\n- PROJC-7 may be the same issue.\n' }),
    createOrUpdate: async (_data, previous) => ({ draft: previous ? { ...previous, version: previous.version + 1 } : draftRef('1001'), superseded_page_id: null }),
  };
  return h;
}

export const semanticConfig = (overrides: Record<string, unknown> = {}) => precedentsConfigSchema.parse({ enabled: true, source: 'semantic', prompt: { roles: ['swe'] }, ...overrides });

export function deps(h: Harness, store: SqliteJobStore, artifacts: FileArtifactStore, wire: { semantic?: boolean; drafts?: boolean } = { semantic: true, drafts: true }): WorkflowDependencies {
  const repo = () => h.config.bitbucket.allowed_repositories[0]!;
  const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open',
    updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', comments: [], linked_issue_keys: ['SAMPLE-9'], components: [], url: `https://example.atlassian.net/browse/${key}`, ...h.issue } as IssueSnapshot);
  const semanticPrecedents: SemanticPrecedentPort = {
    lookup: async (req, signal) => { h.calls.push('lookup'); h.lookups.push(req); return h.lookup(req, signal); },
    referenceBlock: (result, role, nonce, maxBytes) => { h.blocks.push({ role, nonce, maxBytes }); return h.referenceBlock(result, role, nonce, maxBytes); },
    possiblyAffected: async (req, signal) => { h.calls.push('possiblyAffected'); h.affectedRequests.push(req); return h.possiblyAffected(req, signal); },
  };
  const fixDocuments: FixDocumentDraftPort = { createOrUpdate: async (data, previous, signal) => { h.calls.push('draft'); h.drafts.push({ data, previous }); return h.createOrUpdate(data, previous, signal); } };
  return {
    config: h.config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return ['SAMPLE-1', 'SAMPLE-2']; },
      async listIssues() { return [issue('SAMPLE-1')]; },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { h.calls.push('legacy'); return { outcome: 'NO_MATCH' as const, items: [] }; } },
    ...(wire.semantic ? { semanticPrecedents } : {}),
    ...(wire.drafts ? { fixDocuments } : {}),
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        const directory = join(h.root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}`, ...(req.continue_from ? { start_sha: req.continue_from.parent_commit_sha } : {}) } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(h.digest), paths: ['src/Fix.java'], diff: `diff --git a/src/Fix.java b/src/Fix.java\n@@ -1 +1 @@\n+ fixed v${h.digest}\n${h.diff}` }; },
      async commit(req) { h.commits++; return { commit_sha: commitSha(h.commits), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, sha) { return { status: 'DISABLED' as const, commit_sha: sha }; },
    },
    runner: {
      async runRole(req) {
        h.prompts.push({ role: req.role, text: await readFile(req.prompt_path, 'utf8') });
        const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (req.role === 'swe') { h.digest++; return { ...base, result: { summary: 'Fixed the rounding in Fix.java.' } } as ProviderResult; }
        const d = sha(h.digest);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['Acceptance criteria checked'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        return { schema_version: 1, candidate_digest: d, recorded_at: '2026-11-07T20:00:00.000Z', checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
    },
  };
}

export function open(h: Harness, wire?: { semantic?: boolean; drafts?: boolean }) {
  const store = new SqliteJobStore(join(h.config.storage.data_dir, 'autos.sqlite')); const artifacts = new FileArtifactStore(h.config.storage.artifacts_dir);
  const service = new WorkflowService(deps(h, store, artifacts, wire), { id: () => `00000000-0000-4000-8000-${String(++h.ids).padStart(12, '0')}` });
  return { store, artifacts, service };
}
export const artifactPath = (h: Harness, jobId: string, name: string) => join(h.config.storage.artifacts_dir, jobId, name);
export const readText = (h: Harness, jobId: string, name: string) => readFile(artifactPath(h, jobId, name), 'utf8');
export const readJson = async (h: Harness, jobId: string, name: string) => JSON.parse(await readText(h, jobId, name)) as Record<string, any>;
export const exists = async (h: Harness, jobId: string, name: string) => { try { await readFile(artifactPath(h, jobId, name)); return true; } catch { return false; } };
export const ready = async (service: WorkflowService, key = 'SAMPLE-1') => {
  const job = await service.execute((await service.submit(key, false)).job_id); assert.equal(job.state, 'READY_FOR_HUMAN', job.blocked_reason ?? undefined); return job;
};
