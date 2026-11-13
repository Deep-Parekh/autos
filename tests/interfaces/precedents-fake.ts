import { readFile } from 'node:fs/promises';
import {
  parseConfigYaml, precedentsConfigSchema,
  type AutosConfig, type ConfluenceDraftRecord, type LineageNode, type PrecedentIndexPort, type PrecedentIndexStatus, type PrecedentSearchQuery, type PrecedentSyncReport, type SemanticPrecedent, type SemanticPrecedentResult,
} from '@autos/contracts';

export const canonicalYaml = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
export const baseConfig = parseConfigYaml(canonicalYaml);
export const SECRET_TEXT = 'NULLPOINTER-MARKER in OrderService checkout';
export const SECRET_SUMMARY = 'ZEBRA-SUMMARY totals wrong after discount';
export const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
export const JOB = '00000000-0000-4000-8000-000000000042';

/** Example config plus a semantic precedents section (and optionally Confluence drafts). */
export function precedentConfig(options: { enabled?: boolean; auto_sync?: boolean; drafts?: boolean; lineage?: boolean } = {}): AutosConfig {
  const repo = baseConfig.bitbucket.allowed_repositories[0]!;
  const precedents = precedentsConfigSchema.parse({
    enabled: options.enabled ?? true, source: 'semantic',
    lineages: options.lineage === false ? [] : [{ id: 'core', repository: { workspace: repo.workspace, repository_slug: repo.repository_slug }, root_branch: 'master' }],
    index: { auto_sync: options.auto_sync ?? true },
    embedding: { provider: 'ollama', model: 'example-embed:0.6b', dimensions: 1024 },
  });
  return { ...baseConfig, precedents, confluence: { ...baseConfig.confluence, ...(options.drafts ? { drafts: { enabled: true, space_key: 'ENG', parent_page_id: '4242', auto: false } } : {}) } };
}

export const status = (extra: Partial<PrecedentIndexStatus> = {}): PrecedentIndexStatus => ({
  enabled: true, source: 'semantic', ready: true, issues: 120, chunks: 340, vectors: 340, fixes: 31, projects: ['SAMPLE', 'OTHER'], embedding_model: 'example-embed:0.6b',
  last_sync_at: '2026-11-12T11:45:00.000Z', last_full_sync_at: '2026-11-10T02:00:00.000Z', last_reconcile_at: '2026-11-12T02:00:00.000Z', last_mirror_scan_at: '2026-11-12T11:45:00.000Z', last_error_code: null, running: false, ...extra,
});
export const report = (mode: PrecedentSyncReport['mode'] = 'incremental'): PrecedentSyncReport => ({ mode, started_at: '2026-11-12T12:00:00.000Z', finished_at: '2026-11-12T12:01:00.000Z', issues_upserted: 7, issues_deleted: 1, chunks_embedded: 20, fixes_found: 2, requests: 15, complete: true, error_code: null });
export const precedent = (kind: SemanticPrecedent['kind'], key: string, summary = SECRET_SUMMARY): SemanticPrecedent => ({
  issue_key: key, issue_url: `https://example.atlassian.net/browse/${key}`, project_key: key.split('-')[0]!, summary, status: 'Done', resolution: 'Fixed', kind, score: 0.82,
  signals: ['semantic', 'lineage'], judge: { verdict: 'yes', confidence: 0.86 },
  fix: kind === 'ALSO_REPORTED' ? null : { lineage_id: 'core', branch: 'release/projb', commit_shas: [SHA], patch_id: null, evidence_url: `https://bitbucket.org/example/sample-app/commits/${SHA}`, files: ['src/OrderService.java'], diff_excerpt: null, applies_cleanly: true, inherited: true, ported_to: [] },
  caveats: [],
});
export const found: SemanticPrecedentResult = {
  schema_version: 1, outcome: 'FOUND', judge: 'RAN', items: [precedent('FIXED_IN_RELATIVE', 'OTHER-881')], also_reported: [precedent('ALSO_REPORTED', 'THIRD-5')],
  rejected: [{ issue_key: 'OTHER-77', reason: 'keyword overlap only' }], checked: 3, index: { as_of: '2026-11-12T11:45:00.000Z', issues: 120, model: 'example-embed:0.6b' },
};
export const node: LineageNode = { lineage_id: 'core', project_key: 'SAMPLE', branch: 'release/sample', fork_point: SHA, fork_date: '2021-06-01T00:00:00.000Z', side_branches: [{ branch: 'sample_dev', kind: 'dev', method: 'name' }] };
export const draftRecord = (issueKey = 'SAMPLE-1'): ConfluenceDraftRecord => ({ schema_version: 1, job_id: JOB, issue_key: issueKey, draft: { page_id: '777', space_id: '99', version: 1, status: 'draft', edit_url: 'https://example.atlassian.net/wiki/pages/resumedraft.action?draftId=777' }, created_at: '2026-11-12T12:00:00.000Z', supersedes_page_id: null });

/** A gate the test opens to finish a blocked call. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

export interface FakeIndex extends PrecedentIndexPort {
  calls: Array<{ kind: string; args: unknown[] }>;
  ticks: number;
  tickSignals: AbortSignal[];
}
export function fakeIndex(overrides: Partial<PrecedentIndexPort> = {}): FakeIndex {
  const calls: FakeIndex['calls'] = [];
  const index: FakeIndex = {
    calls, ticks: 0, tickSignals: [],
    status: async () => status(),
    sync: async (options) => { calls.push({ kind: 'sync', args: [options] }); return [report(options.full ? 'full' : 'incremental')]; },
    rebuild: async () => { calls.push({ kind: 'rebuild', args: [] }); return [report('rebuild')]; },
    purgeProject: async (key) => { calls.push({ kind: 'purge', args: [key] }); return { issues_deleted: 12 }; },
    lineage: async () => { calls.push({ kind: 'lineage', args: [] }); return { nodes: [node], unattached: ['feature/x'], missing: [] }; },
    search: async (query: PrecedentSearchQuery) => { calls.push({ kind: 'search', args: [query] }); return { result: found, related: [], explain: query.explain ? [{ issue_key: 'OTHER-881', stage: 'gate', passed: true }] : [] }; },
    show: async (key) => { calls.push({ kind: 'show', args: [key] }); return key === 'OTHER-881' ? { issue_key: key, summary: SECRET_SUMMARY, fixes: [SHA] } : null; },
    tick: async (signal) => { index.ticks++; if (signal) index.tickSignals.push(signal); },
    close: () => undefined,
    ...overrides,
  };
  return index;
}
