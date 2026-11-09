import { z } from 'zod';
import { digestSchema, gitShaSchema, issueKeySchema, jobIdSchema, jobStateSchema, relativePathSchema, timestampSchema } from './domain.js';

export const checkRecordSchema = z.strictObject({
  name: z.string().min(1), command: z.array(z.string()).min(1),
  status: z.enum(['PASS', 'FAIL', 'NOT_RUN']), exit_code: z.number().int().nullable(),
  timed_out: z.boolean(), required: z.boolean(), report_paths: z.array(relativePathSchema),
  output_excerpt: z.string().max(12_000).optional(),
}).refine((check) => check.status !== 'PASS' || (check.exit_code === 0 && !check.timed_out), 'Passing checks require a successful process exit');
export const checksSchema = z.strictObject({ schema_version: z.literal(1), candidate_digest: digestSchema, recorded_at: timestampSchema, checks: z.array(checkRecordSchema).min(1) });
export const qaSchema = z.strictObject({ schema_version: z.literal(1), candidate_digest: digestSchema, status: z.enum(['PASS', 'FAIL', 'NOT_RUN']), evidence: z.array(z.string().min(1)).min(1) });
export const reviewFindingSchema = z.strictObject({ severity: z.enum(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']), file: relativePathSchema, line: z.number().int().positive(), issue: z.string().min(1), suggested_fix: z.string().min(1) });
export const reviewSchema = z.strictObject({ schema_version: z.literal(1), candidate_digest: digestSchema, status: z.enum(['PASS', 'FAIL', 'NOT_RUN']), findings: z.array(reviewFindingSchema) })
  .refine((review) => review.status !== 'PASS' || !review.findings.some((finding) => ['BLOCKER', 'HIGH'].includes(finding.severity)), 'Blocking findings cannot pass review');
export type CheckRecord = z.infer<typeof checkRecordSchema>;
export type Checks = z.infer<typeof checksSchema>;
export type QaResult = z.infer<typeof qaSchema>;
export type ReviewResult = z.infer<typeof reviewSchema>;

/** Parse unknown inputs here; callers must not gate a commit on narrative text. */
export function evaluateFinalization(candidateDigest: string, checks: unknown, qa: unknown, review: unknown): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!digestSchema.safeParse(candidateDigest).success) reasons.push('INVALID_CANDIDATE');
  const c = checksSchema.safeParse(checks);
  const q = qaSchema.safeParse(qa);
  const r = reviewSchema.safeParse(review);
  if (!c.success) reasons.push('INVALID_CHECKS');
  else {
    if (c.data.candidate_digest !== candidateDigest) reasons.push('STALE_CHECKS');
    if (!c.data.checks.some((check) => check.required) || c.data.checks.some((check) => check.required && check.status !== 'PASS')) reasons.push('REQUIRED_CHECKS_NOT_PASSED');
  }
  if (!q.success) reasons.push('INVALID_QA');
  else {
    if (q.data.candidate_digest !== candidateDigest) reasons.push('STALE_QA');
    if (q.data.status !== 'PASS') reasons.push('QA_NOT_PASSED');
  }
  if (!r.success) reasons.push('INVALID_REVIEW');
  else {
    if (r.data.candidate_digest !== candidateDigest) reasons.push('STALE_REVIEW');
    if (r.data.status !== 'PASS') reasons.push('REVIEW_NOT_PASSED');
  }
  return { ready: reasons.length === 0, reasons };
}

export const artifactManifestSchema = z.strictObject({
  schema_version: z.literal(1), job_id: jobIdSchema, issue_key: issueKeySchema, status: jobStateSchema,
  candidate_digest: digestSchema.nullable(), base_sha: gitShaSchema.nullable(), commit_sha: gitShaSchema.nullable(),
  feature_branch: z.string().nullable(), push_status: z.enum(['DISABLED', 'NOT_ATTEMPTED', 'PUSHED', 'FAILED']),
  parent_job_id: jobIdSchema.nullable().optional(), revision: z.number().int().min(0).max(20).optional(),
  repair_round: z.number().int().min(0).max(2).optional(),
  files: z.array(z.strictObject({ name: relativePathSchema.refine((s) => !s.includes('/')), sha256: digestSchema, media_type: z.string().min(1) })),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
