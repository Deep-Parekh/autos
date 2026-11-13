import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AutosError, confluenceDraftRecordSchema, issueKeySchema, lineageNodeSchema, PRECEDENT_KINDS, PRECEDENT_SIGNALS, precedentIndexStatusSchema,
  precedentSyncReportSchema, semanticPrecedentResultSchema, semanticPrecedentSchema,
  type AutosConfig, type PrecedentIndexPort, type PrecedentIndexStatus, type PrecedentSyncReport, type WorkflowServicePort,
} from '@autos/contracts';

/**
 * Semantic precedent index operations (docs/semantic-precedents-plan.md §6) and Confluence fix-document drafts (§12):
 * the background index loop of `controller start` and the operator routes under /v1/index, /v1/lineage,
 * /v1/precedents and /v1/confluence-drafts. Logs carry counts, ids, durations and codes only: never ticket text,
 * search text or page content.
 */

export interface IndexLoopOptions {
  /** Delay before the first background tick after the server is ready; default 5 seconds. */
  initialDelayMs?: number;
  /** Interval between background ticks; default one minute (the index decides what is due). */
  intervalMs?: number;
}

export const INDEX_OPERATION_KINDS = ['sync', 'rebuild'] as const;
export interface IndexOperation {
  kind: (typeof INDEX_OPERATION_KINDS)[number];
  full: boolean;
  reconcile: boolean;
  running: boolean;
  started_at: string;
  finished_at: string | null;
  reports: PrecedentSyncReport[];
  error_code: string | null;
}
export interface IndexLoopState {
  /** True while `controller start` runs the background loop (precedents.index.auto_sync). */
  active: boolean;
  last_tick_at: string | null;
  last_tick_error_code: string | null;
  ticks: number;
}

const errorCode = (error: unknown): string => error instanceof AutosError ? error.code : 'INTERNAL';
const sum = (reports: PrecedentSyncReport[], field: 'issues_upserted' | 'issues_deleted' | 'chunks_embedded' | 'fixes_found'): number => reports.reduce((total, report) => total + report[field], 0);

/**
 * Serializes every controller-side index operation (background tick, manual sync, rebuild): at most one runs at a time.
 * Operations run in the background and never block request handling, job execution or the poller.
 */
export class IndexCoordinator {
  private current: { kind: 'tick' | IndexOperation['kind']; abort: AbortController; done: Promise<void> } | undefined;
  private lastOperation: IndexOperation | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  readonly loop: IndexLoopState = { active: false, last_tick_at: null, last_tick_error_code: null, ticks: 0 };

  constructor(private readonly index: PrecedentIndexPort, private readonly log: () => FastifyBaseLogger, private readonly now: () => Date = () => new Date()) {}

  busy(): boolean { return this.current !== undefined; }
  operation(): IndexOperation | null { return this.lastOperation ? { ...this.lastOperation, reports: [...this.lastOperation.reports] } : null; }

  /** One background tick; skipped (not queued) while another index operation runs. Never throws. */
  async tick(): Promise<void> {
    if (this.current || this.stopped) return;
    const abort = new AbortController();
    const started = Date.now();
    const done = (async () => {
      let code: string | null = null;
      try { await this.index.tick(abort.signal); } catch (error) { code = errorCode(error); }
      if (abort.signal.aborted) return;
      this.loop.ticks++; this.loop.last_tick_at = this.now().toISOString(); this.loop.last_tick_error_code = code;
      const duration_ms = Date.now() - started;
      if (code) { this.log().warn({ event: 'index_tick', outcome: 'FAILED', code, duration_ms }); return; }
      try {
        const status = await this.index.status();
        this.log().info({ event: 'index_tick', outcome: 'OK', duration_ms, ready: status.ready, issues: status.issues, vectors: status.vectors, fixes: status.fixes, last_error_code: status.last_error_code });
      } catch (error) { this.log().warn({ event: 'index_tick', outcome: 'OK', duration_ms, status_code: errorCode(error) }); }
    })();
    this.current = { kind: 'tick', abort, done };
    try { await done; } finally { if (this.current?.done === done) this.current = undefined; }
  }

  /** Starts a manual operation in the background; null when another index operation is already running. */
  start(kind: IndexOperation['kind'], options: { full: boolean; reconcile: boolean }): IndexOperation | null {
    if (this.current || this.stopped) return null;
    const abort = new AbortController();
    const started = Date.now();
    const operation: IndexOperation = { kind, full: options.full, reconcile: options.reconcile, running: true, started_at: this.now().toISOString(), finished_at: null, reports: [], error_code: null };
    this.lastOperation = operation;
    const done = (async () => {
      try {
        const reports = kind === 'rebuild' ? await this.index.rebuild(abort.signal) : await this.index.sync({ ...(options.full ? { full: true } : {}), ...(options.reconcile ? { reconcile: true } : {}) }, abort.signal);
        operation.reports = precedentSyncReportSchema.array().parse(reports);
        operation.error_code = operation.reports.find((report) => report.error_code)?.error_code ?? null;
      } catch (error) { operation.error_code = abort.signal.aborted ? 'CANCELLED' : errorCode(error); }
      operation.running = false; operation.finished_at = this.now().toISOString();
      this.log().info({ event: 'index_operation', kind, full: options.full, reconcile: options.reconcile, duration_ms: Date.now() - started, reports: operation.reports.length,
        issues_upserted: sum(operation.reports, 'issues_upserted'), issues_deleted: sum(operation.reports, 'issues_deleted'), chunks_embedded: sum(operation.reports, 'chunks_embedded'), fixes_found: sum(operation.reports, 'fixes_found'), error_code: operation.error_code });
    })().finally(() => { if (this.current?.done === done) this.current = undefined; });
    this.current = { kind, abort, done };
    return { ...operation };
  }

  /** Background loop: one tick shortly after start, then every interval. Timers are unref'd. */
  startLoop(options: IndexLoopOptions = {}): void {
    if (this.stopped || this.loop.active) return;
    this.loop.active = true;
    const interval = options.intervalMs ?? 60_000;
    const first = setTimeout(() => {
      void this.tick();
      const every = setInterval(() => { void this.tick(); }, interval); every.unref(); this.timers.push(every);
    }, options.initialDelayMs ?? 5000);
    first.unref(); this.timers.push(first);
  }

  /** Stops the loop and cancels the running operation, waiting for it to settle. */
  async stop(): Promise<void> {
    this.stopped = true; this.loop.active = false;
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
    const current = this.current;
    if (current) { current.abort.abort(); await current.done.catch(() => undefined); }
  }
}

// ---- Request validation (Zod at the trust boundary) ----

export const indexSyncRequestSchema = z.strictObject({ full: z.boolean().optional(), reconcile: z.boolean().optional() });
export const indexPurgeRequestSchema = z.strictObject({ project_key: z.string().regex(/^[A-Z][A-Z0-9]*$/) });
export const precedentSearchRequestSchema = z.strictObject({
  issue_key: issueKeySchema.optional(),
  text: z.string().trim().min(3).max(4000).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  include_unresolved: z.boolean().optional(),
  judge: z.boolean().optional(),
  explain: z.boolean().optional(),
}).refine((body) => (body.issue_key === undefined) !== (body.text === undefined), 'Exactly one of issue_key or text is required');
export const confluenceDraftRequestSchema = z.strictObject({ job_id: z.uuid().optional(), issue_key: issueKeySchema.optional() })
  .refine((body) => (body.job_id === undefined) !== (body.issue_key === undefined), 'Exactly one of job_id or issue_key is required');

// ---- Response projections (validated before they leave the controller) ----

export const lineageResponseSchema = z.strictObject({ nodes: z.array(lineageNodeSchema), unattached: z.array(z.string()), missing: z.array(z.string()) });
export const precedentSearchResponseSchema = z.strictObject({ result: semanticPrecedentResultSchema, related: z.array(semanticPrecedentSchema), explain: z.array(z.unknown()) });

// ---- OpenAPI (JSON Schema) ----

const nullableTime = { type: ['string', 'null'], format: 'date-time' } as const;
const projectKey = { type: 'string', pattern: '^[A-Z][A-Z0-9]*$' } as const;
const issueKey = { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' } as const;
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' } as const;
const indexStatusJson = {
  type: 'object', additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' }, source: { type: 'string', enum: ['legacy', 'semantic'] }, ready: { type: 'boolean' },
    issues: { type: 'integer', minimum: 0 }, chunks: { type: 'integer', minimum: 0 }, vectors: { type: 'integer', minimum: 0 }, fixes: { type: 'integer', minimum: 0 },
    projects: { type: 'array', items: { type: 'string' } }, embedding_model: { type: ['string', 'null'] },
    last_sync_at: nullableTime, last_full_sync_at: nullableTime, last_reconcile_at: nullableTime, last_mirror_scan_at: nullableTime,
    last_error_code: { type: ['string', 'null'] }, running: { type: 'boolean' },
  },
  required: ['enabled', 'source', 'ready', 'issues', 'chunks', 'vectors', 'fixes', 'projects', 'embedding_model', 'last_sync_at', 'last_full_sync_at', 'last_reconcile_at', 'last_mirror_scan_at', 'last_error_code', 'running'],
} as const;
const syncReportJson = {
  type: 'object', additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['incremental', 'full', 'reconcile', 'rebuild', 'mirrors'] }, started_at: { type: 'string', format: 'date-time' }, finished_at: { type: 'string', format: 'date-time' },
    issues_upserted: { type: 'integer', minimum: 0 }, issues_deleted: { type: 'integer', minimum: 0 }, chunks_embedded: { type: 'integer', minimum: 0 }, fixes_found: { type: 'integer', minimum: 0 },
    requests: { type: 'integer', minimum: 0 }, complete: { type: 'boolean' }, error_code: { type: ['string', 'null'] },
  },
  required: ['mode', 'started_at', 'finished_at', 'issues_upserted', 'issues_deleted', 'chunks_embedded', 'fixes_found', 'requests', 'complete', 'error_code'],
} as const;
const operationJson = {
  type: 'object', additionalProperties: false,
  description: 'The running or most recent manual index operation (sync or rebuild) of this controller process.',
  properties: {
    kind: { type: 'string', enum: [...INDEX_OPERATION_KINDS] }, full: { type: 'boolean' }, reconcile: { type: 'boolean' }, running: { type: 'boolean' },
    started_at: { type: 'string', format: 'date-time' }, finished_at: nullableTime, reports: { type: 'array', items: syncReportJson }, error_code: { type: ['string', 'null'] },
  },
  required: ['kind', 'full', 'reconcile', 'running', 'started_at', 'finished_at', 'reports', 'error_code'],
} as const;
const operationExample = { kind: 'sync', full: false, reconcile: false, running: true, started_at: '2026-11-12T12:00:00.000Z', finished_at: null, reports: [], error_code: null };
const indexStatusResponseJson = {
  type: 'object', additionalProperties: false,
  properties: {
    index: indexStatusJson,
    auto_sync: { type: 'boolean', description: 'precedents.index.auto_sync: whether `controller start` runs the background index loop.' },
    loop: { type: 'object', additionalProperties: false, properties: { active: { type: 'boolean' }, last_tick_at: nullableTime, last_tick_error_code: { type: ['string', 'null'] }, ticks: { type: 'integer', minimum: 0 } }, required: ['active', 'last_tick_at', 'last_tick_error_code', 'ticks'] },
    operation: { ...operationJson, type: ['object', 'null'] },
  },
  required: ['index', 'auto_sync', 'loop', 'operation'],
  examples: [{ index: { enabled: true, source: 'semantic', ready: true, issues: 1200, chunks: 3400, vectors: 3400, fixes: 310, projects: ['SAMPLE'], embedding_model: 'example-embed:0.6b', last_sync_at: '2026-11-12T11:45:00.000Z', last_full_sync_at: '2026-11-10T02:00:00.000Z', last_reconcile_at: '2026-11-12T02:00:00.000Z', last_mirror_scan_at: '2026-11-12T11:45:00.000Z', last_error_code: null, running: false }, auto_sync: true, loop: { active: true, last_tick_at: '2026-11-12T11:59:00.000Z', last_tick_error_code: null, ticks: 42 }, operation: null }],
} as const;
const operationResponseJson = { ...operationJson, examples: [operationExample] } as const;
const lineageNodeJson = {
  type: 'object', additionalProperties: false,
  properties: {
    lineage_id: { type: 'string' }, project_key: projectKey, branch: { type: 'string' }, fork_point: sha, fork_date: { type: 'string', format: 'date-time' },
    side_branches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { branch: { type: 'string' }, kind: { type: 'string', enum: ['dev', 'sbx'] }, method: { type: 'string', enum: ['name', 'ancestry', 'override'] } }, required: ['branch', 'kind', 'method'] } },
  },
  required: ['lineage_id', 'project_key', 'branch', 'fork_point', 'fork_date', 'side_branches'],
} as const;
const lineageResponseJson = {
  type: 'object', additionalProperties: false,
  properties: {
    nodes: { type: 'array', items: lineageNodeJson },
    unattached: { type: 'array', items: { type: 'string' }, description: 'Branches that could not be attached to a lineage node.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Configured projects or branches that were not found.' },
  },
  required: ['nodes', 'unattached', 'missing'], examples: [{ nodes: [], unattached: [], missing: [] }],
} as const;
const precedentJson = {
  type: 'object', additionalProperties: false,
  properties: {
    issue_key: issueKey, issue_url: { type: 'string', format: 'uri' }, project_key: projectKey, summary: { type: 'string', maxLength: 300 }, status: { type: 'string', maxLength: 100 },
    resolution: { type: ['string', 'null'], maxLength: 100 }, kind: { type: 'string', enum: [...PRECEDENT_KINDS] }, score: { type: 'number', minimum: 0, maximum: 1 },
    signals: { type: 'array', minItems: 1, items: { type: 'string', enum: [...PRECEDENT_SIGNALS] } },
    judge: { type: ['object', 'null'], additionalProperties: false, properties: { verdict: { type: 'string', enum: ['yes', 'likely'] }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['verdict', 'confidence'] },
    fix: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        lineage_id: { type: 'string' }, branch: { type: 'string' }, commit_shas: { type: 'array', minItems: 1, maxItems: 5, items: sha }, patch_id: { type: ['string', 'null'], pattern: '^[a-f0-9]{40}$' },
        evidence_url: { type: 'string', format: 'uri' }, files: { type: 'array', maxItems: 50, items: { type: 'string' } }, diff_excerpt: { type: ['string', 'null'] },
        applies_cleanly: { type: ['boolean', 'null'] }, inherited: { type: ['boolean', 'null'] }, ported_to: { type: 'array', items: { type: 'string' } },
      },
      required: ['lineage_id', 'branch', 'commit_shas', 'patch_id', 'evidence_url', 'files', 'diff_excerpt', 'applies_cleanly', 'inherited', 'ported_to'],
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
  required: ['issue_key', 'issue_url', 'project_key', 'summary', 'status', 'resolution', 'kind', 'score', 'signals', 'judge', 'fix', 'caveats'],
} as const;
const searchResponseJson = {
  type: 'object', additionalProperties: false,
  properties: {
    result: {
      type: 'object', additionalProperties: false,
      properties: {
        schema_version: { type: 'integer', const: 1 }, outcome: { type: 'string', enum: ['FOUND', 'NO_MATCH', 'DISABLED', 'INDEX_NOT_READY'] }, judge: { type: 'string', enum: ['RAN', 'NOT_RUN', 'SKIPPED'] },
        items: { type: 'array', maxItems: 5, items: precedentJson }, also_reported: { type: 'array', maxItems: 10, items: precedentJson },
        rejected: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, properties: { issue_key: issueKey, reason: { type: 'string', maxLength: 300 } }, required: ['issue_key', 'reason'] } },
        checked: { type: 'integer', minimum: 0 },
        index: { type: ['object', 'null'], additionalProperties: false, properties: { as_of: { type: 'string', format: 'date-time' }, issues: { type: 'integer', minimum: 0 }, model: { type: 'string' } }, required: ['as_of', 'issues', 'model'] },
      },
      required: ['schema_version', 'outcome', 'judge', 'items', 'also_reported', 'rejected', 'checked', 'index'],
    },
    related: { type: 'array', items: precedentJson, description: 'RELATED_FIX entries (operator search only; never given to agents).' },
    explain: { type: 'array', items: {}, description: 'Per-candidate explain records when `explain` was requested; empty otherwise.' },
  },
  required: ['result', 'related', 'explain'],
  examples: [{ result: { schema_version: 1, outcome: 'NO_MATCH', judge: 'SKIPPED', items: [], also_reported: [], rejected: [], checked: 4, index: { as_of: '2026-11-12T11:45:00.000Z', issues: 1200, model: 'example-embed:0.6b' } }, related: [], explain: [] }],
} as const;
const draftRecordJson = {
  type: 'object', additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', const: 1 }, job_id: { type: 'string' }, issue_key: issueKey,
    draft: { type: 'object', additionalProperties: false, properties: { page_id: { type: 'string', pattern: '^[0-9]+$' }, space_id: { type: 'string', pattern: '^[0-9]+$' }, version: { type: 'integer', minimum: 1 }, status: { type: 'string', const: 'draft' }, edit_url: { type: 'string', format: 'uri' } }, required: ['page_id', 'space_id', 'version', 'status', 'edit_url'] },
    created_at: { type: 'string', format: 'date-time' }, supersedes_page_id: { type: ['string', 'null'], pattern: '^[0-9]+$' },
  },
  required: ['schema_version', 'job_id', 'issue_key', 'draft', 'created_at', 'supersedes_page_id'],
  examples: [{ schema_version: 1, job_id: '00000000-0000-4000-8000-000000000001', issue_key: 'SAMPLE-123', draft: { page_id: '123456', space_id: '98765', version: 1, status: 'draft', edit_url: 'https://example.atlassian.net/wiki/pages/resumedraft.action?draftId=123456' }, created_at: '2026-11-12T12:00:00.000Z', supersedes_page_id: null }],
} as const;

export interface PrecedentRouteContext {
  config: AutosConfig;
  index: PrecedentIndexPort | undefined;
  coordinator: IndexCoordinator | undefined;
  workflow: WorkflowServicePort;
  errorSchema: Record<string, unknown>;
  actorHeaders: Record<string, unknown>;
  audit(request: FastifyRequest, action: string, fields: Record<string, unknown>): void;
}

const NOT_CONFIGURED = 'Precedent index is not configured (precedents section and controller index service)';
const DISABLED = 'Precedent search is disabled (precedents.enabled is false)';
export const INDEX_BUSY = 'An index operation is already running';
const DRAFTS_NOT_CONFIGURED = 'Confluence drafts are not configured (confluence.drafts.enabled)';

export function registerPrecedentRoutes(app: FastifyInstance, ctx: PrecedentRouteContext): void {
  const { config, errorSchema, actorHeaders } = ctx;
  const security = [{ bearerAuth: [] }];
  const fail = (request: FastifyRequest, reply: { code(status: number): { send(body: unknown): unknown } }, status: number, code: string, message: string) => {
    request.log.warn({ event: 'request_error', request_id: request.id, route: request.routeOptions?.url ?? 'unmatched', status, code });
    return reply.code(status).send({ code, message, request_id: request.id });
  };
  /** The index port when the feature is configured; otherwise replies 404 and returns undefined. */
  const indexOr404 = (request: FastifyRequest, reply: Parameters<typeof fail>[1]): PrecedentIndexPort | undefined => {
    if (!ctx.index || !config.precedents) { fail(request, reply, 404, 'NOT_FOUND', NOT_CONFIGURED); return undefined; }
    return ctx.index;
  };
  const notConfiguredNote = ' 404 (`NOT_FOUND`) when the precedent index is not configured.';
  const tags = ['operator'];
  const statusOf = async (index: PrecedentIndexPort): Promise<PrecedentIndexStatus> => precedentIndexStatusSchema.parse(await index.status());

  app.get('/v1/index/status', { schema: { tags, summary: 'Get precedent index status', description: `Index counts and sync times, the background loop of \`controller start\` (precedents.index.auto_sync) and the running or most recent manual operation.${notConfiguredNote}`, operationId: 'getIndexStatus', security, response: { 200: indexStatusResponseJson, 404: errorSchema } } }, async (request, reply) => {
    const index = indexOr404(request, reply); if (!index) return reply;
    return { index: await statusOf(index), auto_sync: config.precedents!.index.auto_sync, loop: ctx.coordinator ? { ...ctx.coordinator.loop } : { active: false, last_tick_at: null, last_tick_error_code: null, ticks: 0 }, operation: ctx.coordinator?.operation() ?? null };
  });
  const startOperation = (request: FastifyRequest, reply: Parameters<typeof fail>[1], kind: 'sync' | 'rebuild', options: { full: boolean; reconcile: boolean }) => {
    const index = indexOr404(request, reply); if (!index) return reply;
    if (!config.precedents!.enabled) return fail(request, reply, 409, 'CONFLICT', DISABLED);
    const operation = ctx.coordinator?.start(kind, options);
    if (!operation) return fail(request, reply, 409, 'CONFLICT', INDEX_BUSY);
    ctx.audit(request, kind === 'rebuild' ? 'index_rebuild' : 'index_sync', { full: options.full, reconcile: options.reconcile });
    return reply.code(202).send(operation);
  };
  const operationNote = 'Runs in the background (one index operation at a time, shared with the background loop); follow it with GET /v1/index/status. 409 when another index operation is running or precedents.enabled is false.';
  app.post('/v1/index/sync', { schema: { tags, summary: 'Start a precedent index sync', description: `Incremental Jira sync (\`full\`: re-read the whole window; \`reconcile\`: also purge issues that were deleted, moved or became restricted), mirror scan and lineage recompute. Read-only towards Jira and Bitbucket. ${operationNote}${notConfiguredNote}`, operationId: 'syncIndex', security, headers: actorHeaders, body: { type: 'object', additionalProperties: false, properties: { full: { type: 'boolean', default: false }, reconcile: { type: 'boolean', default: false } }, examples: [{ full: false, reconcile: true }] }, response: { 202: operationResponseJson, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const body = indexSyncRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return fail(request, reply, 400, 'INVALID_INPUT', 'Invalid index sync request');
    return startOperation(request, reply, 'sync', { full: body.data.full ?? false, reconcile: body.data.reconcile ?? false });
  });
  app.post('/v1/index/rebuild', { schema: { tags, summary: 'Rebuild the precedent index from scratch', description: `Discards the local index (ticket text, embeddings, fix links) and rebuilds it; search returns INDEX_NOT_READY until it finishes. Mirrors are kept. ${operationNote}${notConfiguredNote}`, operationId: 'rebuildIndex', security, headers: actorHeaders, response: { 202: operationResponseJson, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => startOperation(request, reply, 'rebuild', { full: true, reconcile: false }));
  app.post('/v1/index/purge', { schema: { tags, summary: 'Purge one Jira project from the precedent index', description: `Immediately deletes every indexed issue of the project (text, comments, embeddings). Add the project to precedents.index.exclude_projects to keep it out of later syncs.${notConfiguredNote}`, operationId: 'purgeIndexProject', security, headers: actorHeaders, body: { type: 'object', additionalProperties: false, properties: { project_key: projectKey }, required: ['project_key'], examples: [{ project_key: 'SAMPLE' }] }, response: { 200: { type: 'object', additionalProperties: false, properties: { project_key: projectKey, issues_deleted: { type: 'integer', minimum: 0 } }, required: ['project_key', 'issues_deleted'], examples: [{ project_key: 'SAMPLE', issues_deleted: 12 }] }, 400: errorSchema, 404: errorSchema } } }, async (request, reply) => {
    const body = indexPurgeRequestSchema.safeParse(request.body);
    if (!body.success) return fail(request, reply, 400, 'INVALID_INPUT', 'Invalid purge request');
    const index = indexOr404(request, reply); if (!index) return reply;
    const result = await index.purgeProject(body.data.project_key);
    const issues_deleted = z.number().int().min(0).parse(result.issues_deleted);
    ctx.audit(request, 'index_purge', { project_key: body.data.project_key, issues_deleted });
    return { project_key: body.data.project_key, issues_deleted };
  });
  app.get('/v1/lineage', { schema: { tags, summary: 'Show the code lineages', description: `Lineage nodes (Jira project, development branch, fork point from the root branch, attached dev/sbx branches), plus branches that could not be attached and configured items that were not found.${notConfiguredNote}`, operationId: 'getLineage', security, response: { 200: lineageResponseJson, 404: errorSchema } } }, async (request, reply) => {
    const index = indexOr404(request, reply); if (!index) return reply;
    return lineageResponseSchema.parse(await index.lineage(AbortSignal.timeout(120_000)));
  });
  app.post('/v1/precedents/search', { schema: { tags, summary: 'Search precedents for an issue or free text', description: `Runs the retrieval pipeline (candidates, evidence gate, optional judge) for an indexed issue (\`issue_key\`) or free text (\`text\`; exactly one). \`judge: false\` skips the provider judge; \`explain\` adds per-candidate records. The request text is never logged. 409 when precedents.enabled is false.${notConfiguredNote}`, operationId: 'searchPrecedents', security, body: { type: 'object', additionalProperties: false, properties: { issue_key: issueKey, text: { type: 'string', minLength: 3, maxLength: 4000 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, include_unresolved: { type: 'boolean', default: false }, judge: { type: 'boolean', default: true }, explain: { type: 'boolean', default: false } }, examples: [{ issue_key: 'SAMPLE-123', limit: 5, judge: false }] }, response: { 200: searchResponseJson, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const body = precedentSearchRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return fail(request, reply, 400, 'INVALID_INPUT', 'Invalid search request: exactly one of issue_key or text is required');
    const index = indexOr404(request, reply); if (!index) return reply;
    if (!config.precedents!.enabled) return fail(request, reply, 409, 'CONFLICT', DISABLED);
    const query = Object.fromEntries(Object.entries(body.data).filter(([, value]) => value !== undefined));
    return precedentSearchResponseSchema.parse(await index.search(query, AbortSignal.timeout((config.precedents!.judge.timeout_ms ?? 120_000) + 60_000)));
  });
  app.get('/v1/precedents/:issueKey', { schema: { tags, summary: 'Show one indexed issue', description: `Indexed text summary, error signatures, code references, fixes and fix presence per lineage node for one issue. 404 when the issue is not in the index.${notConfiguredNote}`, operationId: 'getPrecedent', security, params: { type: 'object', properties: { issueKey }, required: ['issueKey'] }, response: { 200: { type: 'object', additionalProperties: true, description: 'Index record (shape owned by the index; operator display only).' }, 404: errorSchema } } }, async (request, reply) => {
    const { issueKey: key } = request.params as { issueKey: string };
    const index = indexOr404(request, reply); if (!index) return reply;
    const shown = await index.show(key);
    if (shown === null || typeof shown !== 'object' || Array.isArray(shown)) return fail(request, reply, 404, 'NOT_FOUND', 'Issue is not in the precedent index');
    return shown;
  });
  app.post('/v1/confluence-drafts', { schema: { tags, summary: 'Create a Confluence fix-document draft', description: 'Creates (or refreshes while it is still an untouched draft) the Confluence fix-document draft of a READY_FOR_HUMAN attempt: `job_id`, or `issue_key` for the issue\'s latest READY_FOR_HUMAN attempt. The draft is unpublished and visible only to the Atlassian account whose token the controller uses; a person must review and publish it in Confluence. Autos never publishes, updates a published page or deletes anything. 404 (`NOT_FOUND`) when drafts are not configured (confluence.drafts.enabled) or the job/issue is unknown; 409 when the attempt is not READY_FOR_HUMAN.', operationId: 'createConfluenceDraft', security, headers: actorHeaders, body: { type: 'object', additionalProperties: false, properties: { job_id: { type: 'string', format: 'uuid' }, issue_key: issueKey }, examples: [{ issue_key: 'SAMPLE-123' }] }, response: { 201: draftRecordJson, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const body = confluenceDraftRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return fail(request, reply, 400, 'INVALID_INPUT', 'Invalid draft request: exactly one of job_id or issue_key is required');
    const create = ctx.workflow.createFixDocumentDraft;
    if (!create || !config.confluence.drafts?.enabled) return fail(request, reply, 404, 'NOT_FOUND', DRAFTS_NOT_CONFIGURED);
    const target = body.data.job_id ?? body.data.issue_key!;
    const record = confluenceDraftRecordSchema.parse(await create.call(ctx.workflow, target, AbortSignal.timeout(120_000)));
    ctx.audit(request, 'confluence_draft', { job_id: record.job_id, issue_key: record.issue_key, page_id: record.draft.page_id, ...(record.supersedes_page_id ? { supersedes_page_id: record.supersedes_page_id } : {}) });
    return reply.code(201).send(record);
  });
}
