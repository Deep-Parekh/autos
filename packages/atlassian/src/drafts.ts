import { z } from 'zod';
import { confluenceDraftRefSchema, type ConfluenceDraftRef, type PossiblyAffected } from '@autos/contracts';
import { defaultSleep, requestJson, safeError, siteUrl, type FetchLike, type HttpMethod, type Sleep } from './http.js';

/**
 * The only Atlassian write path in Autos (docs/semantic-precedents-plan.md §12): create an unpublished Confluence
 * draft in one configured space under one configured parent, and update it only while it is still an unedited draft.
 * There is no publish path (status is a hard-coded "draft" literal), no DELETE, no redirects, and errors carry no content.
 */

const DRAFT_STATUS = 'draft' as const;
const MAX_TITLE_CHARS = 255;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SPACE_KEY = /^[A-Za-z0-9~_-]{1,255}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;
const PAGES_PATH = '/wiki/api/v2/pages';

export interface ConfluenceDraftWriterOptions {
  siteUrl: string;
  username: string;
  token: string;
  spaceKey: string;
  parentPageId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
}

export interface DraftContent { title: string; storageBody: string }

const idLike = z.union([z.string(), z.number()]).transform(String);
const spacesSchema = z.object({ results: z.array(z.object({ id: idLike, key: z.string() }).passthrough()) }).passthrough();
const pageSchema = z.object({
  id: idLike,
  status: z.string(),
  spaceId: idLike,
  parentId: idLike.nullish(),
  version: z.object({ number: z.number().int().positive() }).passthrough(),
}).passthrough();

function validateContent(content: DraftContent): void {
  const { title, storageBody } = content ?? ({} as DraftContent);
  if (typeof title !== 'string' || !title.trim() || [...title].length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f]/.test(title)) {
    throw safeError('INVALID_INPUT', 'Draft title is empty, too long or contains control characters');
  }
  if (typeof storageBody !== 'string' || !storageBody.trim() || Buffer.byteLength(storageBody, 'utf8') > MAX_BODY_BYTES) {
    throw safeError('INVALID_INPUT', 'Draft body is empty or exceeds the size limit');
  }
}

export class ConfluenceDraftWriter {
  private readonly site: string;
  private readonly auth: string;
  private readonly spaceKey: string;
  private readonly parentPageId: string;
  private readonly fetcher: FetchLike;
  private readonly sleep: Sleep;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private spaceId: string | undefined;

  constructor(options: ConfluenceDraftWriterOptions) {
    let site: URL;
    try { site = new URL(options.siteUrl); } catch { throw safeError('INVALID_CONFIG', 'Confluence draft site URL is invalid'); }
    if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || (site.pathname !== '/' && site.pathname !== '')) {
      throw safeError('INVALID_CONFIG', 'Confluence draft site URL must be a bare https origin');
    }
    if (typeof options.spaceKey !== 'string' || !SPACE_KEY.test(options.spaceKey)) throw safeError('INVALID_CONFIG', 'Confluence draft space key is invalid');
    if (typeof options.parentPageId !== 'string' || !NUMERIC_ID.test(options.parentPageId)) throw safeError('INVALID_CONFIG', 'Confluence draft parent page id is invalid');
    if (!options.username || !options.token || /[\r\n]/.test(options.username + options.token)) throw safeError('AUTH', 'Atlassian credentials are missing or invalid');
    const timeoutMs = options.timeoutMs ?? 20_000;
    const retries = options.maxRetries ?? 3;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(retries) || retries < 0) throw safeError('INVALID_INPUT', 'Draft writer timeout and retry settings are invalid');
    this.site = site.origin;
    this.auth = `Basic ${Buffer.from(`${options.username}:${options.token}`).toString('base64')}`;
    this.spaceKey = options.spaceKey;
    this.parentPageId = options.parentPageId;
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  /** Creates an unpublished draft under the configured parent. Returns only ids and an Autos-built edit link. */
  async createDraft(content: DraftContent, signal?: AbortSignal): Promise<ConfluenceDraftRef> {
    validateContent(content);
    const spaceId = await this.resolveSpaceId(signal);
    const { json } = await this.send('POST', PAGES_PATH, {
      spaceId, status: DRAFT_STATUS, title: content.title, parentId: this.parentPageId,
      body: { representation: 'storage', value: content.storageBody },
    }, signal);
    const page = pageSchema.safeParse(json);
    if (!page.success || !NUMERIC_ID.test(page.data.id)) throw safeError('UPSTREAM', 'Confluence returned an invalid page after creating a draft');
    if (page.data.status !== DRAFT_STATUS) throw safeError('POLICY', 'Confluence did not keep the created page as a draft; check the page manually');
    if (page.data.spaceId !== spaceId || (page.data.parentId != null && page.data.parentId !== this.parentPageId)) {
      throw safeError('POLICY', 'Confluence placed the draft outside the configured space or parent; check the page manually');
    }
    return this.ref(page.data.id, spaceId, page.data.version.number);
  }

  /**
   * Updates a draft Autos created, only while it is still an unedited draft in the configured space and parent.
   * Otherwise nothing is written and `{ superseded: true }` is returned so the caller creates a new draft.
   */
  async updateDraft(ref: ConfluenceDraftRef, content: DraftContent, signal?: AbortSignal): Promise<ConfluenceDraftRef | { superseded: true }> {
    const parsedRef = confluenceDraftRefSchema.safeParse(ref);
    if (!parsedRef.success) throw safeError('INVALID_INPUT', 'Draft reference is invalid');
    validateContent(content);
    const spaceId = await this.resolveSpaceId(signal);
    if (parsedRef.data.space_id !== spaceId) return { superseded: true };
    const pagePath = `${PAGES_PATH}/${encodeURIComponent(parsedRef.data.page_id)}`;
    const current = await this.send('GET', pagePath, undefined, signal, { 'get-draft': 'true' }, [404]);
    if (current.status === 404) return { superseded: true };
    const page = pageSchema.safeParse(current.json);
    if (!page.success) throw safeError('UPSTREAM', 'Confluence returned an invalid page');
    if (page.data.id !== parsedRef.data.page_id || page.data.status !== DRAFT_STATUS || page.data.version.number !== parsedRef.data.version ||
        page.data.spaceId !== spaceId || (page.data.parentId ?? null) !== this.parentPageId) {
      return { superseded: true };
    }
    const nextVersion = parsedRef.data.version + 1;
    const updated = await this.send('PUT', pagePath, {
      id: parsedRef.data.page_id, status: DRAFT_STATUS, title: content.title,
      body: { representation: 'storage', value: content.storageBody }, version: { number: nextVersion },
    }, signal, undefined, [409]);
    if (updated.status === 409) return { superseded: true };
    const result = pageSchema.safeParse(updated.json);
    if (!result.success || result.data.id !== parsedRef.data.page_id) throw safeError('UPSTREAM', 'Confluence returned an invalid page after updating a draft');
    if (result.data.status !== DRAFT_STATUS) throw safeError('POLICY', 'Confluence did not keep the updated page as a draft; check the page manually');
    return this.ref(result.data.id, spaceId, result.data.version.number);
  }

  private ref(pageId: string, spaceId: string, version: number): ConfluenceDraftRef {
    // The edit link is built by Autos from validated ids; upstream `_links` are never trusted.
    const edit = siteUrl(this.site, `/wiki/spaces/${encodeURIComponent(this.spaceKey)}/pages/edit-v2/${encodeURIComponent(pageId)}`);
    const parsed = confluenceDraftRefSchema.safeParse({ page_id: pageId, space_id: spaceId, version, status: DRAFT_STATUS, edit_url: edit.toString() });
    if (!parsed.success) throw safeError('UPSTREAM', 'Confluence returned an invalid draft reference');
    return parsed.data;
  }

  private async resolveSpaceId(signal?: AbortSignal): Promise<string> {
    if (this.spaceId) return this.spaceId;
    const { json } = await this.send('GET', '/wiki/api/v2/spaces', undefined, signal, { keys: this.spaceKey });
    const parsed = spacesSchema.safeParse(json);
    const matches = parsed.success ? parsed.data.results.filter((space) => space.key === this.spaceKey) : [];
    if (matches.length !== 1 || !NUMERIC_ID.test(matches[0]!.id)) throw safeError('MAPPING', 'Configured Confluence draft space was not found');
    this.spaceId = matches[0]!.id;
    return this.spaceId;
  }

  /** The only request primitive: GET/POST/PUT on the configured origin. DELETE is not representable. */
  private send(method: HttpMethod, path: string, body: unknown, signal?: AbortSignal, query?: Record<string, string>, passStatuses?: number[]) {
    const url = siteUrl(this.site, path, query);
    return requestJson({ fetcher: this.fetcher, sleep: this.sleep, timeoutMs: this.timeoutMs, retries: this.retries, url, auth: this.auth, method, body, signal, passStatuses });
  }
}

// ---- Storage-format rendering ----

export interface FixDocumentInput {
  issueKey: string;
  issueUrl: string;
  summary: string;
  repository: string;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  checks: { name: string; status: string }[];
  qa: { status: string; summary: string };
  review: { status: string; summary: string };
  fixSummary: string;
  possiblyAffected: PossiblyAffected | null;
  precedentsUsed: { issue_key: string; issue_url: string; kind: string }[];
  limitations?: string[];
}

const MAX_LIST_ITEMS = 500;

/** Removes characters XML 1.0 forbids (controls, lone surrogates) and redacts obvious secret patterns. */
function clean(value: unknown): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"]*"?|'[^']*'?|[^\s"',;&]+)/gi, '$1$2[redacted]');
}

/** Escapes text for an XHTML text node or attribute value. */
export function escapeXml(value: unknown): string {
  return clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Returns an https URL without credentials, or null. Only such URLs become links. */
function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function text(value: unknown): string { return escapeXml(value); }
function link(href: unknown, label: unknown): string {
  const url = safeHttpsUrl(href);
  return url ? `<a href="${escapeXml(url)}">${text(label)}</a>` : text(label);
}
function para(content: string): string { return `<p>${content}</p>`; }
function heading(level: 1 | 2 | 3, value: string): string { return `<h${level}>${text(value)}</h${level}>`; }
function list(items: string[]): string { return items.length ? `<ul>${items.slice(0, MAX_LIST_ITEMS).map((item) => `<li>${item}</li>`).join('')}</ul>` : para(text('None.')); }
function multiline(value: unknown): string {
  const lines = clean(value).split(/\r?\n/).map((line) => line.trim());
  const blocks: string[] = []; let current: string[] = [];
  for (const line of lines) {
    if (line) current.push(escapeXml(line));
    else if (current.length) { blocks.push(para(current.join('<br />'))); current = []; }
  }
  if (current.length) blocks.push(para(current.join('<br />')));
  return blocks.join('') || para(text('None.'));
}

const APPLIES_TEXT: Record<'clean' | 'needs_adaptation' | 'unknown', string> = {
  clean: 'fix applies cleanly',
  needs_adaptation: 'fix needs adaptation',
  unknown: 'fix applicability unknown',
};

function evidence(items: string[]): string {
  return items.length ? `<ul>${items.slice(0, MAX_LIST_ITEMS).map((item) => `<li>${text(item)}</li>`).join('')}</ul>` : '';
}

/** Draft title `<KEY>: <summary> — fix`, cut to Confluence's 255-character limit. */
export function fixDocumentTitle(issueKey: string, summary: string): string {
  const suffix = ' — fix';
  const prefix = `${clean(issueKey)}: `;
  const room = MAX_TITLE_CHARS - [...prefix].length - [...suffix].length;
  const chars = [...clean(summary).replace(/\s+/g, ' ').trim()];
  const body = chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join('')}…` : chars.join('');
  return `${prefix}${body}${suffix}`;
}

/**
 * Builds Confluence storage-format XHTML for a fix document. Every input value becomes an escaped text node;
 * links come only from https URLs passed in; no raw HTML or macros are taken from inputs.
 */
export function renderFixDocumentStorage(input: FixDocumentInput): string {
  const parts: string[] = [];
  parts.push(heading(2, 'Ticket'));
  parts.push(para(`${link(input.issueUrl, input.issueKey)}: ${text(input.summary)}`));

  parts.push(heading(2, 'Change'));
  parts.push(list([
    `Repository: ${text(input.repository)}`,
    `Branch: ${text(input.branch)}`,
    `Commit: <code>${text(input.commitSha)}</code>`,
  ]));
  parts.push(heading(3, 'Changed files'));
  parts.push(list((input.changedFiles ?? []).map((file) => `<code>${text(file)}</code>`)));

  parts.push(heading(2, 'Fix summary'));
  parts.push(multiline(input.fixSummary));

  parts.push(heading(2, 'Verification'));
  parts.push(heading(3, 'Checks'));
  parts.push(list((input.checks ?? []).map((check) => `${text(check.name)}: ${text(check.status)}`)));
  parts.push(heading(3, 'QA'));
  parts.push(para(`Status: ${text(input.qa?.status)}`));
  parts.push(multiline(input.qa?.summary));
  parts.push(heading(3, 'Review'));
  parts.push(para(`Status: ${text(input.review?.status)}`));
  parts.push(multiline(input.review?.summary));

  const affected = input.possiblyAffected;
  if (affected && (affected.open_tickets.length || affected.branches.length)) {
    parts.push(heading(2, 'May also affect'));
    parts.push(para(text('Advisory only: these were found by comparing the final change with other tickets and branches. They are not confirmed bugs, and Autos has not queued any work for them.')));
    if (affected.open_tickets.length) {
      parts.push(heading(3, 'Open tickets'));
      parts.push(`<ul>${affected.open_tickets.map((ticket) => `<li>${text(`${ticket.issue_key} (project ${ticket.project_key}, ${ticket.status}): ${ticket.summary}`)}. ${text('This may be a similar issue and should be checked.')}${evidence(ticket.evidence)}</li>`).join('')}</ul>`);
    }
    if (affected.branches.length) {
      parts.push(heading(3, 'Branches without a ticket'));
      parts.push(`<ul>${affected.branches.map((branch) => `<li>${text(`Branch ${branch.branch} (Jira project ${branch.project_key}, lineage ${branch.lineage_id}): ${APPLIES_TEXT[branch.applies] ?? APPLIES_TEXT.unknown}`)}. ${text('This branch may have a similar issue and should be checked and fixed if affected.')}${evidence(branch.evidence)}</li>`).join('')}</ul>`);
    }
  }

  if (input.precedentsUsed?.length) {
    parts.push(heading(2, 'Precedents used'));
    parts.push(list(input.precedentsUsed.map((precedent) => `${link(precedent.issue_url, precedent.issue_key)} (${text(precedent.kind)})`)));
  }

  parts.push(heading(2, 'Limitations'));
  const limitations = input.limitations?.length ? input.limitations : ['Generated by Autos from workflow artifacts. Review before publishing; Autos does not publish this page.'];
  parts.push(list(limitations.map((item) => text(item))));
  return parts.join('');
}
