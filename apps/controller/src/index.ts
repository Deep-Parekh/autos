import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ActiveJob, AutosConfig, ArtifactManifest, RepositoryConfig, ArtifactStorePort, JobEvent, JobRecord, ProjectMapping, Provider, RunnerHealth, TicketNotesSummary, WorkflowActivity } from '@autos/contracts';
import { artifactManifestSchema, AutosError, closeIssueRequestSchema, ERROR_CODES, ISSUE_RESOLUTIONS, issueKeySchema, JOB_EVENT_TYPES, JOB_STATES, MAX_TICKET_NOTES, PROVIDERS, TICKET_WORK_STATUSES, pruneWorkspacesRequestSchema, ROLES, operatorNoteRequestSchema, operatorNoteSchema, projectMappingSchema, WORKFLOW_STAGES, WORKSPACE_DIR_NAME_PATTERN, WORKSPACE_REMOVAL_REASONS, WORKSPACE_RETENTION_REASONS } from '@autos/contracts';
import type { WorkflowServicePort } from '@autos/contracts';

export interface ProviderDiagnostic {
  provider: Provider;
  binary_present: boolean;
  authenticated: boolean | null;
  read_only_smoke: 'PASS' | 'FAIL' | 'NOT_RUN';
  message: string;
}

export type RoleName = 'swe' | 'qa' | 'reviewer';
export interface RoleChainEntry { provider: Provider; model: string | null; chain_index: number }
/** The configured provider chain per role (primary first). Cursor is always the automatic model. */
export function roleChains(config: AutosConfig): Array<{ role: RoleName; chain: RoleChainEntry[] }> {
  return (['swe', 'qa', 'reviewer'] as const).map((role) => {
    const agent = config.agents[role];
    const entries = [{ provider: agent.provider, model: agent.model }, ...agent.fallbacks.map((choice) => ({ provider: choice.provider, model: choice.model }))];
    return { role, chain: entries.map((entry, chain_index) => ({ provider: entry.provider, model: entry.provider === 'cursor' ? 'auto' : entry.model ?? null, chain_index })) };
  });
}
export interface ProviderListing extends ProviderDiagnostic { model?: string; roles: Array<{ role: RoleName; chain_index: number }> }
/** Decorates diagnostics with where each provider is used (every role chain position) and Cursor's fixed model. */
export function listProviders(config: AutosConfig, diagnostics: ProviderDiagnostic[]): ProviderListing[] {
  const chains = roleChains(config);
  return diagnostics.map((item) => ({
    ...item,
    ...(item.provider === 'cursor' ? { model: 'auto' } : {}),
    roles: chains.flatMap(({ role, chain }) => chain.filter((entry) => entry.provider === item.provider).map((entry) => ({ role, chain_index: entry.chain_index }))),
  }));
}

export type RunnerHealthResult =
  | RunnerHealth
  | { status: 'unknown' }
  | { status: 'unreachable' };

/** Snapshot of the `controller start` polling loop; absent when the controller runs without a loop. */
export interface LoopStatus {
  running: boolean;
  /** Next scheduled discovery (null while discovering, or when auto_poll is off). */
  next_poll_at: string | null;
  consecutive_failures: number;
  /** jira.auto_poll: when false the loop never reads the Jira filter. */
  auto_poll: boolean;
  /** Completion time of the last successful discovery; null when none has run. */
  last_discovery_at: string | null;
}

/**
 * Read-only diagnostics used only by `autos doctor --deep` (operator-initiated). Implementations must issue GET /
 * ls-remote style reads only and never return secrets or raw upstream bodies.
 */
export interface DeepDiagnostics {
  /** Read the configured Jira saved filter once and count the issues it currently matches. */
  jiraFilter(signal?: AbortSignal): Promise<{ matching_issues: number }>;
  /** Resolve the development branch head of one repository for one mapped project (no workspace is created). */
  resolveBase(repository: RepositoryConfig, mapping: ProjectMapping, signal?: AbortSignal): Promise<{ base_sha: string; development_branch: string }>;
  /**
   * Best-effort read-only existence check of one Jira issue (GET only), used by `POST /v1/issues/{issueKey}/notes` to
   * tell the operator whether a key exists. Resolves false for an unknown issue; may reject on any other failure.
   */
  jiraIssueExists?(issueKey: string, signal?: AbortSignal): Promise<boolean>;
}

/** Outcome of a bulk retry of blocked jobs (see {@link retryBlockedJobs}). */
export interface RetryBlockedResult {
  matched: number;
  retried: number;
  skipped_newer_attempt: number;
  failed: number;
  jobs: Array<{ issue_key: string; job_id: string; new_job_id: string }>;
}

const RETRY_SCAN_LIMIT = 2000;
/** Upper bounds for GET /v1/issues/{issueKey}: history pages scanned and attempts returned. */
const ISSUE_SCAN_LIMIT = 2000;
const ISSUE_JOBS_LIMIT = 50;
/**
 * Retry every BLOCKED job (optionally only one blocked_code) through workflow.retry. A job is skipped when its issue
 * already has a newer attempt (including a newer blocked one: only the newest blocked attempt per issue is retried).
 * Queues only; the controller's drain executes the new attempts.
 */
export async function retryBlockedJobs(workflow: Pick<WorkflowServicePort, 'list' | 'retry'>, filter: { code?: string } = {}): Promise<RetryBlockedResult> {
  const all: JobRecord[] = [];
  for (let offset = 0; offset < RETRY_SCAN_LIMIT; offset += 100) {
    const page = await workflow.list(100, offset);
    all.push(...page);
    if (page.length < 100) break;
  }
  const newest = new Map<string, string>();
  for (const job of all) { const seen = newest.get(job.issue_key); if (seen === undefined || job.created_at > seen) newest.set(job.issue_key, job.created_at); }
  const result: RetryBlockedResult = { matched: 0, retried: 0, skipped_newer_attempt: 0, failed: 0, jobs: [] };
  for (const job of all) {
    if (job.state !== 'BLOCKED' || (filter.code !== undefined && job.blocked_code !== filter.code)) continue;
    result.matched++;
    if ((newest.get(job.issue_key) ?? job.created_at) > job.created_at) { result.skipped_newer_attempt++; continue; }
    try {
      const next = await workflow.retry(job.job_id);
      result.retried++;
      result.jobs.push({ issue_key: job.issue_key, job_id: job.job_id, new_job_id: next.job_id });
    } catch { result.failed++; }
  }
  return result;
}

export interface ControllerServices {
  workflow: WorkflowServicePort;
  runnerHealth?(): Promise<RunnerHealthResult>;
  /** Read-only checks for `autos doctor --deep`; optional so fakes and older runtimes keep working. */
  diagnostics?: DeepDiagnostics;
  artifacts: ArtifactStorePort;
  config: AutosConfig;
  providers(): Promise<ProviderDiagnostic[]>;
  projects(): Promise<ProjectMapping[]>;
  testProviders(): Promise<ProviderDiagnostic[]>;
  close(): Promise<void>;
}

export interface ControllerOptions extends ControllerServices {
  operatorToken: string;
  /** Container-only override. Host mode must bind to configured loopback. */
  bindHost?: string;
  onBackgroundFailure?(event: { job_id: string; code: string }): void;
  /** Poll-loop status supplied by `controller start`; null-safe when omitted. */
  loopStatus?(): LoopStatus;
  /** SSE heartbeat interval; defaults to 15 seconds. */
  sseHeartbeatMs?: number;
  /**
   * Destination for structured request/audit log lines (one JSON object per line, pino format). When omitted, logging
   * is off (tests, OpenAPI generation). Lines never contain headers, bodies, tokens, query strings or note text.
   */
  logStream?: { write(line: string): void };
  /** Timeout for the runner health probe in `/v1/status`; defaults to 2 seconds. */
  runnerHealthTimeoutMs?: number;
}

const errorSchema = {
  type: 'object', additionalProperties: false,
  properties: { code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string', format: 'uuid' } }, required: ['code', 'message', 'request_id'],
  examples: [{ code: 'NOT_FOUND', message: 'Resource not found', request_id: '00000000-0000-4000-8000-000000000002' }],
} as const;

const projectSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    project_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*$' }, workspace: { type: 'string' }, repository_slug: { type: 'string' },
    development_branch: { type: 'string' }, sandbox_branch: { type: ['string', 'null'] }, enabled: { type: 'boolean' },
    source: { type: 'object', additionalProperties: false, properties: { page_id: { type: 'string' }, version: { type: 'integer' }, fetched_at: { type: 'string', format: 'date-time' } }, required: ['page_id', 'version', 'fetched_at'] },
  }, required: ['project_key', 'workspace', 'repository_slug', 'development_branch', 'sandbox_branch', 'enabled', 'source'],
} as const;
const jobSchema = {
  type: 'object', additionalProperties: false,
  examples: [{ job_id: '00000000-0000-4000-8000-000000000001', issue_key: 'SAMPLE-123', repository_id: null, base_sha: null, state: 'PLANNED', dry_run: true, repair_round: 0, created_at: '2026-11-07T12:00:00.000Z', updated_at: '2026-11-07T12:00:00.000Z' }],
  properties: {
    job_id: { type: 'string', format: 'uuid' }, issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' },
    repository_id: { type: ['string', 'null'] }, base_sha: { type: ['string', 'null'] }, base_branch: { type: 'string' },
    state: { type: 'string', enum: [...JOB_STATES] },
    dry_run: { type: 'boolean' }, repair_round: { type: 'integer', minimum: 0, maximum: 2 },
    created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
    blocked_code: { type: 'string', enum: [...ERROR_CODES] }, blocked_reason: { type: 'string' }, feature_branch: { type: 'string' }, commit_sha: { type: 'string' },
    push_status: { type: 'string', enum: ['DISABLED', 'NOT_ATTEMPTED', 'PUSHED', 'FAILED'] },
    parent_job_id: { type: 'string', format: 'uuid', description: 'Set on revision jobs: the READY_FOR_HUMAN job whose commit this attempt continues.' },
    revision: { type: 'integer', minimum: 0, maximum: 20, description: '0 for an initial attempt, n for the n-th requested revision of the same issue.' },
    closed_as: { type: 'string', enum: [...ISSUE_RESOLUTIONS], description: 'Set on every attempt of an issue the operator closed (MERGED or ABANDONED).' },
    resume_at: { type: 'string', format: 'date-time', description: 'PAUSED only: when the attempt is due to resume (provider-reported limit reset or backoff).' },
    pause_code: { type: 'string', enum: [...ERROR_CODES], description: 'PAUSED only: RATE_LIMIT for a limited provider chain, or the infrastructure code when a resuming attempt failed before any agent ran.' },
    paused_role: { type: 'string', enum: [...ROLES], description: 'PAUSED only: the role whose whole provider chain was limited; it restarts at its primary provider.' },
    paused_since: { type: 'string', format: 'date-time', description: 'PAUSED only: start of the pause streak; the attempt blocks after jobs.rate_limit_pause.max_total_hours.' },
    pause_count: { type: 'integer', minimum: 1, maximum: 1000, description: 'PAUSED only: pauses in the current streak.' },
  }, required: ['job_id', 'issue_key', 'repository_id', 'base_sha', 'state', 'dry_run', 'repair_round', 'created_at', 'updated_at'],
} as const;
/** Operator note request body (instructions are never echoed back or logged). */
const noteRequestSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    instructions: { type: 'string', minLength: 1, maxLength: 4000, description: 'Operator guidance for the selected roles. Cannot relax path policy or other platform rules.' },
    roles: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['swe', 'qa', 'reviewer'] }, description: 'Roles that receive the note; defaults to ["swe"].' },
  }, required: ['instructions'], examples: [{ instructions: 'Also handle the empty-list case.', roles: ['swe', 'qa'] }],
} as const;
const actorPattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const actorHeaders = { type: 'object', properties: { 'x-autos-operator': { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$', description: 'Optional audit label (not authentication). Defaults to operator.' } } } as const;
const nullableString = { type: ['string', 'null'], format: 'date-time' } as const;
const roleEnum = ROLES;
const providerEnum = PROVIDERS;
const jobStateEnum = [...JOB_STATES];
const eventSchema = {
  type: 'object', additionalProperties: false,
  examples: [{ event_id: 12, at: '2026-11-07T12:01:03.000Z', type: 'role_started', job_id: '00000000-0000-4000-8000-000000000001', issue_key: 'SAMPLE-123', stage: 'implementation', role: 'swe', provider: 'claude', repair_round: 0 }],
  properties: {
    event_id: { type: 'integer', minimum: 1 }, at: { type: 'string', format: 'date-time' }, type: { type: 'string', enum: [...JOB_EVENT_TYPES] },
    job_id: { type: ['string', 'null'], format: 'uuid' }, issue_key: { type: ['string', 'null'] },
    state: { type: 'string', enum: jobStateEnum }, stage: { type: 'string', enum: [...WORKFLOW_STAGES] },
    role: { type: 'string', enum: [...roleEnum] }, provider: { type: 'string', enum: [...providerEnum] }, from_provider: { type: 'string', enum: [...providerEnum], description: 'provider_fallback only: the provider that failed (provider is the one now used).' },
    repair_round: { type: 'integer', minimum: 0, maximum: 2 }, outcome: { type: 'string' }, code: { type: 'string', enum: [...ERROR_CODES] },
    elapsed_ms: { type: 'integer', minimum: 0 }, count: { type: 'integer', minimum: 0 }, message: { type: 'string', maxLength: 300 },
    resume_at: { type: 'string', format: 'date-time', description: 'job_paused: when the attempt is due to resume; provider_gate_opened: when the new-ticket gate lifts at the latest.' },
  }, required: ['event_id', 'at', 'type', 'job_id', 'issue_key'],
} as const;
const issueKeyParams = { type: 'object', properties: { issueKey: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' } }, required: ['issueKey'] } as const;
const workspaceEntrySchemaJson = {
  type: 'object', additionalProperties: false,
  description: 'One workspace directory (basename only, never a path) with its retention decision.',
  properties: {
    name: { type: 'string', pattern: WORKSPACE_DIR_NAME_PATTERN.source }, job_id: { type: 'string', format: 'uuid' },
    issue_key: { type: ['string', 'null'], description: 'Null for an orphan directory with no matching job.' },
    state: { type: ['string', 'null'], enum: [...jobStateEnum, null] },
    closed_as: { type: ['string', 'null'], enum: [...ISSUE_RESOLUTIONS, null] },
    modified_at: { type: 'string', format: 'date-time' },
    size_bytes: { type: ['integer', 'null'], minimum: 0, description: 'Only when sizes were requested, else null.' },
    removable: { type: ['string', 'null'], enum: [...WORKSPACE_REMOVAL_REASONS, null], description: 'Why the workspace is removable now; null when retained.' },
    retained_because: { type: ['string', 'null'], enum: [...WORKSPACE_RETENTION_REASONS, null] },
  }, required: ['name', 'job_id', 'issue_key', 'state', 'closed_as', 'modified_at', 'size_bytes', 'removable', 'retained_because'],
} as const;
const workspaceRemovalFailureSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: { name: { type: 'string', pattern: WORKSPACE_DIR_NAME_PATTERN.source }, job_id: { type: 'string', format: 'uuid' }, code: { type: 'string', enum: [...ERROR_CODES] } },
  required: ['name', 'job_id', 'code'],
} as const;
const issueClosureSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: {
    issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' }, resolution: { type: 'string', enum: [...ISSUE_RESOLUTIONS] },
    closed_at: { type: 'string', format: 'date-time' }, closed_by: { type: 'string', pattern: actorPattern.source },
    job_id: { type: ['string', 'null'], format: 'uuid', description: 'Latest non-dry-run READY_FOR_HUMAN attempt at close time, else null.' },
    commit_sha: { type: ['string', 'null'] }, feature_branch: { type: ['string', 'null'] },
  }, required: ['issue_key', 'resolution', 'closed_at', 'closed_by', 'job_id', 'commit_sha', 'feature_branch'],
} as const;
const closeRequestSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: {
    resolution: { type: 'string', enum: [...ISSUE_RESOLUTIONS], description: 'MERGED: the operator merged the latest READY_FOR_HUMAN commit. ABANDONED: the work will not be used.' },
    note: { type: 'string', minLength: 1, maxLength: 2000, description: 'Optional operator note kept in evidence (closure.json); never returned, logged or put in events.' },
    dry_run: { type: 'boolean', default: false, description: 'Report what would be removed without changing anything.' },
  }, required: ['resolution'], examples: [{ resolution: 'MERGED', dry_run: true }],
} as const;
const closeResultSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: { dry_run: { type: 'boolean' }, closure: issueClosureSchemaJson, removed: { type: 'array', items: workspaceEntrySchemaJson }, failed: { type: 'array', items: workspaceRemovalFailureSchemaJson } },
  required: ['dry_run', 'closure', 'removed', 'failed'],
  examples: [{ dry_run: true, closure: { issue_key: 'SAMPLE-123', resolution: 'MERGED', closed_at: '2026-11-07T12:00:00.000Z', closed_by: 'operator', job_id: '00000000-0000-4000-8000-000000000001', commit_sha: null, feature_branch: null }, removed: [], failed: [] }],
} as const;
const workspacesResponseSchema = {
  type: 'object', additionalProperties: false,
  properties: { workspaces: { type: 'array', items: workspaceEntrySchemaJson }, retention_hours: { type: 'integer', minimum: 0 }, auto_prune: { type: 'boolean' } },
  required: ['workspaces', 'retention_hours', 'auto_prune'], examples: [{ workspaces: [], retention_hours: 72, auto_prune: true }],
} as const;
const pruneRequestSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: {
    dry_run: { type: 'boolean', default: false },
    older_than_hours: { type: 'integer', minimum: 0, maximum: 2160, description: 'Overrides jobs.workspace_retention_hours for this run (closed issues are always removable).' },
    sizes: { type: 'boolean', default: false },
  }, examples: [{ dry_run: true, older_than_hours: 24 }],
} as const;
const pruneResultSchemaJson = {
  type: 'object', additionalProperties: false,
  properties: {
    dry_run: { type: 'boolean' }, removed: { type: 'array', items: workspaceEntrySchemaJson }, failed: { type: 'array', items: workspaceRemovalFailureSchemaJson },
    freed_bytes: { type: ['integer', 'null'], minimum: 0, description: 'Sum of removed sizes when sizes were requested, else null.' }, remaining: { type: 'integer', minimum: 0 },
  }, required: ['dry_run', 'removed', 'failed', 'freed_bytes', 'remaining'],
  examples: [{ dry_run: true, removed: [], failed: [], freed_bytes: null, remaining: 0 }],
} as const;
const ticketNoteSchemaJson = {
  type: 'object', additionalProperties: false,
  description: 'Operator guidance stored for an issue key; applied to every attempt of the issue until removed. The text is evidence only and never appears in events or logs.',
  properties: {
    note_id: { type: 'string', format: 'uuid' }, issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' },
    instructions: { type: 'string', minLength: 1, maxLength: 4000 },
    roles: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['swe', 'qa', 'reviewer'] } },
    author: { type: 'string', pattern: actorPattern.source }, created_at: { type: 'string', format: 'date-time' },
  }, required: ['note_id', 'issue_key', 'instructions', 'roles', 'author', 'created_at'],
  examples: [{ note_id: '00000000-0000-4000-8000-000000000010', issue_key: 'SAMPLE-123', instructions: 'Change only InvoiceService.java.', roles: ['swe'], author: 'operator', created_at: '2026-11-07T12:00:00.000Z' }],
} as const;
const ticketNoteCreatedSchemaJson = {
  ...ticketNoteSchemaJson,
  properties: { ...ticketNoteSchemaJson.properties, jira: { type: 'string', enum: ['found', 'not_found', 'unchecked'], description: 'Best-effort read-only Jira lookup: found, not_found (the note is kept; the issue may not exist yet or the key may be mistyped) or unchecked (no Jira read available or the lookup failed).' } },
  required: [...ticketNoteSchemaJson.required, 'jira'],
  examples: [{ ...ticketNoteSchemaJson.examples[0], jira: 'unchecked' }],
} as const;
const ticketNotesSummarySchemaJson = {
  type: 'object', additionalProperties: false,
  description: 'An issue with ticket notes or a hold, and whether Autos has worked on it.',
  properties: {
    issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' },
    notes: { type: 'array', maxItems: MAX_TICKET_NOTES, items: ticketNoteSchemaJson },
    held: { type: 'boolean', description: 'Automatic discovery does not queue a held issue (explicit runs still work).' },
    status: { type: 'string', enum: [...TICKET_WORK_STATUSES], description: 'not_seen: no attempt yet (held when also on hold); otherwise derived from the latest non-dry-run attempt.' },
    attempts: { type: 'integer', minimum: 0 }, dry_runs: { type: 'integer', minimum: 0 },
    latest_job_id: { type: ['string', 'null'], format: 'uuid' }, latest_state: { type: ['string', 'null'], enum: [...jobStateEnum, null] },
    last_activity_at: nullableString,
    attempts_with_current_notes: { type: 'integer', minimum: 0, description: 'Attempts (any mode) that received every current ticket note.' },
  }, required: ['issue_key', 'notes', 'held', 'status', 'attempts', 'dry_runs', 'latest_job_id', 'latest_state', 'last_activity_at', 'attempts_with_current_notes'],
  examples: [{ issue_key: 'SAMPLE-123', notes: [], held: true, status: 'held', attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0 }],
} as const;
const ticketNotesListSchemaJson = { type: 'object', additionalProperties: false, properties: { tickets: { type: 'array', items: ticketNotesSummarySchemaJson } }, required: ['tickets'], examples: [{ tickets: [] }] } as const;
const issueDetailSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' }, closure: { ...issueClosureSchemaJson, type: ['object', 'null'] }, jobs: { type: 'array', items: jobSchema, description: 'This issue\'s attempts, newest first.' },
    ticket_notes: { ...ticketNotesSummarySchemaJson, description: 'Ticket notes, hold and Autos\' progress for this issue (empty notes and not held when there are none).' },
  },
  required: ['issue_key', 'closure', 'jobs', 'ticket_notes'], examples: [{ issue_key: 'SAMPLE-123', closure: null, jobs: [], ticket_notes: ticketNotesSummarySchemaJson.examples[0] }],
} as const;
const eventsResponseSchema = { type: 'object', additionalProperties: false, properties: { events: { type: 'array', items: eventSchema }, next_after: { type: 'integer', minimum: 0 } }, required: ['events', 'next_after'], examples: [{ events: [], next_after: 0 }] } as const;
const eventsQuerySchema = (withJob: boolean) => ({ type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, ...(withJob ? { job_id: { type: 'string', format: 'uuid' } } : {}) } }) as const;
const activeJobSchemaJson = {
  type: 'object', additionalProperties: false, properties: {
    job_id: { type: 'string', format: 'uuid' }, issue_key: { type: 'string' }, state: { type: 'string', enum: jobStateEnum }, dry_run: { type: 'boolean' },
    repair_round: { type: 'integer', minimum: 0, maximum: 2 }, stage: { type: ['string', 'null'], enum: [...WORKFLOW_STAGES, null] }, stage_started_at: nullableString,
    role: { type: ['string', 'null'], enum: [...roleEnum, null] }, provider: { type: ['string', 'null'], enum: [...providerEnum, null] }, started_at: { type: 'string', format: 'date-time' },
  }, required: ['job_id', 'issue_key', 'state', 'dry_run', 'repair_round', 'stage', 'stage_started_at', 'role', 'provider', 'started_at'],
} as const;
const activeJobWithElapsedSchema = {
  ...activeJobSchemaJson,
  properties: { ...activeJobSchemaJson.properties, active_elapsed_s: { type: 'integer', minimum: 0 }, stage_elapsed_s: { type: 'integer', minimum: 0 } },
} as const;
const pausedJobSchemaJson = {
  type: 'object', additionalProperties: false, description: 'A PAUSED attempt (holds no slot) waiting for provider limits to reset.',
  properties: {
    job_id: { type: 'string', format: 'uuid' }, issue_key: { type: 'string' }, repair_round: { type: 'integer', minimum: 0, maximum: 2 },
    role: { type: ['string', 'null'], enum: [...roleEnum, null] }, code: { type: ['string', 'null'], enum: [...ERROR_CODES, null] },
    resume_at: nullableString, paused_since: nullableString, pause_count: { type: 'integer', minimum: 0 },
  }, required: ['job_id', 'issue_key', 'repair_round', 'role', 'code', 'resume_at', 'paused_since', 'pause_count'],
} as const;
const activitySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    active: { ...activeJobSchemaJson, type: ['object', 'null'] },
    active_jobs: { type: 'array', items: activeJobSchemaJson },
    paused_jobs: { type: 'array', items: pausedJobSchemaJson },
    provider_limits: { type: 'object', additionalProperties: false,
      description: 'Known provider limits and the new-ticket gate: while every SWE-chain provider is limited, new QUEUED tickets wait (due PAUSED attempts still resume).',
      properties: {
        providers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string', enum: [...providerEnum] }, until: { type: 'string', format: 'date-time' } }, required: ['provider', 'until'] } },
        gate_active: { type: 'boolean' }, gate_until: nullableString,
      }, required: ['providers', 'gate_active', 'gate_until'] },
    slots: { type: 'object', additionalProperties: false, properties: {
      max_parallel: { type: 'integer', minimum: 1 }, in_use: { type: 'integer', minimum: 0 }, max_concurrent_checks: { type: 'integer', minimum: 1 }, checks_in_use: { type: 'integer', minimum: 0 },
    }, required: ['max_parallel', 'in_use', 'max_concurrent_checks', 'checks_in_use'] },
    polling: { type: 'object', additionalProperties: false, properties: {
      in_progress: { type: 'boolean' }, last_started_at: nullableString, last_finished_at: nullableString,
      last_outcome: { type: ['string', 'null'], enum: ['OK', 'FAILED', null] }, last_error_code: { type: ['string', 'null'] }, last_discovered: { type: ['integer', 'null'], minimum: 0 },
    }, required: ['in_progress', 'last_started_at', 'last_finished_at', 'last_outcome', 'last_error_code', 'last_discovered'] },
    counts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    last_event_id: { type: 'integer', minimum: 0 },
  }, required: ['active', 'active_jobs', 'paused_jobs', 'provider_limits', 'slots', 'polling', 'counts', 'last_event_id'],
} as const;
const statusResponseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    controller: { type: 'object', additionalProperties: false, properties: {
      version: { type: 'string' }, started_at: { type: 'string', format: 'date-time' }, uptime_s: { type: 'integer', minimum: 0 }, poll_interval_s: { type: 'integer', minimum: 1 },
      poll_loop: { type: 'object', additionalProperties: false, properties: { running: { type: 'boolean' }, next_poll_at: nullableString, consecutive_failures: { type: 'integer', minimum: 0 }, auto_poll: { type: 'boolean', description: 'jira.auto_poll; when false the controller never reads the Jira filter and only runs submitted jobs.' }, last_discovery_at: { ...nullableString, description: 'Completion time of the last successful Jira discovery.' } }, required: ['running', 'next_poll_at', 'consecutive_failures', 'auto_poll', 'last_discovery_at'] },
    }, required: ['version', 'started_at', 'uptime_s', 'poll_interval_s', 'poll_loop'] },
    runner: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['ready', 'unknown', 'unreachable'] }, version: { type: 'integer' }, docker: { type: 'string', enum: ['available', 'unavailable', 'test-only'] }, toolchains: { type: 'object', additionalProperties: false, properties: { jdk: { type: 'array', items: { type: 'string' } }, tomcat: { type: 'array', items: { type: 'string' } } }, required: ['jdk', 'tomcat'] } }, required: ['status'] },
    activity: activitySchema,
    active_elapsed_s: { type: 'integer', minimum: 0 },
    stage_elapsed_s: { type: 'integer', minimum: 0 },
    active_jobs: { type: 'array', items: activeJobWithElapsedSchema },
  }, required: ['controller', 'runner', 'activity', 'active_jobs'],
  examples: [{ controller: { version: '0.1.0', started_at: '2026-11-07T12:00:00.000Z', uptime_s: 60, poll_interval_s: 60, poll_loop: { running: true, next_poll_at: '2026-11-07T12:01:00.000Z', consecutive_failures: 0, auto_poll: true, last_discovery_at: '2026-11-07T12:00:00.000Z' } }, runner: { status: 'unknown' }, activity: { active: null, active_jobs: [], paused_jobs: [], provider_limits: { providers: [], gate_active: false, gate_until: null }, slots: { max_parallel: 1, in_use: 0, max_concurrent_checks: 1, checks_in_use: 0 }, polling: { in_progress: false, last_started_at: null, last_finished_at: null, last_outcome: null, last_error_code: null, last_discovered: null }, counts: {}, last_event_id: 0 }, active_jobs: [] }],
} as const;
const retryBlockedSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    matched: { type: 'integer', minimum: 0, description: 'Blocked jobs that matched the filter.' },
    retried: { type: 'integer', minimum: 0 }, skipped_newer_attempt: { type: 'integer', minimum: 0 }, failed: { type: 'integer', minimum: 0 },
    jobs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { issue_key: { type: 'string' }, job_id: { type: 'string', format: 'uuid' }, new_job_id: { type: 'string', format: 'uuid' } }, required: ['issue_key', 'job_id', 'new_job_id'] } },
  }, required: ['matched', 'retried', 'skipped_newer_attempt', 'failed', 'jobs'],
  examples: [{ matched: 2, retried: 1, skipped_newer_attempt: 1, failed: 0, jobs: [{ issue_key: 'SAMPLE-123', job_id: '00000000-0000-4000-8000-000000000001', new_job_id: '00000000-0000-4000-8000-000000000002' }] }],
} as const;
const queueResponseSchema = { type: 'object', additionalProperties: false, properties: { jobs: { type: 'array', items: jobSchema }, next_cursor: { type: ['string', 'null'] } }, required: ['jobs', 'next_cursor'], examples: [{ jobs: [], next_cursor: null }] } as const;
const manifestSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', const: 1 }, job_id: { type: 'string', format: 'uuid' }, issue_key: { type: 'string' }, status: { type: 'string' },
    candidate_digest: { type: ['string', 'null'] }, base_sha: { type: ['string', 'null'] }, commit_sha: { type: ['string', 'null'] },
    feature_branch: { type: ['string', 'null'] }, push_status: { type: 'string', enum: ['DISABLED', 'NOT_ATTEMPTED', 'PUSHED', 'FAILED'] },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, media_type: { type: 'string' },
    }, required: ['name', 'sha256', 'media_type'] } },
  }, required: ['schema_version', 'job_id', 'issue_key', 'status', 'candidate_digest', 'base_sha', 'commit_sha', 'feature_branch', 'push_status', 'files'],
} as const;

/** Remove URLs, filesystem paths, and token-like strings from operator-visible free text. */
export function scrubText(text: string, max = 500): string {
  return text
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/(^|[\s(=:"'])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, '$1[path]')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, max);
}

/** Operator-safe job projection shared by the HTTP handlers and the CLI. */
export function safeJob(job: JobRecord): JobRecord {
  // Domain records are already constrained, but never echo unexpected provider text in API fields.
  const clean: JobRecord = {
    job_id: job.job_id, issue_key: job.issue_key, repository_id: job.repository_id, base_sha: job.base_sha,
    state: job.state, dry_run: job.dry_run, repair_round: job.repair_round, created_at: job.created_at, updated_at: job.updated_at,
  };
  if (job.blocked_code) clean.blocked_code = job.blocked_code;
  if (job.blocked_reason) clean.blocked_reason = scrubText(job.blocked_reason);
  if (job.base_branch) clean.base_branch = job.base_branch;
  if (job.feature_branch) clean.feature_branch = job.feature_branch;
  if (job.commit_sha) clean.commit_sha = job.commit_sha;
  if (job.closed_as) clean.closed_as = job.closed_as;
  if (job.state === 'PAUSED') {
    if (job.resume_at) clean.resume_at = job.resume_at;
    if (job.pause_code) clean.pause_code = job.pause_code;
    if (job.paused_role) clean.paused_role = job.paused_role;
    if (job.paused_since) clean.paused_since = job.paused_since;
    if (job.pause_count) clean.pause_count = job.pause_count;
  }
  // Read through a widened view until JobRecord (ports.ts) declares the revision fields.
  const revisionFields = job as JobRecord & { parent_job_id?: string; revision?: number };
  const extras = clean as JobRecord & { parent_job_id?: string; revision?: number };
  if (revisionFields.parent_job_id) extras.parent_job_id = revisionFields.parent_job_id;
  if (revisionFields.revision !== undefined) extras.revision = revisionFields.revision;
  return clean;
}

/** Operator-safe event projection: events are sanitized upstream, but free text is scrubbed again at the boundary. */
export function safeEvent(event: JobEvent): JobEvent {
  return event.message === undefined ? event : { ...event, message: scrubText(event.message, 300) };
}

export interface StatusResponse {
  controller: { version: string; started_at: string; uptime_s: number; poll_interval_s: number; poll_loop: LoopStatus };
  runner: RunnerHealthResult;
  activity: WorkflowActivity;
  active_elapsed_s?: number;
  stage_elapsed_s?: number;
  /** Every active job with server-computed elapsed seconds (the first entry matches the top-level fields). */
  active_jobs: Array<ActiveJob & { active_elapsed_s?: number; stage_elapsed_s?: number }>;
}

function emptyTicketSummary(issueKey: string): TicketNotesSummary {
  return { issue_key: issueKey, notes: [], held: false, status: 'not_seen', attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0 };
}

function elapsedSeconds(from: string | null | undefined, now: number): number | undefined {
  if (!from) return undefined;
  const start = Date.parse(from);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : undefined;
}

function tokenMatches(expected: string, supplied: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(a, b);
}

export async function createController(options: ControllerOptions): Promise<FastifyInstance> {
  const host = options.bindHost ?? options.config.api.listen_host;
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('Controller bind address is not allowed');
  if (!options.operatorToken || options.operatorToken.length < 16) throw new Error('Operator token must contain at least 16 characters');
  // removeAdditional is disabled so unknown body fields are rejected (400) instead of silently stripped.
  const logger: NonNullable<FastifyServerOptions['logger']> = options.logStream ? {
    level: 'info',
    stream: options.logStream,
    base: { service: 'autos-controller' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    // Nothing request- or error-shaped is ever logged whole: these serializers drop everything but safe fields.
    serializers: {
      req: (request: { method?: string }) => ({ method: request.method ?? '' }),
      res: (reply: { statusCode?: number }) => ({ status: reply.statusCode ?? 0 }),
      err: (error: { code?: unknown }) => ({ type: 'Error', message: 'redacted', stack: '', code: typeof error.code === 'string' && /^[A-Z_]{3,40}$/.test(error.code) ? error.code : 'INTERNAL' }),
    },
  } : false;
  const serverOptions: FastifyServerOptions = { logger, logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => randomUUID(), ajv: { customOptions: { removeAdditional: false } } };
  const app: FastifyInstance = Fastify(serverOptions);
  const running = new Map<string, AbortController>();
  const background = new Set<Promise<unknown>>();

  // Jobs whose execute lost the single-active-job claim (e.g. the previous job is terminal but still releasing
  // its lease). They are retried when any background execution settles, never via workflow.poll.
  const deferred = new Set<string>();
  let retryTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const reportBackgroundFailure = (jobId: string, failure: unknown): void => {
    const code = failure instanceof AutosError ? failure.code : 'INTERNAL';
    // Workflow persists safe failure state; this event contains no upstream text or token.
    if (options.onBackgroundFailure) options.onBackgroundFailure({ job_id: jobId, code });
    else process.stderr.write(`${JSON.stringify({ event: 'job_execution_failed', job_id: jobId, code })}\n`);
  };
  function launch(jobId: string): void {
    const abort = running.get(jobId) ?? new AbortController(); running.set(jobId, abort);
    const task: Promise<void> = options.workflow.execute(jobId, abort.signal)
      .then(() => undefined, (error: unknown) => {
        if (abort.signal.aborted) return;
        if (error instanceof AutosError && error.code === 'CONFLICT') { deferred.add(jobId); return; }
        reportBackgroundFailure(jobId, error);
      })
      .finally(() => {
        background.delete(task);
        // A job that just conflicted again is retried by the timer, not immediately (avoids a hot loop).
        if (deferred.has(jobId)) scheduleRetry();
        else { running.delete(jobId); drainDeferred(); }
      });
    background.add(task);
  }
  function scheduleRetry(): void {
    if (retryTimer || closing) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; drainDeferred(); }, 1000); retryTimer.unref();
  }
  // Attempt every deferred job in FIFO order, each independently: with N slots several may start at once, and a
  // job that still conflicts (slots full, or its issue is busy) simply goes back to the deferred set for the timer.
  function drainDeferred(): void {
    if (closing || deferred.size === 0) return;
    void (async () => {
      for (const id of [...deferred]) {
        deferred.delete(id);
        const abort = running.get(id);
        if (!abort || abort.signal.aborted) { running.delete(id); continue; }
        const current = await options.workflow.get(id).catch(() => null);
        if (closing || abort.signal.aborted || current?.state !== 'QUEUED') { running.delete(id); continue; }
        launch(id);
      }
    })();
  }

  await app.register(swagger, {
    openapi: { openapi: '3.1.0', info: { title: 'Autos Controller API', version: '0.1.0' }, servers: [{ url: 'http://127.0.0.1:8787', description: 'Local controller' }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } },
    transform: ({ schema, url }) => {
      if (!url.startsWith('/v1')) return { url, schema };
      const responses = schema.response && typeof schema.response === 'object' ? schema.response as Record<string, unknown> : {};
      return { url, schema: { ...schema, response: { ...responses, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema } } };
    },
  });
  // One safe access line per request: id, method, route pattern (never the raw URL/query), status, duration.
  app.addHook('onResponse', async (request, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode === 401 || reply.statusCode === 403 ? 'warn' : request.url === '/health' ? 'debug' : 'info';
    request.log[level]({ event: 'request', request_id: request.id, method: request.method, route: request.routeOptions?.url ?? 'unmatched', status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime) });
  });
  /** Audit trail for operator mutations: ids and the actor label only, never note text. */
  const audit = (request: FastifyRequest, action: string, fields: Record<string, unknown>): void => {
    const header = request.headers['x-autos-operator'];
    request.log.info({ event: 'audit', action, request_id: request.id, actor: typeof header === 'string' && actorPattern.test(header) ? header : 'operator', ...fields });
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1')) return;
    const header = request.headers.authorization ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match || !tokenMatches(options.operatorToken, match[1]!)) {
      request.log.warn({ event: 'auth_rejected', request_id: request.id, method: request.method, presented: match ? 'bearer' : header ? 'malformed' : 'none' });
      return reply.code(401).send({ code: 'AUTH', message: 'Bearer token required', request_id: request.id });
    }
  });
  app.setErrorHandler((error: Error & { validation?: unknown }, request, reply) => {
    if (reply.sent) return;
    const known = error instanceof AutosError ? error : undefined;
    const statuses: Record<string, number> = { INVALID_CONFIG: 422, INVALID_INPUT: 400, AUTH: 401, FORBIDDEN: 403, NOT_FOUND: 404, BRANCH_COLLISION: 409, CONFLICT: 409, RATE_LIMIT: 429, POLICY: 422, MAPPING: 422, STALE_CANDIDATE: 409, CHECK_FAILED: 422 };
    const messages: Record<string, string> = { INVALID_CONFIG: 'Configuration is invalid', INVALID_INPUT: 'Request is invalid', AUTH: 'Authentication is required', FORBIDDEN: 'Operation is not permitted', NOT_FOUND: 'Resource not found', BRANCH_COLLISION: 'A conflicting branch exists', CONFLICT: 'The request conflicts with current state', RATE_LIMIT: 'A dependency is rate limited', POLICY: 'Request is blocked by policy', MAPPING: 'Project mapping could not be resolved', STALE_CANDIDATE: 'Candidate evidence is stale', CHECK_FAILED: 'Required checks did not pass' };
    const status = error.validation ? 400 : known ? (statuses[known.code] ?? 500) : 500;
    const code = error.validation ? 'INVALID_INPUT' : known?.code ?? 'INTERNAL';
    request.log.warn({ event: 'request_error', request_id: request.id, route: request.routeOptions?.url ?? 'unmatched', status, code });
    const message = error.validation ? 'Request does not match the endpoint schema' : messages[code] ?? 'Request could not be completed';
    reply.code(status).send({ code, message, request_id: request.id });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Resource not found', request_id: request.id }));
  app.addHook('onClose', async () => {
    closing = true; if (retryTimer) clearTimeout(retryTimer);
    for (const abort of running.values()) abort.abort();
    await Promise.allSettled([...background]);
    await options.close();
  });

  app.get('/health', { schema: { tags: ['health'], summary: 'Check controller health', operationId: 'getHealth', security: [], response: { 200: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', const: 'ok' } }, required: ['status'], examples: [{ status: 'ok' }] } } } }, async () => ({ status: 'ok' }));
  app.get('/v1/providers', { schema: { tags: ['operator'], summary: 'List provider diagnostics', operationId: 'listProviders', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', additionalProperties: false, properties: { providers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string', enum: ['claude', 'codex', 'cursor'] }, binary_present: { type: 'boolean' }, authenticated: { type: ['boolean', 'null'] }, read_only_smoke: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] }, message: { type: 'string' }, model: { type: 'string', enum: ['auto'], description: 'Present for cursor only: Cursor always uses its automatic model selection.' }, roles: { type: 'array', description: 'Where this provider appears in a role chain (chain_index 0 = primary, 1..2 = fallbacks).', items: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', enum: ['swe', 'qa', 'reviewer'] }, chain_index: { type: 'integer', minimum: 0, maximum: 2 } }, required: ['role', 'chain_index'] } } }, required: ['provider', 'binary_present', 'authenticated', 'read_only_smoke', 'message', 'roles'] } } }, required: ['providers'], examples: [{ providers: [{ provider: 'claude', binary_present: true, authenticated: null, read_only_smoke: 'NOT_RUN', message: 'Host binary presence only; runner authentication has not been tested.', roles: [{ role: 'swe', chain_index: 0 }, { role: 'qa', chain_index: 1 }] }, { provider: 'cursor', binary_present: true, authenticated: null, read_only_smoke: 'NOT_RUN', message: 'Host binary presence only; runner authentication has not been tested.', model: 'auto', roles: [{ role: 'swe', chain_index: 2 }] }] }] } } } }, async () => ({ providers: listProviders(options.config, await options.providers()) }));
  app.get('/v1/projects', { schema: { tags: ['operator'], summary: 'List configured projects', operationId: 'listProjects', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', additionalProperties: false, properties: { projects: { type: 'array', items: projectSchema } }, required: ['projects'] } } } }, async () => ({ projects: projectMappingSchema.array().parse(await options.projects()) }));
  const listJobs = async (request: { query: unknown }) => {
    const query = request.query as { limit?: number; cursor?: string };
    const limit = query.limit ?? 50;
    const offset = Number(query.cursor ?? '0');
    const rows = await options.workflow.list(limit + 1, offset);
    const selected = rows.slice(0, limit);
    return { jobs: selected.map(safeJob), next_cursor: rows.length > limit ? String(offset + limit) : null };
  };
  const listSchema = (summary: string, operationId: string) => ({ tags: ['operator'], summary, operationId, security: [{ bearerAuth: [] }], querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, cursor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,5})$' } } }, response: { 200: queueResponseSchema } });
  app.get('/v1/queue', { schema: listSchema('List queued and active jobs', 'listQueue') }, listJobs);
  app.get('/v1/jobs', { schema: listSchema('List recent job history', 'listJobHistory') }, listJobs);
  app.post('/v1/jobs', { schema: { tags: ['operator'], summary: 'Queue a new job', operationId: 'createJob', security: [{ bearerAuth: [] }], headers: actorHeaders, body: { type: 'object', additionalProperties: false, properties: { issue_key: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' }, dry_run: { type: 'boolean', default: true }, notes: { type: 'array', maxItems: 5, items: noteRequestSchema, description: 'Optional operator notes for this attempt.' } }, required: ['issue_key'], examples: [{ issue_key: 'SAMPLE-123', dry_run: true }] }, response: { 202: jobSchema, 400: errorSchema } } }, async (request, reply) => {
    const body = request.body as { issue_key: string; dry_run?: boolean; notes?: unknown[] };
    const parsed = issueKeySchema.safeParse(body.issue_key);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid issue key', request_id: request.id });
    const notes = operatorNoteRequestSchema.array().max(5).safeParse(body.notes ?? []);
    if (!notes.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator notes', request_id: request.id });
    const job = await options.workflow.submit(parsed.data, body.dry_run ?? true, ...(notes.data.length ? [notes.data] as const : []));
    audit(request, 'job_submit', { job_id: job.job_id, issue_key: job.issue_key, dry_run: job.dry_run });
    if (job.state === 'QUEUED') launch(job.job_id);
    return reply.code(202).send(safeJob(job));
  });
  app.post('/v1/jobs/retry-blocked', { schema: { tags: ['operator'], summary: 'Retry blocked jobs in bulk', description: 'Starts a new attempt (workflow retry) for every BLOCKED job, optionally only those with one `blocked_code`. A job is skipped when its issue already has a newer attempt, so only the newest blocked attempt per issue is retried. New attempts are queued; the controller runs them as slots free up.', operationId: 'retryBlockedJobs', security: [{ bearerAuth: [] }], headers: actorHeaders, body: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', enum: [...ERROR_CODES], description: 'Only retry jobs blocked with this code.' } }, examples: [{ code: 'UPSTREAM' }] }, response: { 200: retryBlockedSchema, 400: errorSchema } } }, async (request) => {
    const body = (request.body ?? {}) as { code?: string };
    const result = await retryBlockedJobs(options.workflow, body.code === undefined ? {} : { code: body.code });
    audit(request, 'jobs_retry_blocked', { matched: result.matched, retried: result.retried, skipped: result.skipped_newer_attempt, failed: result.failed, ...(body.code ? { code: body.code } : {}) });
    for (const entry of result.jobs) audit(request, 'job_retry', { job_id: entry.job_id, new_job_id: entry.new_job_id, issue_key: entry.issue_key });
    // Start at most one execution per free slot now; the drain loop runs the rest as slots free up.
    for (const entry of result.jobs.slice(0, options.config.jobs.max_parallel)) launch(entry.new_job_id);
    return result;
  });
  /** Author label from X-Autos-Operator (default operator); null when malformed. */
  const operatorLabel = (request: FastifyRequest): string | null => {
    const header = request.headers['x-autos-operator'];
    const author = header === undefined ? 'operator' : header;
    return typeof author === 'string' && operatorNoteSchema.shape.author.safeParse(author).success ? author : null;
  };
  /** Best-effort read-only Jira existence check for a freshly stored note; never fails the request. */
  const jiraLookup = async (issueKey: string): Promise<'found' | 'not_found' | 'unchecked'> => {
    const check = options.diagnostics?.jiraIssueExists;
    if (!check) return 'unchecked';
    let timer: NodeJS.Timeout | undefined;
    try {
      const abort = new AbortController();
      const found = await Promise.race([check.call(options.diagnostics, issueKey, abort.signal), new Promise<null>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(null); }, 3000); })]);
      return found === null ? 'unchecked' : found ? 'found' : 'not_found';
    } catch { return 'unchecked'; } finally { if (timer) clearTimeout(timer); }
  };
  app.post('/v1/jobs/:jobId/revisions', { schema: { tags: ['operator'], summary: 'Request changes on a READY_FOR_HUMAN job', description: 'Queues a revision that continues from the reviewed commit on the same feature branch, with operator notes delivered to the selected roles (default SWE). Only the latest READY_FOR_HUMAN attempt of an issue with no active attempt can be revised (409 otherwise). The optional `X-Autos-Operator` header labels the note author; it is a label, not authentication. Notes are stored as evidence and never appear in responses, events, or logs.', operationId: 'createJobRevision', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'] }, headers: { type: 'object', properties: { 'x-autos-operator': { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$', description: 'Optional author label (not authentication). Defaults to operator.' } } }, body: noteRequestSchema, response: { 202: jobSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const note = operatorNoteRequestSchema.safeParse(request.body);
    if (!note.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid revision request', request_id: request.id });
    const author = operatorLabel(request);
    if (author === null) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator label', request_id: request.id });
    if (!await options.workflow.get(jobId)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Job not found', request_id: request.id });
    const job = await options.workflow.revise(jobId, note.data, author);
    audit(request, 'job_revise', { job_id: job.job_id, parent_job_id: jobId, issue_key: job.issue_key, roles: note.data.roles ?? ['swe'] });
    if (job.state === 'QUEUED') launch(job.job_id);
    return reply.code(202).send(safeJob(job));
  });
  app.post('/v1/issues/:issueKey/revisions', { schema: { tags: ['operator'], summary: 'Request changes on an issue\'s latest READY_FOR_HUMAN attempt', description: 'Queues a revision that continues from the latest READY_FOR_HUMAN attempt of the issue (same feature branch and pinned base), with operator notes delivered to the selected roles (default SWE). 404 when the issue has no READY_FOR_HUMAN attempt; 409 when the issue is closed, another attempt is active, or the READY_FOR_HUMAN attempt is not revisable. The optional `X-Autos-Operator` header labels the note author; it is a label, not authentication. Notes are stored as evidence and never appear in responses, events, or logs.', operationId: 'createIssueRevision', security: [{ bearerAuth: [] }], params: issueKeyParams, headers: actorHeaders, body: noteRequestSchema, response: { 202: jobSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const { issueKey } = request.params as { issueKey: string };
    const note = operatorNoteRequestSchema.safeParse(request.body);
    if (!note.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid revision request', request_id: request.id });
    const author = operatorLabel(request);
    if (author === null) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator label', request_id: request.id });
    const job = await options.workflow.reviseIssue(issueKey, note.data, author);
    audit(request, 'issue_revise', { job_id: job.job_id, issue_key: job.issue_key, ...(job.parent_job_id ? { parent_job_id: job.parent_job_id } : {}), roles: note.data.roles ?? ['swe'] });
    if (job.state === 'QUEUED') launch(job.job_id);
    return reply.code(202).send(safeJob(job));
  });
  app.post('/v1/issues/:issueKey/close', { schema: { tags: ['operator'], summary: 'Close an issue after manual review (MERGED or ABANDONED)', description: 'Irreversible. Records the operator\'s resolution, removes ALL of the issue\'s workspaces from disk and keeps artifacts (evidence). Afterwards the issue accepts no new attempt, revision or retry. Autos does not verify that anything was merged: the resolution is an operator assertion, and Jira and Bitbucket are not modified. Refused with 409 while an attempt of the issue is active, or when MERGED is asserted without a non-dry-run READY_FOR_HUMAN attempt; closing again with the same resolution only retries workspace removal. Use `dry_run` to see what would be removed. The optional note is stored in evidence only and never returned, logged or put in events. The optional `X-Autos-Operator` header labels the closer; it is a label, not authentication.', operationId: 'closeIssue', security: [{ bearerAuth: [] }], params: issueKeyParams, headers: actorHeaders, body: closeRequestSchemaJson, response: { 200: closeResultSchemaJson, 400: errorSchema, 404: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const { issueKey } = request.params as { issueKey: string };
    const body = closeIssueRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid close request', request_id: request.id });
    const author = operatorLabel(request);
    if (author === null) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator label', request_id: request.id });
    const result = await options.workflow.closeIssue(issueKey, body.data, author);
    audit(request, 'issue_close', { issue_key: issueKey, resolution: body.data.resolution, dry_run: result.dry_run, removed: result.removed.length, failed: result.failed.length });
    return result;
  });
  app.get('/v1/issues/:issueKey', { schema: { tags: ['operator'], summary: 'Get an issue\'s closure, attempts and ticket notes', description: 'Returns the closure record (null while the issue is open), the issue\'s most recent attempts, newest first, and its ticket notes with the hold and progress summary. 404 when Autos knows nothing about the issue (no attempts, closure, ticket notes or hold).', operationId: 'getIssue', security: [{ bearerAuth: [] }], params: issueKeyParams, response: { 200: issueDetailSchema, 404: errorSchema } } }, async (request, reply) => {
    const { issueKey } = request.params as { issueKey: string };
    const closure = await options.workflow.closure(issueKey);
    const found: JobRecord[] = [];
    for (let offset = 0; offset < ISSUE_SCAN_LIMIT; offset += 100) {
      const page = await options.workflow.list(100, offset);
      found.push(...page.filter((job) => job.issue_key === issueKey));
      if (page.length < 100) break;
    }
    const ticket = (await options.workflow.ticketNotes(issueKey))[0] ?? emptyTicketSummary(issueKey);
    if (!closure && found.length === 0 && ticket.notes.length === 0 && !ticket.held) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Issue not found', request_id: request.id });
    found.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { issue_key: issueKey, closure, jobs: found.slice(0, ISSUE_JOBS_LIMIT).map(safeJob), ticket_notes: ticket };
  });
  const noteDescription = 'Notes are stored by issue key even before the issue is in the Jira filter or Autos has seen it, and are copied into every later attempt of that issue (discovered, submitted, retried or revised) until removed or the issue is closed. Each note targets roles (default swe). 400 for a project outside jira.allowed_projects or an invalid body/header, 409 when the issue is closed or already has the maximum number of notes. The text is evidence only: it never appears in events or logs. The optional `X-Autos-Operator` header labels the author; it is a label, not authentication.';
  app.post('/v1/issues/:issueKey/notes', { schema: { tags: ['operator'], summary: 'Add a ticket note for an issue key', description: `${noteDescription} The response also reports a best-effort read-only Jira lookup (\`jira\`); a note for an issue not found in Jira is still stored.`, operationId: 'addTicketNote', security: [{ bearerAuth: [] }], params: issueKeyParams, headers: actorHeaders, body: noteRequestSchema, response: { 201: ticketNoteCreatedSchemaJson, 400: errorSchema, 409: errorSchema } } }, async (request, reply) => {
    const { issueKey } = request.params as { issueKey: string };
    const note = operatorNoteRequestSchema.safeParse(request.body);
    if (!note.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid ticket note', request_id: request.id });
    const author = operatorLabel(request);
    if (author === null) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator label', request_id: request.id });
    const stored = await options.workflow.addTicketNote(issueKey, note.data, author);
    audit(request, 'ticket_note_add', { issue_key: issueKey, note_id: stored.note_id, roles: stored.roles });
    return reply.code(201).send({ ...stored, jira: await jiraLookup(issueKey) });
  });
  const removeSchema = (summary: string, operationId: string, byId: boolean) => ({ tags: ['operator'], summary, description: byId ? 'Removes one ticket note; later attempts no longer receive it (attempts already created keep their copy). 404 for an unknown note id.' : 'Removes every ticket note of the issue; later attempts no longer receive them (attempts already created keep their copy).', operationId, security: [{ bearerAuth: [] }], params: byId ? { type: 'object', properties: { issueKey: issueKeyParams.properties.issueKey, noteId: { type: 'string', format: 'uuid' } }, required: ['issueKey', 'noteId'] } : issueKeyParams, headers: actorHeaders, response: { 200: { type: 'object', additionalProperties: false, properties: { removed: { type: 'integer', minimum: 0 } }, required: ['removed'], examples: [{ removed: 1 }] }, 404: errorSchema } });
  app.delete('/v1/issues/:issueKey/notes', { schema: removeSchema('Remove all ticket notes of an issue', 'removeTicketNotes', false) }, async (request) => {
    const { issueKey } = request.params as { issueKey: string };
    const removed = await options.workflow.removeTicketNotes(issueKey);
    audit(request, 'ticket_notes_clear', { issue_key: issueKey, removed });
    return { removed };
  });
  app.delete('/v1/issues/:issueKey/notes/:noteId', { schema: removeSchema('Remove one ticket note', 'removeTicketNote', true) }, async (request) => {
    const { issueKey, noteId } = request.params as { issueKey: string; noteId: string };
    const removed = await options.workflow.removeTicketNotes(issueKey, noteId);
    audit(request, 'ticket_note_remove', { issue_key: issueKey, note_id: noteId, removed });
    return { removed };
  });
  const holdSchema = (summary: string, operationId: string, description: string) => ({ tags: ['operator'], summary, description, operationId, security: [{ bearerAuth: [] }], params: issueKeyParams, headers: actorHeaders, response: { 200: { type: 'object', additionalProperties: false, properties: { held: { type: 'boolean' } }, required: ['held'], examples: [{ held: true }] }, 400: errorSchema } });
  const setHold = async (request: FastifyRequest, reply: { code(status: number): { send(body: unknown): unknown } }, held: boolean) => {
    const { issueKey } = request.params as { issueKey: string };
    const author = operatorLabel(request);
    if (author === null) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid operator label', request_id: request.id });
    await options.workflow.setTicketHold(issueKey, held, author);
    audit(request, held ? 'ticket_hold' : 'ticket_release', { issue_key: issueKey });
    return { held };
  };
  app.put('/v1/issues/:issueKey/hold', { schema: holdSchema('Hold an issue', 'holdIssue', 'Stops automatic discovery from queueing the issue until released (explicit runs still work). Works before Autos has seen the issue.') }, async (request, reply) => setHold(request, reply, true));
  app.delete('/v1/issues/:issueKey/hold', { schema: holdSchema('Release a held issue', 'releaseIssue', 'Lets automatic discovery queue the issue again.') }, async (request, reply) => setHold(request, reply, false));
  app.get('/v1/notes', { schema: { tags: ['operator'], summary: 'List issues with ticket notes or a hold', description: 'Every issue that has ticket notes or is held, with whether Autos has worked on it (status, attempts, latest state, whether the latest attempts used the current notes).', operationId: 'listTicketNotes', security: [{ bearerAuth: [] }], response: { 200: ticketNotesListSchemaJson } } }, async () => ({ tickets: await options.workflow.ticketNotes() }));
  app.get('/v1/issues/:issueKey/notes', { schema: { tags: ['operator'], summary: 'Get one issue\'s ticket notes and progress', description: 'Always returns a summary, even for an issue with no notes, no hold and no attempts (status not_seen).', operationId: 'getTicketNotes', security: [{ bearerAuth: [] }], params: issueKeyParams, response: { 200: ticketNotesSummarySchemaJson } } }, async (request) => {
    const { issueKey } = request.params as { issueKey: string };
    return (await options.workflow.ticketNotes(issueKey))[0] ?? emptyTicketSummary(issueKey);
  });
  app.get('/v1/workspaces', { schema: { tags: ['operator'], summary: 'List workspace directories with their retention decision', description: 'Lists workspace directories on the host (basenames only, never paths) with the state of the owning job and why each is kept or removable. `sizes=true` walks the trees to report sizes and can be slow. Also returns the configured retention policy.', operationId: 'listWorkspaces', security: [{ bearerAuth: [] }], querystring: { type: 'object', additionalProperties: false, properties: { sizes: { type: 'boolean', default: false } } }, response: { 200: workspacesResponseSchema, 400: errorSchema } } }, async (request) => {
    const query = request.query as { sizes?: boolean };
    const workspaces = await options.workflow.workspaces({ sizes: query.sizes ?? false });
    return { workspaces, retention_hours: options.config.jobs.workspace_retention_hours, auto_prune: options.config.jobs.auto_prune_workspaces };
  });
  app.post('/v1/workspaces/prune', { schema: { tags: ['operator'], summary: 'Prune removable workspaces now', description: 'Applies the retention policy immediately: removes workspaces of closed issues, superseded attempts, orphan directories, and BLOCKED/CANCELLED attempts older than the retention window (`older_than_hours` overrides `jobs.workspace_retention_hours` for this run). The latest READY_FOR_HUMAN workspace of an open issue is never removed. Artifacts are never removed. Use `dry_run` to preview.', operationId: 'pruneWorkspaces', security: [{ bearerAuth: [] }], headers: actorHeaders, body: pruneRequestSchemaJson, response: { 200: pruneResultSchemaJson, 400: errorSchema } } }, async (request, reply) => {
    const body = pruneWorkspacesRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid prune request', request_id: request.id });
    const result = await options.workflow.pruneWorkspaces(body.data);
    audit(request, 'workspaces_prune', { dry_run: result.dry_run, removed: result.removed.length, failed: result.failed.length, remaining: result.remaining, ...(body.data.older_than_hours !== undefined ? { older_than_hours: body.data.older_than_hours } : {}) });
    return result;
  });
  app.get('/v1/jobs/:jobId', { schema: { tags: ['operator'], summary: 'Get job details', operationId: 'getJob', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'] }, response: { 200: jobSchema, 404: errorSchema } } }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await options.workflow.get(jobId);
    if (!job) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Job not found', request_id: request.id });
    // Push outcome lives in the artifact manifest; absence (e.g. job not started) is simply omitted.
    const manifest = await options.artifacts.manifest(jobId).then((value) => artifactManifestSchema.safeParse(value), () => null);
    return manifest?.success && manifest.data.job_id === jobId ? { ...safeJob(job), push_status: manifest.data.push_status } : safeJob(job);
  });
  app.get('/v1/jobs/:jobId/artifacts', { schema: { tags: ['operator'], summary: 'Get safe artifact manifest metadata', operationId: 'getJobArtifacts', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'] }, response: { 200: manifestSchema, 404: errorSchema } } }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await options.workflow.get(jobId);
    if (!job) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Job not found', request_id: request.id });
    const manifest: ArtifactManifest = await options.artifacts.manifest(jobId);
    const parsed = artifactManifestSchema.parse(manifest);
    if (parsed.job_id !== jobId || parsed.issue_key !== job.issue_key) throw new AutosError('INTERNAL', 'Artifact manifest does not match its job');
    return parsed;
  });
  app.post('/v1/jobs/:jobId/cancel', { schema: { tags: ['operator'], summary: 'Cancel a queued or active job', operationId: 'cancelJob', security: [{ bearerAuth: [] }], headers: actorHeaders, params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'] }, response: { 200: jobSchema, 404: errorSchema } } }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await options.workflow.get(jobId);
    if (!job) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Job not found', request_id: request.id });
    audit(request, 'job_cancel', { job_id: jobId, issue_key: job.issue_key });
    running.get(jobId)?.abort();
    return safeJob(await options.workflow.cancel(jobId));
  });

  const startedAtMs = Date.now();
  const heartbeatMs = options.sseHeartbeatMs ?? 15_000;
  const healthTimeoutMs = options.runnerHealthTimeoutMs ?? 2000;
  const probeRunner = async (): Promise<RunnerHealthResult> => {
    if (!options.runnerHealth) return { status: 'unknown' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        options.runnerHealth(),
        new Promise<RunnerHealthResult>((resolve) => { timer = setTimeout(() => resolve({ status: 'unreachable' }), healthTimeoutMs); }),
      ]);
      return result;
    } catch { return { status: 'unreachable' }; } finally { if (timer) clearTimeout(timer); }
  };
  app.get('/v1/status', { schema: { tags: ['operator'], summary: 'Get live controller, runner, and workflow activity status', operationId: 'getStatus', security: [{ bearerAuth: [] }], response: { 200: statusResponseSchema } } }, async (): Promise<StatusResponse> => {
    const [runner, activity] = await Promise.all([probeRunner(), options.workflow.activity()]);
    const now = Date.now();
    const loop: LoopStatus = options.loopStatus?.() ?? { running: false, next_poll_at: null, consecutive_failures: 0, auto_poll: options.config.jira.auto_poll, last_discovery_at: null };
    const response: StatusResponse = {
      controller: { version: '0.1.0', started_at: new Date(startedAtMs).toISOString(), uptime_s: Math.max(0, Math.floor((now - startedAtMs) / 1000)), poll_interval_s: options.config.jira.poll_seconds, poll_loop: { running: loop.running, next_poll_at: loop.next_poll_at, consecutive_failures: loop.consecutive_failures, auto_poll: loop.auto_poll, last_discovery_at: loop.last_discovery_at } },
      runner, activity,
      active_jobs: activity.active_jobs.map((job) => {
        const entry: StatusResponse['active_jobs'][number] = { ...job };
        const active = elapsedSeconds(job.started_at, now); if (active !== undefined) entry.active_elapsed_s = active;
        const stage = elapsedSeconds(job.stage_started_at, now); if (stage !== undefined) entry.stage_elapsed_s = stage;
        return entry;
      }),
    };
    const first = response.active_jobs[0];
    if (first) {
      if (first.active_elapsed_s !== undefined) response.active_elapsed_s = first.active_elapsed_s;
      if (first.stage_elapsed_s !== undefined) response.stage_elapsed_s = first.stage_elapsed_s;
    }
    return response;
  });
  const listEvents = async (query: { after?: number; limit?: number }, jobId?: string) => {
    const after = query.after ?? 0;
    const events = (await options.workflow.events({ ...(jobId ? { job_id: jobId } : {}), after, limit: query.limit ?? 100 })).map(safeEvent);
    return { events, next_after: events.length ? events[events.length - 1]!.event_id : after };
  };
  app.get('/v1/events', { schema: { tags: ['operator'], summary: 'List persisted progress events after a cursor', operationId: 'listEvents', security: [{ bearerAuth: [] }], querystring: eventsQuerySchema(true), response: { 200: eventsResponseSchema } } }, async (request) => {
    const query = request.query as { after?: number; limit?: number; job_id?: string };
    return listEvents(query, query.job_id);
  });
  app.get('/v1/jobs/:jobId/events', { schema: { tags: ['operator'], summary: 'List persisted progress events for one job', operationId: 'listJobEvents', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'] }, querystring: eventsQuerySchema(false), response: { 200: eventsResponseSchema, 404: errorSchema } } }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    if (!await options.workflow.get(jobId)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Job not found', request_id: request.id });
    return listEvents(request.query as { after?: number; limit?: number }, jobId);
  });

  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const end of [...streams]) end(); });
  app.get('/v1/events/stream', { schema: { tags: ['operator'], summary: 'Stream progress events as Server-Sent Events', description: 'Replays persisted events after `after` (or the Last-Event-ID header), then streams live events. Each message has `id` (event_id), `event` (type) and JSON `data`; a comment heartbeat is sent every 15 seconds.', operationId: 'streamEvents', security: [{ bearerAuth: [] }], querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0 }, job_id: { type: 'string', format: 'uuid' } } }, response: { 200: { description: 'Server-Sent Events stream', content: { 'text/event-stream': { schema: { type: 'string', examples: ['id: 12\nevent: role_started\ndata: {"event_id":12,"type":"role_started"}\n\n'] } } } } } } }, async (request, reply) => {
    const query = request.query as { after?: number; job_id?: string };
    const header = request.headers['last-event-id'];
    const headerCursor = typeof header === 'string' && /^[0-9]{1,15}$/.test(header) ? Number(header) : undefined;
    let cursor = query.after ?? headerCursor ?? 0;
    const jobId = query.job_id;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    raw.write('retry: 3000\n: connected\n\n');
    let ended = false; let replaying = true;
    const buffer: JobEvent[] = [];
    let unsubscribe: (() => void) | undefined; let heartbeat: NodeJS.Timeout | undefined;
    const end = (): void => {
      if (ended) return; ended = true; streams.delete(end);
      if (heartbeat) clearInterval(heartbeat);
      try { unsubscribe?.(); } catch { /* listener removal must not throw to the server */ }
      if (!raw.writableEnded) raw.end();
    };
    const send = (event: JobEvent): void => {
      if (ended || event.event_id <= cursor) return;
      cursor = event.event_id;
      const safe = safeEvent(event);
      raw.write(`id: ${safe.event_id}\nevent: ${safe.type}\ndata: ${JSON.stringify(safe)}\n\n`);
    };
    streams.add(end);
    raw.on('close', end);
    heartbeat = setInterval(() => { if (!ended) raw.write(': heartbeat\n\n'); }, heartbeatMs); heartbeat.unref();
    // Subscribe first so nothing persisted during replay is lost; the buffer is deduplicated by event_id.
    unsubscribe = options.workflow.subscribe((event) => {
      if (jobId && event.job_id !== jobId) return;
      if (replaying) buffer.push(event); else send(event);
    });
    if (ended) { unsubscribe(); return reply; }
    try {
      for (;;) {
        const page = await options.workflow.events({ ...(jobId ? { job_id: jobId } : {}), after: cursor, limit: 500 });
        for (const event of page) send(event);
        if (page.length < 500 || ended) break;
      }
      buffer.sort((a, b) => a.event_id - b.event_id);
      for (const event of buffer) send(event);
      buffer.length = 0; replaying = false;
    } catch { end(); }
    return reply;
  });
  return app;
}

/** Return the code-first OpenAPI document used by `autos docs validate`. */
export async function generateOpenApi(options: ControllerOptions): Promise<Record<string, unknown>> {
  const app = await createController({ ...options, close: async () => undefined });
  try {
    await app.ready();
    return app.swagger() as Record<string, unknown>;
  } finally { await app.close(); }
}

/** Serve a schema-only local reference, with all write/playground controls disabled. */
export async function createDocsPreview(options: ControllerOptions): Promise<FastifyInstance> {
  const document = await generateOpenApi(options);
  const app = Fastify({ logger: false });
  await app.register(swagger, { mode: 'static', specification: { document: document as never } });
  await app.register(swaggerUi, { routePrefix: '/', validatorUrl: false, uiConfig: { supportedSubmitMethods: [], deepLinking: false }, staticCSP: true });
  return app;
}

export async function startController(options: ControllerOptions): Promise<FastifyInstance> {
  const app = await createController(options);
  await app.listen({ host: options.bindHost ?? options.config.api.listen_host, port: options.config.api.port });
  return app;
}

export async function createRuntime(options: import('./runtime.js').RuntimeOptions = {}): Promise<ControllerServices> {
  const runtime = await import('./runtime.js');
  return runtime.createRuntime(options);
}
