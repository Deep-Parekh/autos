import { z } from 'zod';
import { indexedCommentSchema, indexedIssueSchema, type IndexedComment, type IndexedIssue } from '@autos/contracts';
import { safeError } from './http.js';

/** Pure helpers for the read-only Jira index sync (docs/semantic-precedents-plan.md §3.1). */

const PROJECT_KEY = /^[A-Z][A-Z0-9]*$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
export const MAX_INDEX_PROJECTS = 200;
export const MAX_WINDOW_WEEKS = 1040;

export const INDEX_ISSUE_FIELDS = [
  'summary', 'description', 'issuetype', 'status', 'resolution', 'resolutiondate', 'created', 'updated', 'project',
  'components', 'labels', 'issuelinks', 'parent', 'comment', 'security',
] as const;

export interface IndexScope { projects: string[]; windowWeeks: number; updatedSince?: Date }

function pad(value: number): string { return String(value).padStart(2, '0'); }

/** Formats a date as a JQL date literal (UTC wall clock; Jira reads it in the API user's profile time zone). */
export function formatJqlDate(date: Date): string {
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** JQL built only from validated project keys, an integer window and a formatted date. Never from free text. */
export function buildIndexJql(scope: IndexScope): string {
  if (!Array.isArray(scope.projects) || scope.projects.length === 0 || scope.projects.length > MAX_INDEX_PROJECTS ||
      !scope.projects.every((project) => typeof project === 'string' && PROJECT_KEY.test(project))) {
    throw safeError('INVALID_INPUT', 'Index project keys are invalid');
  }
  if (!Number.isInteger(scope.windowWeeks) || scope.windowWeeks < 1 || scope.windowWeeks > MAX_WINDOW_WEEKS) {
    throw safeError('INVALID_INPUT', 'Index window is invalid');
  }
  const projects = [...new Set(scope.projects)].join(', ');
  let jql = `project in (${projects}) AND updated >= -${scope.windowWeeks}w`;
  if (scope.updatedSince !== undefined) {
    if (!(scope.updatedSince instanceof Date) || !Number.isFinite(scope.updatedSince.getTime())) throw safeError('INVALID_INPUT', 'Index cursor date is invalid');
    jql += ` AND updated >= "${formatJqlDate(scope.updatedSince)}"`;
  }
  return `${jql} ORDER BY updated ASC, key ASC`;
}

export function validateNextPageToken(token: string | undefined): void {
  if (token !== undefined && (typeof token !== 'string' || !token || token.length > 4096 || /[\u0000-\u001f]/.test(token))) {
    throw safeError('INVALID_INPUT', 'Pagination token is invalid');
  }
}

const searchPageSchema = z.object({ issues: z.array(z.unknown()), nextPageToken: z.string().optional(), isLast: z.boolean().optional() });

/** Validates a search page and its continuation: isLast/false without a token or a repeated token fail closed. */
export function parseSearchPage(raw: unknown, requestToken: string | undefined): { issues: unknown[]; nextPageToken?: string } {
  const parsed = searchPageSchema.safeParse(raw);
  if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid search page');
  const next = parsed.data.nextPageToken;
  if (parsed.data.isLast === false && !next) throw safeError('UPSTREAM', 'Atlassian indicated more results without a continuation token');
  if (parsed.data.isLast === true || !next) return { issues: parsed.data.issues };
  if (next === requestToken) throw safeError('UPSTREAM', 'Atlassian repeated a pagination token');
  return { issues: parsed.data.issues, nextPageToken: next };
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

const named = z.object({ name: z.string() }).passthrough();
const rawCommentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  created: z.string(),
  body: z.unknown(),
  visibility: z.unknown().optional(),
  author: z.object({ accountType: z.string().optional() }).passthrough().nullish(),
}).passthrough();

/** Restricted (visibility-set) comments return null: they are never stored. Throws on malformed rows. */
export function normalizeIndexedComment(raw: unknown, plainText: (value: unknown) => string): IndexedComment | null {
  const parsed = rawCommentSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid comment');
  if (parsed.data.visibility !== undefined && parsed.data.visibility !== null) return null;
  const comment = indexedCommentSchema.safeParse({
    id: parsed.data.id,
    author_is_app: parsed.data.author?.accountType === 'app',
    created: isoOrNull(parsed.data.created),
    body: plainText(parsed.data.body).trim(),
  });
  if (!comment.success) throw new Error('invalid comment');
  return comment.data;
}

const commentContainerSchema = z.object({ comments: z.array(z.unknown()), total: z.number().int().nonnegative().optional() }).passthrough();
const rawIssueSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.unknown().optional(),
    issuetype: named,
    status: named,
    resolution: named.nullish(),
    resolutiondate: z.string().nullish(),
    created: z.string(),
    updated: z.string(),
    project: z.object({ key: z.string() }).passthrough(),
    components: z.array(named).nullish(),
    labels: z.array(z.string()).nullish(),
    issuelinks: z.array(z.object({ inwardIssue: z.object({ key: z.string() }).passthrough().optional(), outwardIssue: z.object({ key: z.string() }).passthrough().optional() }).passthrough()).nullish(),
    parent: z.object({ key: z.string() }).passthrough().nullish(),
    comment: commentContainerSchema.nullish(),
    security: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

export type IssueRowResult = { kind: 'issue'; issue: IndexedIssue } | { kind: 'restricted' } | { kind: 'invalid' };

/** Normalizes one search row. Never throws: restricted rows and malformed rows are reported for counting. */
export function normalizeIndexedIssue(raw: unknown, projects: ReadonlySet<string>, plainText: (value: unknown) => string): IssueRowResult {
  // Check the security level before anything else so restricted issues are never parsed further.
  if (raw && typeof raw === 'object' && 'fields' in raw) {
    const fields = (raw as { fields?: unknown }).fields;
    if (fields && typeof fields === 'object' && (fields as Record<string, unknown>).security != null) return { kind: 'restricted' };
  }
  const parsed = rawIssueSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid' };
  const fields = parsed.data.fields;
  if (!projects.has(fields.project.key)) return { kind: 'invalid' };
  try {
    const rawComments = fields.comment?.comments ?? [];
    const comments: IndexedComment[] = [];
    for (const entry of rawComments) {
      const comment = normalizeIndexedComment(entry, plainText);
      if (comment) comments.push(comment);
    }
    const linkKeys = new Set<string>();
    for (const link of fields.issuelinks ?? []) {
      for (const linked of [link.inwardIssue, link.outwardIssue]) if (linked && ISSUE_KEY.test(linked.key)) linkKeys.add(linked.key);
    }
    const total = fields.comment?.total;
    const issue = indexedIssueSchema.safeParse({
      id: parsed.data.id,
      key: parsed.data.key,
      project_key: fields.project.key,
      issue_type: fields.issuetype.name,
      status: fields.status.name,
      resolution: fields.resolution?.name ?? null,
      resolved_at: fields.resolutiondate ? isoOrNull(fields.resolutiondate) ?? 'invalid' : null,
      created_at: isoOrNull(fields.created),
      updated_at: isoOrNull(fields.updated),
      summary: fields.summary,
      description: plainText(fields.description).trim(),
      components: (fields.components ?? []).map((component) => component.name),
      labels: fields.labels ?? [],
      link_keys: [...linkKeys],
      parent_key: fields.parent?.key ?? null,
      comments,
      // Compare against the raw count (restricted comments included) so dropped comments do not force refetches.
      comments_truncated: total !== undefined && total > rawComments.length,
    });
    return issue.success ? { kind: 'issue', issue: issue.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

const idRowSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^[0-9]+$/)),
  key: z.string().regex(ISSUE_KEY),
  fields: z.object({ updated: z.string() }).passthrough(),
}).passthrough();

/** Reconciliation rows must all be valid: a skipped row would look like a deleted issue, so malformed rows fail closed. */
export function normalizeIdRow(raw: unknown): { id: string; key: string; updated: string } {
  const parsed = idRowSchema.safeParse(raw);
  const updated = parsed.success ? isoOrNull(parsed.data.fields.updated) : null;
  if (!parsed.success || !updated) throw safeError('UPSTREAM', 'Atlassian returned an invalid issue id row');
  return { id: parsed.data.id, key: parsed.data.key, updated };
}

export const indexCommentPageSchema = z.object({
  comments: z.array(z.unknown()),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
}).passthrough();
