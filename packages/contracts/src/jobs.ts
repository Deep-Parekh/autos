import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import { effortSchema } from './config.js';
import { branchNameSchema, gitShaSchema, issueKeySchema, jobIdSchema, jobStateSchema, providerSchema, roleSchema, timestampSchema } from './domain.js';

export const jobRecordSchema = z.strictObject({
  job_id: jobIdSchema,
  issue_key: issueKeySchema,
  repository_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/).nullable(),
  base_sha: gitShaSchema.nullable(),
  state: jobStateSchema,
  dry_run: z.boolean(),
  repair_round: z.number().int().min(0).max(2),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  blocked_code: z.enum(ERROR_CODES).optional(),
  blocked_reason: z.string().max(500).optional(),
  feature_branch: branchNameSchema.optional(),
  commit_sha: gitShaSchema.optional(),
  base_branch: branchNameSchema.optional(),
  /** Set on revision jobs: the READY_FOR_HUMAN job whose commit this attempt continues. */
  parent_job_id: jobIdSchema.optional(),
  /** 0 for an initial attempt, n for the n-th human-requested revision of the same issue. */
  revision: z.number().int().min(0).max(20).optional(),
  /**
   * BLOCKED attempts only: the commit that preserves the attempt's unreviewed work on the feature branch (it never passed
   * QA and review). An explicit retry continues from it instead of starting over from the base.
   */
  wip_commit_sha: gitShaSchema.optional(),
  /** Whether that unreviewed commit was pushed (bitbucket.push_blocked_attempts). */
  wip_push_status: z.enum(['PUSHED', 'FAILED', 'DISABLED']).optional(),
  /** Set on a retry that continues an earlier blocked attempt's unreviewed work (that attempt's job id). */
  continues_job_id: jobIdSchema.optional(),
  /** Issue-level: set on every attempt of an issue the operator closed (`autos close`). Closed issues accept no new attempts. */
  closed_as: z.enum(['MERGED', 'ABANDONED']).optional(),
  /** PAUSED only: when the attempt becomes due to resume (provider limit reset or backoff). */
  resume_at: timestampSchema.optional(),
  /** PAUSED only: RATE_LIMIT for a limited provider chain, or the infrastructure code (e.g. UPSTREAM) when a resuming attempt failed before any agent ran. */
  pause_code: z.enum(ERROR_CODES).optional(),
  /** PAUSED only: the role whose whole provider chain was limited; it reruns from its primary provider on resume. */
  paused_role: roleSchema.optional(),
  /** PAUSED only: start of the current pause streak; the attempt blocks after jobs.rate_limit_pause.max_total_hours from here. */
  paused_since: timestampSchema.optional(),
  /** PAUSED only: pauses in the current streak (1 = first pause); drives the backoff when no reset time is known. */
  pause_count: z.number().int().min(1).max(1000).optional(),
});

/**
 * Progress events. Persisted by the workflow (SQLite) so any process (controller, `autos status`) sees the same
 * history. Events carry sanitized metadata only: never prompts, transcripts, diffs, tokens, URLs or filesystem paths.
 */
export const JOB_EVENT_TYPES = [
  'job_queued', 'job_started', 'state_changed', 'stage_started', 'stage_finished',
  'role_started', 'role_finished', 'checks_started', 'checks_finished',
  'repair_round_started', 'commit_created', 'push_finished', 'job_finished',
  'poll_started', 'poll_finished', 'poll_failed', 'recovered', 'revision_requested', 'provider_fallback',
  'issue_closed', 'workspaces_pruned', 'job_paused', 'job_resumed', 'provider_gate_opened', 'provider_gate_closed',
  'tier_selected', 'tier_escalated',
] as const;
export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);
export const WORKFLOW_STAGES = ['intake', 'routing', 'baseline', 'implementation', 'checks', 'qa', 'review', 'repair', 'finalize', 'push'] as const;
export const workflowStageSchema = z.enum(WORKFLOW_STAGES);

export const jobEventSchema = z.strictObject({
  /** Monotonic cursor; use as `after` / SSE Last-Event-ID. */
  event_id: z.number().int().positive(),
  at: timestampSchema,
  type: jobEventTypeSchema,
  /** Null for service-level events (polling). */
  job_id: jobIdSchema.nullable(),
  issue_key: issueKeySchema.nullable(),
  state: jobStateSchema.optional(),
  stage: workflowStageSchema.optional(),
  role: roleSchema.optional(),
  provider: providerSchema.optional(),
  /** provider_fallback only: the provider that failed (`provider` is the one being tried next). */
  from_provider: providerSchema.optional(),
  repair_round: z.number().int().min(0).max(2).optional(),
  /** Short outcome such as PASS, FAIL, SUCCEEDED, TIMED_OUT, PUSHED, DISABLED. */
  outcome: z.string().regex(/^[A-Z_]{1,40}$/).optional(),
  code: z.enum(ERROR_CODES).optional(),
  elapsed_ms: z.number().int().min(0).optional(),
  /** Counts for poll events (discovered keys, newly queued jobs). */
  count: z.number().int().min(0).optional(),
  /** Human-readable, sanitized, at most 300 characters. */
  message: z.string().max(300).optional(),
  /** job_paused: when the attempt is due to resume; provider_gate_opened: when the gate lifts at the latest. */
  resume_at: timestampSchema.optional(),
  /** Model tier (`tier` or `tier:effort` step label) of a ladder role call, tier_selected or tier_escalated event. */
  tier: z.string().max(60).regex(/^[a-z0-9][a-z0-9_:-]*$/).optional(),
  /** Model passed to the CLI for this call, when one was configured. */
  model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/).optional(),
  /** Reasoning effort passed to the CLI for this call (absent = CLI default). */
  effort: effortSchema.optional(),
});
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventType = z.infer<typeof jobEventTypeSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type NewJobEvent = Omit<JobEvent, 'event_id' | 'at'>;

export const activeJobSchema = z.strictObject({
    job_id: jobIdSchema, issue_key: issueKeySchema, state: jobStateSchema, dry_run: z.boolean(),
    repair_round: z.number().int().min(0).max(2),
    stage: workflowStageSchema.nullable(), stage_started_at: timestampSchema.nullable(),
    role: roleSchema.nullable(), provider: providerSchema.nullable(),
    started_at: timestampSchema,
  });
export type ActiveJob = z.infer<typeof activeJobSchema>;

/** A PAUSED attempt: holds no slot; resumes at resume_at (see jobs.rate_limit_pause). */
export const pausedJobSchema = z.strictObject({
  job_id: jobIdSchema, issue_key: issueKeySchema, repair_round: z.number().int().min(0).max(2),
  role: roleSchema.nullable(), code: z.enum(ERROR_CODES).nullable(),
  resume_at: timestampSchema.nullable(), paused_since: timestampSchema.nullable(), pause_count: z.number().int().min(0),
});
export type PausedJob = z.infer<typeof pausedJobSchema>;

export const workflowActivitySchema = z.strictObject({
  /** First active job (kept for compatibility when max_parallel is 1); see active_jobs. */
  active: activeJobSchema.nullable(),
  /** All jobs currently holding a slot, oldest first (length <= jobs.max_parallel). */
  active_jobs: z.array(activeJobSchema),
  /** PAUSED attempts (no slot), earliest resume first. */
  paused_jobs: z.array(pausedJobSchema),
  /**
   * Known provider limits (recorded when a whole role chain was limited) and the new-ticket gate: while every provider of
   * the SWE chain is limited, no new QUEUED (non-dry-run) ticket starts; due PAUSED attempts still resume.
   */
  provider_limits: z.strictObject({
    providers: z.array(z.strictObject({ provider: providerSchema, until: timestampSchema })),
    gate_active: z.boolean(),
    /** Earliest time a SWE-chain provider's limit expires (when the gate lifts at the latest); null when inactive. */
    gate_until: timestampSchema.nullable(),
  }),
  /** Configured slot limits. */
  slots: z.strictObject({ max_parallel: z.number().int().min(1), in_use: z.number().int().min(0), max_concurrent_checks: z.number().int().min(1), checks_in_use: z.number().int().min(0) }),
  polling: z.strictObject({
    in_progress: z.boolean(),
    last_started_at: timestampSchema.nullable(),
    last_finished_at: timestampSchema.nullable(),
    last_outcome: z.enum(['OK', 'FAILED']).nullable(),
    last_error_code: z.enum(ERROR_CODES).nullable(),
    last_discovered: z.number().int().min(0).nullable(),
  }),
  /** Job counts by state across stored history. */
  counts: z.partialRecord(jobStateSchema, z.number().int().min(0)),
  last_event_id: z.number().int().min(0),
});
export type WorkflowActivity = z.infer<typeof workflowActivitySchema>;

/**
 * Operator guidance added through the authenticated API/CLI (trusted, unlike ticket text). It is delivered to the
 * selected roles as requirements, but it can never relax platform policy (allowed paths, read-only Atlassian,
 * no force-push/merge/deploy). Stored as evidence; never copied into events.
 */
export const OPERATOR_NOTE_ROLES = ['swe', 'qa', 'reviewer'] as const;
export const operatorNoteRequestSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(4000),
  /** Roles that receive the note. Default ['swe']; QA/reviewer also always see SWE notes as acceptance requirements. */
  roles: z.array(roleSchema).min(1).max(3).default(['swe']),
});
export type OperatorNoteRequest = z.input<typeof operatorNoteRequestSchema>;
export const operatorNoteSchema = z.strictObject({
  instructions: z.string().min(1).max(4000),
  roles: z.array(roleSchema).min(1).max(3),
  /** Who added it, from the operator identity (e.g. 'operator' or a configured name); not free-form. */
  author: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/),
  created_at: timestampSchema,
  /** 'ticket' when copied from the issue's ticket notes at attempt creation; absent/'operator' for per-attempt notes. */
  source: z.enum(['operator', 'ticket']).optional(),
});
export type OperatorNote = z.infer<typeof operatorNoteSchema>;

/**
 * Failures after which a role may move to its next configured provider. Anything else (CANCELLED, POLICY, TOOL,
 * INTERNAL, ...) stops the chain. For SWE after workspace edits, only HANDOFF_ERROR_CODES continue (with a
 * handoff); other eligible codes after edits block rather than letting a second provider build on unexplained edits.
 */
export const FALLBACK_ERROR_CODES = ['AUTH', 'RATE_LIMIT', 'UPSTREAM', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_OUTPUT', 'CONTEXT'] as const;
/**
 * Limit-type failures. When an SWE attempt fails with one of these after editing the workspace, the next attempt
 * (same-provider retry or the next provider in the chain) continues the partial work with a handoff instead of the
 * job blocking. Every provider in the chain is tried before the role gives up. The final candidate is still fully
 * gated by checks, QA and review.
 */
export const HANDOFF_ERROR_CODES = ['RATE_LIMIT', 'CONTEXT', 'TIMEOUT', 'UPSTREAM'] as const;
/**
 * Provider-capacity failures. When every provider of a role's chain fails with one of these (at least one RATE_LIMIT
 * and the rest RATE_LIMIT or UPSTREAM), the attempt is PAUSED instead of BLOCKED and resumes later in the same
 * workspace. UPSTREAM alone (vendor outage without any limit signal) still blocks: it is not capacity and resuming
 * blindly could loop. UNAVAILABLE (missing CLI or broken runner image), AUTH, TIMEOUT and CONTEXT never pause.
 */
export const PAUSE_ERROR_CODES = ['RATE_LIMIT', 'UPSTREAM'] as const;

/** One provider attempt for a role invocation, recorded in evidence (rounds.json) — no transcript content. */
export const providerAttemptSchema = z.strictObject({
  role: roleSchema,
  provider: providerSchema,
  model: z.string().max(200).nullable(),
  /** Position in the role's chain: 0 = primary. */
  chain_index: z.number().int().min(0).max(2),
  status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  error_code: z.enum(ERROR_CODES).nullable(),
  elapsed_ms: z.number().int().min(0),
  /** Whether the workflow moved on to the next provider after this attempt. */
  fell_back: z.boolean(),
  /** SWE only: whether this attempt started from a predecessor's partial work with a handoff (progress + diff). */
  continued_from_handoff: z.boolean().optional(),
  /** SWE only: whether the attempt left a progress checklist for a successor. */
  handoff_captured: z.boolean().optional(),
  /** Ladder roles: tier name and reasoning effort of this attempt (null effort = CLI default); absent for plain chains. */
  tier: z.string().max(40).nullable().optional(),
  effort: effortSchema.nullable().optional(),
});
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;

/**
 * Internal resume point of a PAUSED attempt (stored by the workflow in its private SQLite database; never returned by
 * the API or put in events). Prompts and the predecessor checklist are private evidence like the per-invocation
 * prompt files. Validated again when read back.
 */
export const PAUSE_PHASES = ['implementation', 'policy_repair', 'repair', 'qa', 'review'] as const;
export const pauseCheckpointSchema = z.strictObject({
  schema_version: z.literal(1),
  phase: z.enum(PAUSE_PHASES),
  role: roleSchema,
  /** Last provider of the limited chain (named in the resumed SWE's handoff). */
  provider: providerSchema,
  code: z.enum(ERROR_CODES),
  repair_round: z.number().int().min(0).max(2),
  /** Issue content hash at the attempt's intake; a resumed attempt blocks when the ticket changed meanwhile. */
  intake_hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Trusted-Git seal of the workspace at pause time (GitRunnerPort.sealWorkspace); null when the runner has none. */
  workspace_seal: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  /** SWE phases: the exact role prompt the chain was running (the resumed SWE gets it again plus a handoff). */
  swe_prompt: z.string().max(1_100_000).nullable(),
  /** SWE phases: digest the interrupted SWE started from, and its latest progress checklist (agent-written, untrusted). */
  swe_start_digest: z.string().max(128).nullable(),
  checklist: z.string().max(64 * 1024).nullable(),
  /** SWE phases: what the interrupted SWE did last (trusted transcript summary of agent-produced targets). */
  recent_actions: z.array(z.strictObject({ tool: z.string().max(64), target: z.string().max(400) })).max(50),
  /** rounds.json content so far and the provider attempts of the round in progress. */
  rounds: z.array(z.record(z.string(), z.unknown())).max(20),
  swe_attempts: z.array(providerAttemptSchema).max(200),
  /** Repair SWE phases: the evidence the repair prompt was built from (for de-duplicated handoff context). */
  repair_evidence: z.strictObject({ checks: z.unknown(), qa: z.unknown(), review: z.unknown() }).nullable(),
});
export type PauseCheckpoint = z.infer<typeof pauseCheckpointSchema>;

/**
 * Issue closure (operator, after manual review). MERGED: the operator merged the latest READY_FOR_HUMAN commit.
 * ABANDONED: the work will not be used. Either way all of the issue's workspaces are removed, artifacts (evidence)
 * are kept, and the issue accepts no new attempt, revision or retry. Closing is irreversible.
 */
export const ISSUE_RESOLUTIONS = ['MERGED', 'ABANDONED'] as const;
export const issueResolutionSchema = z.enum(ISSUE_RESOLUTIONS);
export type IssueResolution = z.infer<typeof issueResolutionSchema>;

export const closeIssueRequestSchema = z.strictObject({
  resolution: issueResolutionSchema,
  /** Optional operator note kept in evidence (closure.json), never in events or logs. */
  note: z.string().trim().min(1).max(2000).optional(),
  /** Report what would be removed without changing anything. */
  dry_run: z.boolean().default(false),
});
export type CloseIssueRequest = z.input<typeof closeIssueRequestSchema>;

export const issueClosureSchema = z.strictObject({
  issue_key: issueKeySchema,
  resolution: issueResolutionSchema,
  closed_at: timestampSchema,
  closed_by: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/),
  /** Latest non-dry-run READY_FOR_HUMAN attempt at close time (required for MERGED), else null. */
  job_id: jobIdSchema.nullable(),
  commit_sha: gitShaSchema.nullable(),
  feature_branch: branchNameSchema.nullable(),
});
export type IssueClosure = z.infer<typeof issueClosureSchema>;

/** Canonical workspace directory name created by trusted Git: `<job uuid>-<random uuid>`. */
export const WORKSPACE_DIR_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Why a workspace is removable now (null = retained). */
export const WORKSPACE_REMOVAL_REASONS = ['closed', 'superseded', 'retention', 'orphan'] as const;
/** Why a workspace is kept. */
/** awaiting_retry: the issue's latest attempt is BLOCKED with preserved unreviewed work that a retry continues from. */
export const WORKSPACE_RETENTION_REASONS = ['active', 'awaiting_review', 'awaiting_retry', 'within_retention'] as const;

export const workspaceEntrySchema = z.strictObject({
  /** Directory basename under storage.workspaces_dir (never a full path). */
  name: z.string().regex(WORKSPACE_DIR_NAME_PATTERN),
  job_id: jobIdSchema,
  /** Null for an orphan directory with no matching job. */
  issue_key: issueKeySchema.nullable(),
  state: jobStateSchema.nullable(),
  closed_as: issueResolutionSchema.nullable(),
  modified_at: timestampSchema,
  /** Only when sizes were requested (walks the tree), else null. */
  size_bytes: z.number().int().min(0).nullable(),
  removable: z.enum(WORKSPACE_REMOVAL_REASONS).nullable(),
  retained_because: z.enum(WORKSPACE_RETENTION_REASONS).nullable(),
});
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const workspaceRemovalFailureSchema = z.strictObject({
  name: z.string().regex(WORKSPACE_DIR_NAME_PATTERN),
  job_id: jobIdSchema,
  code: z.enum(ERROR_CODES),
});

export const pruneWorkspacesRequestSchema = z.strictObject({
  dry_run: z.boolean().default(false),
  /** Overrides jobs.workspace_retention_hours for this run (closed issues are always removable). */
  older_than_hours: z.number().int().min(0).max(2160).optional(),
  sizes: z.boolean().default(false),
});
export type PruneWorkspacesRequest = z.input<typeof pruneWorkspacesRequestSchema>;

export const pruneWorkspacesResultSchema = z.strictObject({
  dry_run: z.boolean(),
  /** Removed entries (on a dry run: entries that would be removed). */
  removed: z.array(workspaceEntrySchema),
  failed: z.array(workspaceRemovalFailureSchema),
  /** Sum of size_bytes of removed entries when sizes were requested, else null. */
  freed_bytes: z.number().int().min(0).nullable(),
  /** Workspace directories still present after this run (on a dry run: that would remain). */
  remaining: z.number().int().min(0),
});
export type PruneWorkspacesResult = z.infer<typeof pruneWorkspacesResultSchema>;

export const closeIssueResultSchema = z.strictObject({
  dry_run: z.boolean(),
  closure: issueClosureSchema,
  /** Workspaces of this issue removed (on a dry run: that would be removed). */
  removed: z.array(workspaceEntrySchema),
  failed: z.array(workspaceRemovalFailureSchema),
});
export type CloseIssueResult = z.infer<typeof closeIssueResultSchema>;

/**
 * Ticket notes: operator guidance keyed only by issue key, added before or after Autos has seen the issue. They are
 * copied (as operator notes with source 'ticket') into every new attempt of that issue — discovered, submitted, retried
 * or revised — until removed or the issue is closed. A hold stops automatic discovery from queueing the issue
 * (explicit `autos run` still works) until released.
 */
export const MAX_TICKET_NOTES = 5;
export const ticketNoteSchema = z.strictObject({
  note_id: z.string().uuid(),
  issue_key: issueKeySchema,
  instructions: z.string().min(1).max(4000),
  roles: z.array(roleSchema).min(1).max(3),
  author: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/),
  created_at: timestampSchema,
});
export type TicketNote = z.infer<typeof ticketNoteSchema>;

/** Where Autos is with an issue that has ticket notes or a hold. */
export const TICKET_WORK_STATUSES = ['not_seen', 'held', 'queued', 'in_progress', 'planned', 'awaiting_review', 'blocked', 'cancelled', 'closed_merged', 'closed_abandoned'] as const;
export const ticketWorkStatusSchema = z.enum(TICKET_WORK_STATUSES);

export const ticketNotesSummarySchema = z.strictObject({
  issue_key: issueKeySchema,
  notes: z.array(ticketNoteSchema),
  held: z.boolean(),
  /** not_seen: no attempt yet (held when also on hold); otherwise derived from the latest non-dry-run attempt (dry-run if only dry runs). */
  status: ticketWorkStatusSchema,
  /** Non-dry-run attempts so far. */
  attempts: z.number().int().min(0),
  dry_runs: z.number().int().min(0),
  latest_job_id: jobIdSchema.nullable(),
  latest_state: jobStateSchema.nullable(),
  last_activity_at: timestampSchema.nullable(),
  /** Attempts (any mode) that received every current ticket note; 0 means the current notes have not been used yet. */
  attempts_with_current_notes: z.number().int().min(0),
  /** Operator model-tier pins for this issue (applied at pickup of every later attempt until cleared). */
  tier_pins: z.array(z.lazy(() => tierPinSchema)).max(3).default([]),
});
export type TicketNotesSummary = z.infer<typeof ticketNotesSummarySchema>;

/**
 * Model-tier pins: an operator's choice of a role's starting tier (optionally with an effort override for its claude/codex
 * entries) for an issue key, stored before or after Autos has seen the issue and applied when an attempt is picked up. A
 * pin wins over triage and over the previous attempt's tier, but never goes below the role's floor (`min`). A tier of the
 * role's ladder starts at its position (an override replaces it in place); another tier is a fixed step without
 * escalation, refused for a role with a floor (not comparable).
 */
export const tierPinRequestSchema = z.strictObject({
  role: roleSchema.default('swe'),
  tier: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  effort: effortSchema.optional(),
});
export type TierPinRequest = z.input<typeof tierPinRequestSchema>;
export const tierPinSchema = z.strictObject({
  issue_key: issueKeySchema,
  role: roleSchema,
  tier: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  /** Null: the lowest ladder step of this tier, else the CLI default effort. */
  effort: effortSchema.nullable(),
  author: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/),
  created_at: timestampSchema,
});
export type TierPin = z.infer<typeof tierPinSchema>;
export const tierPinResultSchema = z.strictObject({
  pin: tierPinSchema,
  /** The step the pin resolves to under the current configuration (`tier:effort`, or `tier` for the CLI default). */
  step: z.string().max(60),
  /** Whether the tier is in the role's ladder (an effort override replaces it in place); false: a fixed step without escalation. */
  in_ladder: z.boolean(),
});
export type TierPinResult = z.infer<typeof tierPinResultSchema>;
/** Where a ladder role's first step came from. */
export const TIER_START_SOURCES = ['attempt_pin', 'ticket_pin', 'previous', 'triage', 'lowest'] as const;
