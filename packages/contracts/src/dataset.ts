import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import { branchNameSchema, gitShaSchema, issueKeySchema, jobIdSchema, jobStateSchema, providerSchema, roleSchema, timestampSchema } from './domain.js';
import { FALLBACK_ERROR_CODES } from './jobs.js';
import { effortSchema } from './config.js';

/**
 * Per provider invocation metadata written by the workflow next to the private prompt/transcript
 * (`artifacts/<jobId>/_private/<role>/<invocationId>/call.json`). No prompt text, transcript text or secrets.
 */
export const providerCallSchema = z.strictObject({
  schema_version: z.literal(1),
  invocation_id: z.string().uuid(),
  job_id: jobIdSchema,
  role: roleSchema,
  provider: providerSchema,
  model: z.string().max(200).nullable(),
  /** Position in the role's provider chain (0 = primary). */
  chain_index: z.number().int().min(0).max(2),
  repair_round: z.number().int().min(0).max(2),
  started_at: timestampSchema,
  elapsed_ms: z.number().int().min(0),
  status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  error_code: z.enum(ERROR_CODES).nullable(),
  /** SWE: this call continued a predecessor's partial work (handoff). */
  continued_from_handoff: z.boolean(),
  /** Ladder roles and triage: model tier name, and the reasoning effort passed to the CLI (null = CLI default). */
  tier: z.string().max(40).nullable().optional(),
  effort: effortSchema.nullable().optional(),
  /** 'triage' for the start-step triage call (runs in the read-only QA profile); absent for role calls. */
  purpose: z.enum(['role', 'triage']).optional(),
});
export type ProviderCall = z.infer<typeof providerCallSchema>;


export const DATASET_OUTCOMES = ['merged', 'abandoned', 'revised', 'awaiting_review', 'blocked', 'cancelled'] as const;
export const datasetOutcomeSchema = z.enum(DATASET_OUTCOMES);

const datasetNoteSchema = z.strictObject({ instructions: z.string(), roles: z.array(roleSchema), author: z.string(), created_at: timestampSchema, source: z.enum(['operator', 'ticket']).optional() });

/**
 * One JSONL line of `autos export dataset`: one non-dry-run attempt (job) with everything needed to study or replay it.
 * Contains company source code and ticket text; treat the file like the artifacts directory.
 */
export const datasetRecordSchema = z.strictObject({
  schema_version: z.literal(1),
  exported_at: timestampSchema,
  job_id: jobIdSchema,
  issue_key: issueKeySchema,
  revision: z.number().int().min(0),
  parent_job_id: jobIdSchema.nullable(),
  repository_id: z.string().nullable(),
  base_branch: branchNameSchema.nullable(),
  base_sha: gitShaSchema.nullable(),
  commit_sha: gitShaSchema.nullable(),
  feature_branch: branchNameSchema.nullable(),
  final_state: jobStateSchema,
  blocked_code: z.enum(ERROR_CODES).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  /**
   * Human outcome of this attempt: merged/abandoned (issue closure of the attempt that was latest at close), revised
   * (a later revision asked for more work; see feedback), awaiting_review, blocked, cancelled.
   */
  outcome: datasetOutcomeSchema,
  /** Operator notes on the revision(s) that followed this attempt: the human review feedback on it. */
  feedback: z.array(datasetNoteSchema),
  /** Operator notes given to this attempt. */
  operator_notes: z.array(datasetNoteSchema),
  /** Parsed artifacts (null when absent): issue.json, rounds.json, checks.json, baseline-checks.json, qa.json, review.json. */
  issue: z.unknown().nullable(),
  rounds: z.unknown().nullable(),
  checks: z.unknown().nullable(),
  baseline_checks: z.unknown().nullable(),
  qa: z.unknown().nullable(),
  review: z.unknown().nullable(),
  /** tiers.json: per-role ladder, start step and source (pin, triage, previous attempt, lowest), escalations and the triage call. */
  tiers: z.unknown().nullable().default(null),
  /** effective-instructions.md and precedents.md text. */
  instructions: z.string().nullable(),
  precedents: z.string().nullable(),
  /** Semantic precedents shown to agents for this attempt (precedents.json); absent for legacy lookups and older exports. */
  precedent_keys: z.array(issueKeySchema).nullable().optional(),
  precedent_kinds: z.array(z.string()).nullable().optional(),
  /** Final cumulative diff vs base (changes.patch). */
  final_diff: z.string().nullable(),
  /** Every provider invocation in start order, with prompt and transcript text unless excluded. */
  calls: z.array(z.strictObject({
    call: providerCallSchema.nullable(),
    /** Role and invocation id from the private directory (call.json is absent for attempts made before it existed). */
    role: roleSchema,
    invocation_id: z.string(),
    prompt: z.string().nullable(),
    /** Provider output as recorded (JSON lines for stream formats), secrets already redacted at capture. */
    transcript: z.string().nullable(),
    transcript_truncated: z.boolean(),
  })),
  /** Sanitized progress events for this job, oldest first. */
  timeline: z.array(z.strictObject({ at: timestampSchema, type: z.string(), stage: z.string().nullable(), role: z.string().nullable(), provider: z.string().nullable(), outcome: z.string().nullable(), code: z.string().nullable() })),
});
export type DatasetRecord = z.infer<typeof datasetRecordSchema>;

export const datasetExportOptionsSchema = z.strictObject({
  /** Only attempts updated at or after this time. */
  since: timestampSchema.optional(),
  issue_key: issueKeySchema.optional(),
  outcomes: z.array(datasetOutcomeSchema).min(1).optional(),
  include_transcripts: z.boolean().default(true),
  include_prompts: z.boolean().default(true),
});
export type DatasetExportOptions = z.input<typeof datasetExportOptionsSchema>;
