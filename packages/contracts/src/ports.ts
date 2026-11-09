import type { AutosConfig, CheckCommand, RepositoryConfig } from './config.js';
import type { AgentRole, IssueSnapshot, JobState, PrecedentResult, ProjectMapping, Provider, SavedFilter } from './domain.js';
import type { AutosError, ErrorCode } from './errors.js';
import type { ArtifactManifest, Checks } from './evidence.js';
import type { ProviderAuthSummary } from './execution.js';
import type { ProviderCall } from './dataset.js';
import type { CloseIssueRequest, CloseIssueResult, IssueClosure, IssueResolution, JobEvent, OperatorNoteRequest, PruneWorkspacesRequest, PruneWorkspacesResult, TicketNote, TicketNotesSummary, WorkflowActivity, WorkspaceEntry } from './jobs.js';

export interface AtlassianReadPort {
  getSavedFilter(filterId: string, signal?: AbortSignal): Promise<SavedFilter>;
  /** Discover keys before hydration so one rejected issue cannot hide the rest of the queue. */
  listIssueKeys(jql: string, signal?: AbortSignal): Promise<string[]>;
  listIssues(jql: string, signal?: AbortSignal): Promise<IssueSnapshot[]>;
  getIssue(issueKey: string, signal?: AbortSignal): Promise<IssueSnapshot>;
  getBranchMap(pageId: string, signal?: AbortSignal): Promise<ProjectMapping[]>;
}
export interface PrecedentReadPort {
  findPrecedents(issue: IssueSnapshot, mapping: ProjectMapping, signal?: AbortSignal): Promise<PrecedentResult>;
}
export interface GitWorkspace {
  job_id: string; issue_key: string; repository: RepositoryConfig;
  directory: string; base_sha: string; development_branch: string; feature_branch: string;
  /** Commit the candidate builds on: base_sha for an initial attempt, the parent commit for a revision. */
  start_sha?: string;
}
/**
 * Continue a human-reviewed attempt: the new workspace starts at the parent's local commit (fetched by trusted Git
 * from the parent workspace under the same workspaces root), on the same feature branch and pinned base.
 */
export interface GitContinuation {
  parent_job_id: string;
  /** Parent job's workspace directory (must be inside workspaces_root). */
  parent_directory: string;
  /** The parent's committed feature-branch head that the human reviewed. */
  parent_commit_sha: string;
  /** The parent's pinned development base; the parent commit must descend from it. */
  base_sha: string;
  development_branch: string;
}
export interface GitPrepareRequest {
  job_id: string; issue_key: string; repository: RepositoryConfig;
  mapping: ProjectMapping; workspaces_root: string;
  continue_from?: GitContinuation;
}
export interface GitCandidate {
  /** Cumulative identity/diff relative to base_sha (what is ultimately handed off). */
  digest: string; paths: string[]; diff: string;
  /** For revisions: the change since start_sha (what this attempt added). Absent when start_sha === base_sha. */
  incremental?: { paths: string[]; diff: string };
}
export interface GitCommitRequest {
  workspace: GitWorkspace; candidate_digest: string; approved_paths: string[];
  message: string; author: { name: string; email: string };
}
export interface GitCommitResult { commit_sha: string; candidate_digest: string; paths: string[] }
/**
 * Push is create-only for an initial attempt. For a revision it may fast-forward the remote feature branch only
 * when the remote still points at start_sha (exact lease); any other remote value is BRANCH_COLLISION. Never force.
 */
export interface GitPushResult { status: 'PUSHED' | 'FAILED' | 'DISABLED'; commit_sha: string; error_code?: ErrorCode }
/** A repository instruction file read by trusted Git from a commit (never from the mutable working tree). */
export interface RepositoryInstructionFile {
  /** Repository-relative path, e.g. AGENTS.md, services/api/AGENTS.md, .cursor/rules/style.mdc */
  path: string;
  /** Git blob id of the file at that commit. */
  blob_sha: string;
  /** UTF-8 content, bounded by the runner (64 KiB per file, 512 KiB total). */
  content: string;
}
export interface GitRunnerPort {
  resolveBase(repository: RepositoryConfig, mapping: ProjectMapping, signal?: AbortSignal): Promise<{ base_sha: string; development_branch: string }>;
  prepare(request: GitPrepareRequest, signal?: AbortSignal): Promise<GitWorkspace>;
  inspectCandidate(workspace: GitWorkspace, signal?: AbortSignal): Promise<GitCandidate>;
  commit(request: GitCommitRequest, signal?: AbortSignal): Promise<GitCommitResult>;
  push(workspace: GitWorkspace, commitSha: string, signal?: AbortSignal): Promise<GitPushResult>;
  /**
   * Instruction files (see INSTRUCTION_FILE_PATTERNS) present in the tree of `commitSha` (normally the workspace's
   * start_sha: the checked-out branch head). Read with trusted Git object access, so agents cannot alter them.
   */
  readInstructionFiles(workspace: GitWorkspace, commitSha: string, signal?: AbortSignal): Promise<RepositoryInstructionFile[]>;
  /**
   * Read and remove the reserved SWE handoff file (HANDOFF_FILE) from the working tree, returning its bounded
   * content or null. Trusted code; refuses symlinks/non-regular files. Always leaves HANDOFF_DIR absent.
   */
  takeHandoff(workspace: GitWorkspace, signal?: AbortSignal): Promise<string | null>;
}
export interface ProviderRequest {
  job_id: string; issue_key: string; provider: Provider; role: AgentRole;
  model?: string; cwd: string; prompt_path: string; transcript_path: string;
  timeout_ms: number; source_access: 'read' | 'write'; auth_profile: string;
}
export interface ProviderResult {
  provider: Provider; role: AgentRole; status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  exit_code: number | null; elapsed_ms: number; transcript_path: string;
  result: unknown; error_code?: ErrorCode; model?: string;
}
/** Executes within an already established boundary; not a host sandbox. */
export interface ProviderAdapterPort { run(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult> }
export interface RunnerPort {
  runRole(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
  runChecks(workspace: GitWorkspace, candidateDigest: string, commands: CheckCommand[], signal?: AbortSignal): Promise<Checks>;
  stop(jobId: string): Promise<void>;
  /** Optional readiness of the isolation boundary (supervisor + Docker). Must not start a container. */
  health?(): Promise<RunnerHealth>;
}
export interface RunnerHealth {
  status: 'ready'; version: 1; docker: 'available' | 'unavailable' | 'test-only';
  /** Configured profile modes (no secrets); absent from older supervisors. */
  auth?: ProviderAuthSummary[];
  /** True when the supervisor refuses every profile that is not mode=subscription (AUTOS_REQUIRE_SUBSCRIPTION). */
  require_subscription?: boolean;
}
export interface JobRecord {
  job_id: string; issue_key: string; repository_id: string | null; base_sha: string | null;
  state: JobState; dry_run: boolean; repair_round: number; created_at: string; updated_at: string;
  blocked_code?: ErrorCode;
  blocked_reason?: string;
  feature_branch?: string;
  commit_sha?: string;
  /** Development branch the base SHA was pinned from. */
  base_branch?: string;
  /** Revision jobs only: the READY_FOR_HUMAN job this attempt continues. */
  parent_job_id?: string;
  /** 0 for an initial attempt, n for the n-th human-requested revision. */
  revision?: number;
  /** Issue-level closure (see issueClosureSchema); closed issues accept no new attempt, revision or retry. */
  closed_as?: IssueResolution;
}
export interface JobStorePort {
  create(job: JobRecord): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;
  list(limit: number, offset?: number): Promise<JobRecord[]>;
  claim(jobId: string, owner: string, leaseUntil: string): Promise<boolean>;
  transition(jobId: string, expected: JobState, next: JobState, patch?: Partial<JobRecord>): Promise<boolean>;
  release(jobId: string, owner: string): Promise<void>;
}
export interface ArtifactStorePort {
  write(jobId: string, name: string, content: string): Promise<void>;
  prepareRole(jobId: string, role: AgentRole, invocationId: string, prompt: string): Promise<{ prompt_path: string; transcript_path: string }>;
  manifest(jobId: string): Promise<ArtifactManifest>;
  /** Optional: private per-invocation metadata for the dataset (call.json); never fails a job. */
  writeCall?(call: ProviderCall): Promise<void>;
}
export interface ClockPort { now(): Date }
export interface WorkflowDependencies {
  config: AutosConfig; atlassian: AtlassianReadPort; precedents: PrecedentReadPort;
  git: GitRunnerPort; runner: RunnerPort; jobs: JobStorePort; artifacts: ArtifactStorePort; clock: ClockPort;
}
export interface WorkflowServicePort {
  /** Optional operator notes apply to this attempt's roles (see operatorNoteRequestSchema). */
  submit(issueKey: string, dryRun: boolean, notes?: OperatorNoteRequest[]): Promise<JobRecord>;
  /**
   * After human review, queue a revision of a READY_FOR_HUMAN job with operator notes. Only the latest
   * READY_FOR_HUMAN attempt of the issue may be revised, and only when no other attempt for it is active.
   */
  revise(jobId: string, note: OperatorNoteRequest, author: string): Promise<JobRecord>;
  /** revise() for the latest READY_FOR_HUMAN attempt of an issue (404 when none, 409 when closed or active). */
  reviseIssue(issueKey: string, note: OperatorNoteRequest, author: string): Promise<JobRecord>;
  /**
   * Operator closure after manual review: records MERGED/ABANDONED, removes every workspace of the issue, keeps
   * artifacts, and refuses later submit/revise/retry for it. Refuses (409) while any attempt of the issue is active;
   * MERGED requires a non-dry-run READY_FOR_HUMAN attempt. Re-closing with the same resolution only retries removal.
   */
  closeIssue(issueKey: string, request: CloseIssueRequest, author: string): Promise<CloseIssueResult>;
  /**
   * Store a ticket note for an issue key (whether or not Autos has seen it). Refused (409) for a closed issue or beyond
   * MAX_TICKET_NOTES; (400) for a project outside jira.allowed_projects. Applies to attempts created after this call.
   */
  addTicketNote(issueKey: string, note: OperatorNoteRequest, author: string): Promise<TicketNote>;
  /** Remove one ticket note (noteId) or all of them; returns how many were removed (404 for an unknown noteId). */
  removeTicketNotes(issueKey: string, noteId?: string): Promise<number>;
  /** Hold (true) or release (false) automatic discovery of an issue. */
  setTicketHold(issueKey: string, held: boolean, author: string): Promise<void>;
  /** Issues with ticket notes or a hold (or exactly one issue, even with neither), with Autos' progress on each. */
  ticketNotes(issueKey?: string): Promise<TicketNotesSummary[]>;
  /** Closure of an issue, or null when open. */
  closure(issueKey: string): Promise<IssueClosure | null>;
  /** Workspace directories on disk with the retention decision for each. */
  workspaces(options?: { sizes?: boolean }): Promise<WorkspaceEntry[]>;
  /** Apply the retention policy now (closed, superseded, expired terminal and orphan workspaces). */
  pruneWorkspaces(request: PruneWorkspacesRequest): Promise<PruneWorkspacesResult>;
  /** Explicitly create a new attempt from a blocked or cancelled job. */
  retry(jobId: string): Promise<JobRecord>;
  /** Execute just this queued job; submit itself never launches a coding session. */
  execute(jobId: string, signal?: AbortSignal): Promise<JobRecord>;
  cancel(jobId: string): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  list(limit: number, offset?: number): Promise<JobRecord[]>;
  /** discover() then drain(). Kept for callers that want one synchronous pass. */
  poll(signal?: AbortSignal): Promise<void>;
  /**
   * Read the filter and queue new eligible keys (bounded by jira.max_new_per_poll); never executes jobs, so intake
   * keeps working while long jobs run. Rejects on filter read failure (never treated as an empty filter).
   */
  discover(signal?: AbortSignal): Promise<{ discovered: number; queued: number }>;
  /** Execute queued jobs with up to jobs.max_parallel workers until none is claimable or ready. Re-entrant-safe. */
  drain(signal?: AbortSignal): Promise<void>;
  /** Persisted progress events, oldest first, strictly after the `after` cursor. */
  events(query: { job_id?: string; after?: number; limit: number }): Promise<JobEvent[]>;
  /** Live in-process notification of newly persisted events; returns an unsubscribe function. */
  subscribe(listener: (event: JobEvent) => void): () => void;
  /** Current activity snapshot derived from persisted jobs and events. */
  activity(): Promise<WorkflowActivity>;
}
export type SafeFailure = Pick<AutosError, 'code' | 'message' | 'retryable'>;
