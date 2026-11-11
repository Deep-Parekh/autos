import { parseFragment } from 'parse5';
import { z } from 'zod';
import type {
  AutosError, KnowledgeAttachmentMeta, KnowledgeComment, KnowledgeIssue, KnowledgeIssueHit, KnowledgePage, KnowledgePageHit, KnowledgeReadPort,
} from '@autos/contracts';

type Query = Record<string, string>;
export interface KnowledgeHost {
  jira: { site: string; auth: string };
  confluence: { site: string; auth: string };
  getJson(site: string, path: string, auth: string, query: Query, signal?: AbortSignal): Promise<unknown>;
  getBytes(site: string, path: string, auth: string, query: Query, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  plainText(value: unknown): string;
  escapeJql(value: string): string;
  safeError(code: ConstructorParameters<typeof AutosError>[0], message: string, retryable?: boolean): AutosError;
}

const MAX_COMMENTS = 200;
const COMMENT_PAGE = 100;
const EXCERPT_CHARS = 400;
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const NUMERIC_ID = /^\d{1,20}$/;
const SPACE_KEY = /^[A-Za-z0-9~_.-]{1,255}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

const str = z.string();
const idLike = z.union([z.string(), z.number()]).transform(String);
const namedSchema = z.object({ name: str.optional() }).passthrough();
const attachmentSchema = z.object({
  id: idLike, filename: str, mimeType: str.optional(), size: z.number().int().nonnegative().optional(), created: str.optional(),
  author: z.object({ displayName: str.optional() }).passthrough().nullish(),
}).passthrough();
const linkedSchema = z.object({ key: str, fields: z.object({ summary: str.optional(), status: namedSchema.nullish() }).passthrough().optional() }).passthrough();
const linkSchema = z.object({
  type: z.object({ inward: str.optional(), outward: str.optional(), name: str.optional() }).passthrough().optional(),
  inwardIssue: linkedSchema.optional(), outwardIssue: linkedSchema.optional(),
}).passthrough();
const issueSchema = z.object({
  key: str,
  fields: z.object({
    summary: str.nullish(), description: z.unknown().optional(), issuetype: namedSchema.nullish(), status: namedSchema.nullish(), resolution: namedSchema.nullish(),
    labels: z.array(str).nullish(), components: z.array(namedSchema).nullish(), created: str.nullish(), updated: str.nullish(),
    issuelinks: z.array(linkSchema).nullish(), attachment: z.array(attachmentSchema).nullish(), project: z.object({ key: str.optional() }).passthrough().nullish(),
  }).passthrough(),
}).passthrough();
const attachmentsOnlySchema = z.object({ fields: z.object({ attachment: z.array(attachmentSchema).nullish() }).passthrough() }).passthrough();
const commentPageSchema = z.object({
  comments: z.array(z.object({ id: idLike, created: str.optional(), body: z.unknown().optional(), author: z.object({ displayName: str.optional() }).passthrough().nullish() }).passthrough()),
  total: z.number().int().nonnegative().optional(), maxResults: z.number().int().positive().optional(),
}).passthrough();
const searchSchema = z.object({ issues: z.array(z.object({ key: str, fields: z.object({
  summary: str.nullish(), status: namedSchema.nullish(), resolution: namedSchema.nullish(), updated: str.nullish(),
}).passthrough().optional() }).passthrough()) }).passthrough();
const contentSchema = z.object({
  id: idLike, title: str.optional(),
  space: z.object({ key: str.optional() }).passthrough().nullish(),
  version: z.object({ when: str.optional() }).passthrough().nullish(),
}).passthrough();
const cqlSchema = z.object({ results: z.array(z.object({
  content: contentSchema.nullish(), title: str.optional(), excerpt: str.nullish(), lastModified: str.nullish(),
  resultGlobalContainer: z.object({ displayUrl: str.optional() }).passthrough().nullish(),
}).passthrough()) }).passthrough();
const pageSchema = contentSchema.extend({
  body: z.object({ storage: z.object({ value: str }).passthrough().optional() }).passthrough().nullish(),
  ancestors: z.array(z.object({ id: idLike }).passthrough()).nullish(),
}).passthrough();
const childrenSchema = z.object({ results: z.array(contentSchema) }).passthrough();

// --- text helpers ---
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    if (lower.startsWith('#x')) { const code = parseInt(lower.slice(2), 16); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '; }
    if (lower.startsWith('#')) { const code = Number(lower.slice(1)); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '; }
    return whole;
  });
}
function excerptText(raw: string): string {
  const text = decodeEntities(raw.replace(/@@@hl@@@|@@@endhl@@@/g, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

interface HtmlNode { nodeName: string; value?: string; data?: string; childNodes?: HtmlNode[]; content?: HtmlNode }
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'tr', 'table', 'blockquote', 'pre', 'br', 'hr', 'ac:task', 'ac:structured-macro', 'ac:rich-text-body']);
const DROP = new Set(['ac:parameter', 'ri:page', 'ri:attachment', 'ri:user', 'ri:space', 'ri:url', 'ri:content-entity', 'ac:image', 'script', 'style', 'ac:placeholder']);
export function storageToText(html: string): string {
  const out: string[] = [];
  const walk = (node: HtmlNode): void => {
    if (node.nodeName === '#text') { out.push(node.value ?? ''); return; }
    if (node.nodeName === '#comment') { // HTML parsing turns <![CDATA[...]]> into a bogus comment
      const match = /^\[CDATA\[([\s\S]*?)(?:\]\])?$/.exec(node.data ?? ''); if (match) out.push(match[1]!);
      return;
    }
    if (DROP.has(node.nodeName)) return;
    const block = BLOCK.has(node.nodeName);
    const cell = node.nodeName === 'td' || node.nodeName === 'th';
    if (block) out.push('\n');
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) for (const child of node.content.childNodes ?? []) walk(child);
    if (cell) out.push('\t'); else if (block) out.push('\n');
  };
  walk(parseFragment(html) as unknown as HtmlNode);
  return out.join('').split('\n').map((line) => line.replace(/\t+$/, '').replace(/[ \u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
}

export function createKnowledgeReads(host: KnowledgeHost): KnowledgeReadPort {
  const { safeError } = host;
  const invalid = (what: string) => safeError('INVALID_INPUT', `${what} is invalid`);
  const upstream = () => safeError('UPSTREAM', 'Atlassian returned an invalid response');
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw upstream();
    return parsed.data;
  };
  const issueKey = (key: string): string => { if (typeof key !== 'string' || !ISSUE_KEY.test(key)) throw invalid('Issue key'); return key; };
  const numericId = (id: string, what: string): string => { if (typeof id !== 'string' || !NUMERIC_ID.test(id)) throw invalid(what); return id; };
  const limitOf = (limit: number): number => { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('Result limit'); return limit; };
  const text = (value: string, what: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw invalid(what);
    return value;
  };
  const jira = (path: string, query: Query, signal?: AbortSignal) => host.getJson(host.jira.site, path, host.jira.auth, query, signal);
  const wiki = (path: string, query: Query, signal?: AbortSignal) => host.getJson(host.confluence.site, path, host.confluence.auth, query, signal);
  const attachmentMeta = (a: z.infer<typeof attachmentSchema>): KnowledgeAttachmentMeta => ({
    id: a.id, filename: a.filename, mime_type: a.mimeType ?? 'application/octet-stream', size: a.size ?? 0, created: a.created ?? '', author: a.author?.displayName ?? '',
  });
  const spaceOf = (item: { content?: z.infer<typeof contentSchema> | null | undefined; resultGlobalContainer?: { displayUrl?: string | undefined } | null | undefined }): string => {
    const direct = item.content?.space?.key;
    if (direct) return direct;
    const match = /\/spaces\/([^/?#]+)/.exec(item.resultGlobalContainer?.displayUrl ?? '');
    return match ? decodeURIComponent(match[1]!) : '';
  };

  async function attachmentsOf(key: string, signal?: AbortSignal): Promise<KnowledgeAttachmentMeta[]> {
    const raw = parse(attachmentsOnlySchema, await jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: 'attachment' }, signal));
    return (raw.fields.attachment ?? []).map(attachmentMeta);
  }

  return {
    async getIssueDetail(key, signal) {
      issueKey(key);
      const raw = parse(issueSchema, await jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
        fields: 'summary,description,issuetype,status,resolution,labels,components,created,updated,issuelinks,attachment,project',
      }, signal));
      if (raw.key !== key) throw safeError('UPSTREAM', 'Atlassian returned a different issue than requested');
      const f = raw.fields;
      const links: KnowledgeIssue['links'] = [];
      for (const link of f.issuelinks ?? []) {
        for (const [direction, relation] of [['inwardIssue', link.type?.inward], ['outwardIssue', link.type?.outward]] as const) {
          const linked = link[direction];
          if (linked) links.push({ key: linked.key, relation: relation ?? link.type?.name ?? 'relates to', summary: linked.fields?.summary ?? '', status: linked.fields?.status?.name ?? '' });
        }
      }
      return {
        key: raw.key, project_key: f.project?.key ?? raw.key.split('-')[0]!, summary: f.summary ?? '', description: host.plainText(f.description).trim(),
        issue_type: f.issuetype?.name ?? '', status: f.status?.name ?? '', resolution: f.resolution?.name ?? null,
        labels: f.labels ?? [], components: (f.components ?? []).map((c) => c.name ?? '').filter(Boolean),
        created: f.created ?? '', updated: f.updated ?? '', links, attachments: (f.attachment ?? []).map(attachmentMeta),
      } as KnowledgeIssue;
    },

    async getIssueComments(key, signal) {
      issueKey(key);
      const comments: KnowledgeComment[] = [];
      let startAt = 0;
      while (comments.length < MAX_COMMENTS) {
        const page = parse(commentPageSchema, await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
          startAt: String(startAt), maxResults: String(COMMENT_PAGE), orderBy: 'created',
        }, signal));
        for (const c of page.comments) {
          if (comments.length >= MAX_COMMENTS) break;
          comments.push({ id: c.id, author: c.author?.displayName ?? '', created: c.created ?? '', body: host.plainText(c.body).trim() });
        }
        startAt += page.comments.length;
        if (page.comments.length === 0 || (page.total !== undefined && startAt >= page.total) || page.comments.length < (page.maxResults ?? COMMENT_PAGE)) break;
      }
      return comments;
    },

    async getIssueAttachment(key, attachmentId, maxBytes, signal) {
      issueKey(key);
      numericId(attachmentId, 'Attachment id');
      if (!Number.isInteger(maxBytes) || maxBytes < 1) throw invalid('Attachment size limit');
      const meta = (await attachmentsOf(key, signal)).find((a) => a.id === attachmentId);
      if (!meta) throw safeError('NOT_FOUND', 'Attachment does not belong to the issue');
      if (meta.size > maxBytes) throw safeError('INVALID_INPUT', 'Attachment exceeds the size limit');
      const data = await host.getBytes(host.jira.site, `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`, host.jira.auth, { redirect: 'false' }, maxBytes, signal);
      return { meta: { ...meta, size: meta.size || data.byteLength }, data };
    },

    async searchIssues(input, signal) {
      const limit = limitOf(input.limit);
      const query = text(input.text, 'Search text');
      if (!input.projects.length) return [];
      for (const project of input.projects) if (!PROJECT_KEY.test(project)) throw invalid('Project key');
      const projects = input.projects.map((p) => `"${host.escapeJql(p)}"`).join(', ');
      const jql = `project in (${projects}) AND text ~ "${host.escapeJql(query)}"${input.resolvedOnly ? ' AND statusCategory = Done' : ''} ORDER BY updated DESC`;
      const raw = parse(searchSchema, await jira('/rest/api/3/search/jql', { jql, fields: 'summary,status,resolution,updated', maxResults: String(limit) }, signal));
      return raw.issues.slice(0, limit).map((issue): KnowledgeIssueHit => ({
        key: issue.key, summary: issue.fields?.summary ?? '', status: issue.fields?.status?.name ?? '',
        resolution: issue.fields?.resolution?.name ?? null, updated: issue.fields?.updated ?? '',
      }));
    },

    async searchPages(input, signal) {
      const limit = limitOf(input.limit);
      const query = text(input.text, 'Search text');
      for (const space of input.spaces) if (!SPACE_KEY.test(space)) throw invalid('Space key');
      for (const id of input.ancestors) numericId(id, 'Page id');
      const scopes: string[] = [];
      if (input.spaces.length) scopes.push(`space in (${input.spaces.map((s) => `"${cqlEscape(s)}"`).join(', ')})`);
      if (input.ancestors.length) scopes.push(`ancestor in (${input.ancestors.join(', ')})`);
      if (!scopes.length) return [];
      const cql = `type = page AND text ~ "${cqlEscape(query)}" AND (${scopes.join(' OR ')})`;
      const raw = parse(cqlSchema, await wiki('/wiki/rest/api/search', { cql, limit: String(limit), expand: 'content.space,content.version' }, signal));
      return raw.results.slice(0, limit).flatMap((item): KnowledgePageHit[] => {
        const id = item.content?.id;
        if (!id) return [];
        return [{ id, title: item.content?.title ?? item.title ?? '', space_key: spaceOf(item), excerpt: excerptText(item.excerpt ?? ''), updated: item.content?.version?.when ?? item.lastModified ?? '' }];
      });
    },

    async getPage(pageId, signal) {
      numericId(pageId, 'Page id');
      const raw = parse(pageSchema, await wiki(`/wiki/rest/api/content/${encodeURIComponent(pageId)}`, { expand: 'body.storage,space,ancestors,version' }, signal));
      if (raw.id !== pageId) throw safeError('UPSTREAM', 'Atlassian returned a different page than requested');
      return {
        id: raw.id, title: raw.title ?? '', space_key: raw.space?.key ?? '', ancestor_ids: (raw.ancestors ?? []).map((a) => a.id),
        updated: raw.version?.when ?? '', body: storageToText(raw.body?.storage?.value ?? ''),
      } as KnowledgePage;
    },

    async getPageChildren(pageId, limit, signal) {
      numericId(pageId, 'Page id');
      limitOf(limit);
      const raw = parse(childrenSchema, await wiki(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/page`, { limit: String(limit), expand: 'space,version' }, signal));
      return raw.results.slice(0, limit).map((c): KnowledgePageHit => ({ id: c.id, title: c.title ?? '', space_key: c.space?.key ?? '', excerpt: '', updated: c.version?.when ?? '' }));
    },
  };
}
