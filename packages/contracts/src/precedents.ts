import { z } from 'zod';
import { branchNameSchema, gitShaSchema, identifierSchema, issueKeySchema, timestampSchema } from './domain.js';

/**
 * Shared contracts for semantic precedent search (docs/semantic-precedents-plan.md).
 * Not wired into AutosConfig or the workflow yet: packages build against these types first; integration comes later.
 */

const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*$/);
const branchGlobSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/*{}-]+$/);
const relPathSchema = z.string().min(1).max(1000).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'Relative path without ..');

// ---- Lineages (§2) ----

/** One root repository and the branches cut from it. Lineages never share history with each other. */
export const lineageConfigSchema = z.strictObject({
  id: identifierSchema,
  repository: z.strictObject({ workspace: identifierSchema, repository_slug: identifierSchema }),
  root_branch: branchNameSchema,
  /** Refs scanned for fix commits; dev/sbx branches included by default. */
  scan_branches: z.array(branchGlobSchema).min(1).default(['**']),
  ignore_branches: z.array(branchGlobSchema).default([]),
  /** Jira project key -> branch code, when `<code>_dev` / `<code>_sbx` cannot be inferred by name or ancestry. */
  branch_codes: z.record(projectKeySchema, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)).default({}),
});
export type LineageConfig = z.infer<typeof lineageConfigSchema>;

export const LINEAGE_ATTACH_METHODS = ['name', 'ancestry', 'override'] as const;
/** A Jira project's development branch in a lineage, with its fork point from the root branch. */
export const lineageNodeSchema = z.strictObject({
  lineage_id: identifierSchema,
  project_key: projectKeySchema,
  branch: branchNameSchema,
  fork_point: gitShaSchema,
  fork_date: timestampSchema,
  /** Attached `<code>_dev` / `<code>_sbx` branches and how each was attached. */
  side_branches: z.array(z.strictObject({ branch: branchNameSchema, kind: z.enum(['dev', 'sbx']), method: z.enum(LINEAGE_ATTACH_METHODS) })),
});
export type LineageNode = z.infer<typeof lineageNodeSchema>;

// ---- Indexed Jira issues (§3.1) ----

export const indexedCommentSchema = z.strictObject({
  id: z.string().regex(/^[0-9]+$/),
  author_is_app: z.boolean(),
  created: timestampSchema,
  body: z.string(),
});
export type IndexedComment = z.infer<typeof indexedCommentSchema>;

/** One Jira issue as read for the index. Restricted issues/comments are dropped before this shape is built. */
export const indexedIssueSchema = z.strictObject({
  id: z.string().regex(/^[0-9]+$/),
  key: issueKeySchema,
  project_key: projectKeySchema,
  issue_type: z.string(),
  status: z.string(),
  resolution: z.string().nullable(),
  resolved_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  summary: z.string(),
  description: z.string(),
  components: z.array(z.string()),
  labels: z.array(z.string()),
  link_keys: z.array(issueKeySchema),
  parent_key: issueKeySchema.nullable(),
  comments: z.array(indexedCommentSchema),
  /** True when the issue page did not include every comment and the rest must be fetched separately. */
  comments_truncated: z.boolean(),
});
export type IndexedIssue = z.infer<typeof indexedIssueSchema>;

// ---- Fix links (§3.3) ----

export const FIX_SOURCES = ['commit_message', 'branch_name', 'merge_message', 'autos'] as const;
export const fixCommitSchema = z.strictObject({
  lineage_id: identifierSchema,
  commit_sha: gitShaSchema,
  /** `git patch-id --stable`; equal patch-ids on different branches mean the same change was ported. */
  patch_id: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  issue_keys: z.array(issueKeySchema).min(1),
  source: z.enum(FIX_SOURCES),
  committed_at: timestampSchema,
  subject: z.string().max(500),
  files: z.array(z.strictObject({ path: relPathSchema, additions: z.number().int().min(0).nullable(), deletions: z.number().int().min(0).nullable() })).max(500),
  /** Branches (lineage nodes or their side branches) that contain this commit. */
  contained_in: z.array(branchNameSchema),
  reverted_by: gitShaSchema.nullable(),
});
export type FixCommit = z.infer<typeof fixCommitSchema>;

// ---- Retrieval results (§5) ----

export const PRECEDENT_KINDS = ['ALSO_REPORTED', 'FIXED_IN_RELATIVE', 'ALREADY_PRESENT_HERE', 'RELATED_FIX'] as const;
export const PRECEDENT_SIGNALS = ['semantic', 'keyword', 'error_signature', 'code_overlap', 'lineage', 'jira_link', 'near_duplicate', 'patch_id', 'autos_merged'] as const;
export const precedentKindSchema = z.enum(PRECEDENT_KINDS);
export const precedentSignalSchema = z.enum(PRECEDENT_SIGNALS);

export const semanticPrecedentSchema = z.strictObject({
  issue_key: issueKeySchema,
  issue_url: z.url(),
  project_key: projectKeySchema,
  summary: z.string().max(300),
  status: z.string().max(100),
  resolution: z.string().max(100).nullable(),
  kind: precedentKindSchema,
  score: z.number().min(0).max(1),
  signals: z.array(precedentSignalSchema).min(1),
  judge: z.strictObject({ verdict: z.enum(['yes', 'likely']), confidence: z.number().min(0).max(1) }).nullable(),
  fix: z.strictObject({
    lineage_id: identifierSchema,
    branch: branchNameSchema,
    commit_shas: z.array(gitShaSchema).min(1).max(5),
    patch_id: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
    evidence_url: z.url(),
    files: z.array(relPathSchema).max(50),
    diff_excerpt: z.string().nullable(),
    applies_cleanly: z.boolean().nullable(),
    inherited: z.boolean().nullable(),
    ported_to: z.array(branchNameSchema),
  }).nullable(),
  caveats: z.array(z.string()),
});
export type SemanticPrecedent = z.infer<typeof semanticPrecedentSchema>;

export const rejectedCandidateSchema = z.strictObject({ issue_key: issueKeySchema, reason: z.string().max(300) });
export type RejectedCandidate = z.infer<typeof rejectedCandidateSchema>;

export const semanticPrecedentResultSchema = z.strictObject({
  schema_version: z.literal(1),
  outcome: z.enum(['FOUND', 'NO_MATCH', 'DISABLED', 'INDEX_NOT_READY']),
  judge: z.enum(['RAN', 'NOT_RUN', 'SKIPPED']),
  /** At most 5 shown items; RELATED_FIX never appears here (CLI search only). */
  items: z.array(semanticPrecedentSchema).max(5),
  /** ALSO_REPORTED tickets: listed for the operator, never given to agents. */
  also_reported: z.array(semanticPrecedentSchema).max(10),
  rejected: z.array(rejectedCandidateSchema).max(50),
  checked: z.number().int().min(0),
  index: z.strictObject({ as_of: timestampSchema, issues: z.number().int().min(0), model: z.string() }).nullable(),
}).refine((r) => r.items.every((i) => i.kind !== 'RELATED_FIX' && i.kind !== 'ALSO_REPORTED'), 'Shown items must be fix precedents')
  .refine((r) => r.also_reported.every((i) => i.kind === 'ALSO_REPORTED'), 'also_reported holds only ALSO_REPORTED items')
  .refine((r) => r.outcome === 'FOUND' ? r.items.length + r.also_reported.length > 0 : r.items.length === 0 && r.also_reported.length === 0, 'Outcome does not match items');
export type SemanticPrecedentResult = z.infer<typeof semanticPrecedentResultSchema>;

// ---- Judge (§5 stage 4) ----

export const judgeVerdictSchema = z.strictObject({
  issue_key: issueKeySchema,
  same_defect: z.enum(['yes', 'likely', 'no']),
  confidence: z.number().min(0).max(1),
  shared_evidence: z.array(z.string().max(500)).max(10),
  differences: z.array(z.string().max(500)).max(10),
});
export const judgeOutputSchema = z.strictObject({ schema_version: z.literal(1), verdicts: z.array(judgeVerdictSchema).max(10) });
export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

// ---- Possibly affected (§7) ----

export const possiblyAffectedSchema = z.strictObject({
  schema_version: z.literal(1),
  issue_key: issueKeySchema,
  commit_sha: gitShaSchema,
  open_tickets: z.array(z.strictObject({ issue_key: issueKeySchema, project_key: projectKeySchema, summary: z.string().max(300), status: z.string().max(100), evidence: z.array(z.string().max(300)).min(1) })).max(20),
  branches: z.array(z.strictObject({ lineage_id: identifierSchema, project_key: projectKeySchema, branch: branchNameSchema, applies: z.enum(['clean', 'needs_adaptation', 'unknown']), inherited: z.boolean().nullable(), evidence: z.array(z.string().max(300)).min(1) })).max(50),
});
export type PossiblyAffected = z.infer<typeof possiblyAffectedSchema>;

// ---- Ports ----

export interface EmbeddingPort {
  model(): { id: string; dims: number };
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Created draft page (Confluence). Only ids and links; never content. */
export const confluenceDraftRefSchema = z.strictObject({
  page_id: z.string().regex(/^[0-9]+$/),
  space_id: z.string().regex(/^[0-9]+$/),
  version: z.number().int().positive(),
  status: z.literal('draft'),
  edit_url: z.url(),
});
export type ConfluenceDraftRef = z.infer<typeof confluenceDraftRefSchema>;

// ---- Configuration (§6.4, §12). Absent `precedents` = legacy behaviour, unchanged. ----

export const precedentsConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** legacy = the existing keyword/component lookup; semantic = this plan. */
  source: z.enum(['legacy', 'semantic']).default('legacy'),
  lineages: z.array(lineageConfigSchema).max(20).default([]),
  /** Shown fix precedents per job (precedents.md and prompts). */
  max_results: z.number().int().min(1).max(5).default(3),
  index: z.strictObject({
    db_file: z.string().regex(/^[A-Za-z0-9._-]+\.sqlite$/).default('precedents.sqlite'),
    mirrors_dir: z.string().regex(/^[A-Za-z0-9._-]+$/).default('mirrors'),
    window_weeks: z.number().int().min(1).max(1040).default(104),
    exclude_projects: z.array(projectKeySchema).default([]),
    include_comments: z.boolean().default(true),
    /** Background loop in `controller start`; false = only `autos index sync`. */
    auto_sync: z.boolean().default(true),
    sync_interval_minutes: z.number().int().min(1).max(1440).default(15),
    reconcile_interval_hours: z.number().int().min(1).max(168).default(24),
    /** Re-read window for incremental sync (JQL dates use the Jira user's time zone). */
    overlap_minutes: z.number().int().min(10).max(2880).default(1440),
    max_requests_per_run: z.number().int().min(10).max(100_000).default(5000),
    min_request_interval_ms: z.number().int().min(0).max(10_000).default(250),
  }).prefault({}),
  embedding: z.strictObject({
    /** none = keyword and error-signature search only (no model). */
    provider: z.enum(['none', 'ollama']).default('none'),
    url: z.string().default('http://127.0.0.1:11434'),
    model: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/).optional(),
    /** Vector size of the model (checked against every response and the stored index). */
    dimensions: z.number().int().min(8).max(8192).optional(),
    batch_size: z.number().int().min(1).max(256).default(32),
    timeout_ms: z.number().int().min(1000).max(600_000).default(60_000),
  }).prefault({}),
  gate: z.strictObject({
    semantic_threshold: z.number().min(0).max(1).optional(),
    strict_threshold: z.number().min(0).max(1).optional(),
  }).prefault({}),
  judge: z.strictObject({
    enabled: z.boolean().default(true),
    /** Tier (or tier:effort) from model_tiers; absent = cheapest tier, else the reviewer's primary provider. */
    tier: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}(?::[a-z]+)?$/).optional(),
    max_candidates: z.number().int().min(1).max(10).default(10),
    timeout_ms: z.number().int().min(10_000).max(1_800_000).default(120_000),
  }).prefault({}),
  prompt: z.strictObject({
    /** Roles that receive the reference block. Empty until the evaluation go/no-go (plan §9). */
    roles: z.array(z.enum(['swe', 'reviewer'])).default([]),
    max_bytes: z.number().int().min(1024).max(65_536).default(20_480),
    per_precedent_diff_bytes: z.number().int().min(0).max(32_768).default(6144),
  }).prefault({}),
  /** "May also affect" check after a READY_FOR_HUMAN attempt (plan §7). */
  possibly_affected: z.boolean().default(true),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.lineages.forEach((lineage, i) => { if (ids.has(lineage.id)) ctx.addIssue({ code: 'custom', path: ['lineages', i, 'id'], message: 'Duplicate lineage' }); ids.add(lineage.id); });
  if (value.embedding.provider === 'ollama' && !value.embedding.model) ctx.addIssue({ code: 'custom', path: ['embedding', 'model'], message: 'An Ollama embedding model is required' });
  if (value.embedding.provider === 'ollama' && !value.embedding.dimensions) ctx.addIssue({ code: 'custom', path: ['embedding', 'dimensions'], message: 'Embedding dimensions are required' });
});
export type PrecedentsConfig = z.infer<typeof precedentsConfigSchema>;

/** Confluence fix-document drafts (plan §12): the only Atlassian write path; drafts only, never published by Autos. */
export const confluenceDraftsConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  space_key: z.string().regex(/^[A-Za-z0-9~][A-Za-z0-9_~-]{0,99}$/),
  parent_page_id: z.string().regex(/^[0-9]+$/),
  /** Create the draft automatically when an attempt reaches READY_FOR_HUMAN; otherwise only `autos confluence draft`. */
  auto: z.boolean().default(false),
});
export type ConfluenceDraftsConfig = z.infer<typeof confluenceDraftsConfigSchema>;

// ---- Fix document data (built by the workflow from trusted artifacts; rendered by the draft writer) ----

export const fixDocumentDataSchema = z.strictObject({
  issue_key: issueKeySchema,
  issue_url: z.url(),
  summary: z.string().max(1000),
  repository: z.string().max(300),
  branch: branchNameSchema,
  commit_sha: gitShaSchema,
  changed_files: z.array(z.string().max(1000)).max(500),
  checks: z.array(z.strictObject({ name: z.string().max(200), status: z.string().max(50) })).max(100),
  qa: z.strictObject({ status: z.string().max(50), summary: z.string().max(4000) }),
  review: z.strictObject({ status: z.string().max(50), summary: z.string().max(4000) }),
  fix_summary: z.string().max(20_000),
  possibly_affected: possiblyAffectedSchema.nullable(),
  precedents_used: z.array(z.strictObject({ issue_key: issueKeySchema, issue_url: z.url(), kind: precedentKindSchema })).max(10),
  limitations: z.array(z.string().max(500)).max(20),
});
export type FixDocumentData = z.infer<typeof fixDocumentDataSchema>;

/** Stored per job in `confluence-draft.json`. */
export const confluenceDraftRecordSchema = z.strictObject({
  schema_version: z.literal(1),
  job_id: z.string(),
  issue_key: issueKeySchema,
  draft: confluenceDraftRefSchema,
  created_at: timestampSchema,
  /** Earlier draft of the same issue that the user had published or edited, so this one was created instead. */
  supersedes_page_id: z.string().regex(/^[0-9]+$/).nullable(),
});
export type ConfluenceDraftRecord = z.infer<typeof confluenceDraftRecordSchema>;

// ---- Ports used by the workflow, controller and CLI ----

export interface SemanticPrecedentLookup {
  result: SemanticPrecedentResult;
  /** precedents.md text (shown, also-reported, rejected with reasons). */
  markdown: string;
}
export interface PossiblyAffectedLookup { affected: PossiblyAffected; markdown: string }

/** Job-time precedent lookups. Every method may throw; callers treat failures as non-fatal. */
export interface SemanticPrecedentPort {
  lookup(request: { job_id: string; issue_key: string; project_key: string; development_branch: string; summary: string; description: string; link_keys: string[] }, signal?: AbortSignal): Promise<SemanticPrecedentLookup>;
  /** Untrusted reference block for one role's prompt ('' when nothing applies). Never includes ALSO_REPORTED items. */
  referenceBlock(result: SemanticPrecedentResult, role: 'swe' | 'reviewer', nonce: string, maxBytes: number): string;
  possiblyAffected(request: { job_id: string; issue_key: string; project_key: string; development_branch: string; commit_sha: string; patch: string; changed_paths: string[]; routing: SemanticPrecedentResult | null }, signal?: AbortSignal): Promise<PossiblyAffectedLookup>;
}

export interface FixDocumentDraftPort {
  /** Creates a draft, or updates `previous` while it is still an untouched draft; otherwise creates a new one. */
  createOrUpdate(data: FixDocumentData, previous: ConfluenceDraftRef | null, signal?: AbortSignal): Promise<{ draft: ConfluenceDraftRef; superseded_page_id: string | null }>;
}

export const precedentIndexStatusSchema = z.strictObject({
  enabled: z.boolean(),
  source: z.enum(['legacy', 'semantic']),
  ready: z.boolean(),
  issues: z.number().int().min(0),
  chunks: z.number().int().min(0),
  vectors: z.number().int().min(0),
  fixes: z.number().int().min(0),
  projects: z.array(z.string()),
  embedding_model: z.string().nullable(),
  last_sync_at: timestampSchema.nullable(),
  last_full_sync_at: timestampSchema.nullable(),
  last_reconcile_at: timestampSchema.nullable(),
  last_mirror_scan_at: timestampSchema.nullable(),
  last_error_code: z.string().nullable(),
  running: z.boolean(),
});
export type PrecedentIndexStatus = z.infer<typeof precedentIndexStatusSchema>;

export const precedentSyncReportSchema = z.strictObject({
  mode: z.enum(['incremental', 'full', 'reconcile', 'rebuild', 'mirrors']),
  started_at: timestampSchema,
  finished_at: timestampSchema,
  issues_upserted: z.number().int().min(0),
  issues_deleted: z.number().int().min(0),
  chunks_embedded: z.number().int().min(0),
  fixes_found: z.number().int().min(0),
  requests: z.number().int().min(0),
  complete: z.boolean(),
  error_code: z.string().nullable(),
});
export type PrecedentSyncReport = z.infer<typeof precedentSyncReportSchema>;

export interface PrecedentSearchQuery { issue_key?: string; text?: string; limit?: number; include_unresolved?: boolean; judge?: boolean; explain?: boolean }

/** Operator/controller operations on the index (CLI `autos index|lineage|precedents`, API /v1/index, /v1/precedents). */
export interface PrecedentIndexPort {
  status(): Promise<PrecedentIndexStatus>;
  sync(options: { full?: boolean; reconcile?: boolean }, signal?: AbortSignal): Promise<PrecedentSyncReport[]>;
  rebuild(signal?: AbortSignal): Promise<PrecedentSyncReport[]>;
  purgeProject(projectKey: string): Promise<{ issues_deleted: number }>;
  lineage(signal?: AbortSignal): Promise<{ nodes: LineageNode[]; unattached: string[]; missing: string[] }>;
  /** Result plus RELATED_FIX entries and per-candidate explain records (JSON-safe). */
  search(query: PrecedentSearchQuery, signal?: AbortSignal): Promise<{ result: SemanticPrecedentResult; related: SemanticPrecedent[]; explain: unknown[] }>;
  show(issueKey: string): Promise<unknown | null>;
  /** One background tick: incremental sync / mirror scan / reconcile when each is due. Never throws. */
  tick(signal?: AbortSignal): Promise<void>;
  close(): void;
}
