import { z } from 'zod';
import { jdkVersionSchema, tomcatVersionSchema } from './toolchain.js';

export const SCHEMA_VERSION = 1 as const;
export const PROVIDERS = ['claude', 'codex', 'cursor'] as const;
export const ROLES = ['swe', 'qa', 'reviewer'] as const;
export const JOB_STATES = ['QUEUED', 'INVESTIGATING', 'PLANNED', 'IMPLEMENTING', 'QA', 'REVIEW', 'REVISING', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLING', 'CANCELLED'] as const;
export const providerSchema = z.enum(PROVIDERS);
export const roleSchema = z.enum(ROLES);
export const jobStateSchema = z.enum(JOB_STATES);
export const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
export const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*$/);
export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const timestampSchema = z.iso.datetime();
export const jobIdSchema = z.uuid();
export const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
export const modelSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
export const relativePathSchema = z.string().min(1).refine((path) =>
  !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) &&
  !/^[A-Za-z]:/.test(path) && path.split('/').every((part) => part !== '..' && part !== '.' && part !== '') &&
  !path.split('/').some((part) => part.toLowerCase() === '.git'), 'Expected a contained source path');
export const branchNameSchema = z.string().min(1).max(200).refine((branch) =>
  !branch.startsWith('-') && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.') &&
  !branch.includes('..') && !branch.includes('@{') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
  branch !== '@' && branch.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock')),
  'Invalid Git branch name');

export const issueSnapshotSchema = z.strictObject({
  key: issueKeySchema,
  project_key: projectKeySchema,
  summary: z.string().min(1),
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  issue_type: z.string().min(1),
  status: z.string().min(1),
  updated_at: timestampSchema,
  fetched_at: timestampSchema,
  comments: z.array(z.strictObject({ id: z.string(), body: z.string() })),
  linked_issue_keys: z.array(issueKeySchema),
  components: z.array(z.string()),
  url: z.url(),
}).refine((issue) => issue.key.startsWith(`${issue.project_key}-`), 'Project key does not match issue');
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;

export const savedFilterSchema = z.strictObject({ id: z.string().regex(/^[0-9]+$/), name: z.string(), jql: z.string().min(1) });
export type SavedFilter = z.infer<typeof savedFilterSchema>;

export const projectMappingSchema = z.strictObject({
  project_key: projectKeySchema,
  workspace: identifierSchema,
  repository_slug: identifierSchema,
  development_branch: branchNameSchema,
  sandbox_branch: branchNameSchema.nullable(),
  enabled: z.boolean(),
  /** Optional branch-map JDK major / Tomcat version; null or absent falls back to the build profile. */
  jdk: jdkVersionSchema.nullable().optional(),
  tomcat: tomcatVersionSchema.nullable().optional(),
  source: z.strictObject({ page_id: z.string().regex(/^[0-9]+$/), version: z.number().int().positive(), fetched_at: timestampSchema }),
});
export type ProjectMapping = z.infer<typeof projectMappingSchema>;

export const precedentSchema = z.strictObject({
  issue_key: issueKeySchema,
  issue_url: z.url(),
  reason: z.string().min(1),
  commit_sha: gitShaSchema,
  evidence_url: z.url(),
  diff: z.string().min(1),
  caveats: z.array(z.string()),
});
export type Precedent = z.infer<typeof precedentSchema>;
export const precedentResultSchema = z.strictObject({
  items: z.array(precedentSchema).max(5), outcome: z.enum(['FOUND', 'NO_MATCH', 'DISABLED']),
  disabled_reason: z.enum(['CONFIG_DISABLED', 'MISSING_CREDENTIALS']).optional(),
  search_truncated: z.boolean().optional(),
}).refine((result) => result.outcome === 'FOUND' ? result.items.length > 0 : result.items.length === 0, 'Precedent outcome does not match evidence')
  .refine((result) => result.disabled_reason === undefined || result.outcome === 'DISABLED', 'Only disabled lookups can have a disabled reason');
export type PrecedentResult = z.infer<typeof precedentResultSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type AgentRole = z.infer<typeof roleSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
