import { parseFragment } from 'parse5';
import { z } from 'zod';
import { createKnowledgeReads } from './knowledge.js';
import {
  buildIndexJql, indexCommentPageSchema, INDEX_ISSUE_FIELDS, normalizeIdRow, normalizeIndexedComment, normalizeIndexedIssue, parseSearchPage, validateNextPageToken,
} from './index-sync.js';
import { defaultSleep, requestJson, safeError, siteUrl, type FetchLike, type Sleep } from './http.js';
import {
  AutosError, parseJdkCell, parseTomcatCell, issueSnapshotSchema, configSectionSchemas, projectMappingSchema, precedentResultSchema, savedFilterSchema,
  type AtlassianReadPort, type AutosConfig, type IndexedComment, type IndexedIssue, type KnowledgeReadPort, type IssueSnapshot, type PrecedentReadPort,
  type PrecedentResult, type ProjectMapping, type SavedFilter,
} from '@autos/contracts';

type JiraCredentials = { username: string; token: string };
type Credentials = { jira: JiraCredentials; confluence: JiraCredentials; bitbucketToken?: string };
export interface AtlassianOptions {
  config: AutosConfig;
  credentials: Credentials;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: Sleep;
  requestTimeoutMs?: number;
  maxRetries?: number;
  precedentSearch?: (issue: IssueSnapshot, mapping: ProjectMapping, signal?: AbortSignal) => Promise<unknown>;
}

const objectSchema = z.record(z.string(), z.unknown());
const filterResponseSchema = z.object({ id: z.union([z.string(), z.number()]), name: z.string(), jql: z.string().min(1) });
const searchResponseSchema = z.object({ issues: z.array(z.unknown()), nextPageToken: z.string().optional(), isLast: z.boolean().optional() });
const commentPageSchema = z.object({ comments: z.array(z.unknown()), startAt: z.number().int().nonnegative().optional(), maxResults: z.number().int().positive().optional(), total: z.number().int().nonnegative().optional() });
const issueResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), key: z.string(), self: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});
const pageResponseSchema = z.object({ id: z.union([z.string(), z.number()]), version: z.object({ number: z.number().int().positive() }), body: z.object({ storage: z.object({ value: z.string() }).optional() }).optional() });
const commentSchema = z.object({ id: z.union([z.string(), z.number()]), body: z.unknown() });
const bbCommitPageSchema = z.object({ values: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/i), message: z.string() })), next: z.string().optional() });
const MAX_DIFF_CHARS = 500_000;
const MAX_COMMIT_PAGES = 20;

const readTimeout = 20_000;
const maxRetriesDefault = 3;
const pageSize = 100;
const maxPages = 10_000;

function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\u0000-\u001f]/g, ' ');
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid response');
  return parsed.data;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (record.type === 'hardBreak') return '\n';
  const content = Array.isArray(record.content) ? record.content.map(plainText).join('') : '';
  if (record.type === 'paragraph' || record.type === 'heading' || record.type === 'listItem') return `${content}\n`;
  if (record.type === 'mention' && typeof record.attrs === 'object' && record.attrs) {
    const text = nonEmpty((record.attrs as Record<string, unknown>).text);
    return text ?? '';
  }
  return content;
}

function toIso(value: unknown, fallback: Date): string {
  if (typeof value !== 'string' || !value.trim()) return fallback.toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw safeError('UPSTREAM', 'Atlassian returned an invalid timestamp');
  return new Date(timestamp).toISOString();
}

function normalizeIssue(value: unknown, fetchedAt: Date, site: string, criteriaFields: string[], comments: IssueSnapshot['comments'] = []): IssueSnapshot {
  const root = issueResponseSchema.safeParse(value);
  if (!root.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid issue');
  const fields = root.data.fields;
  const project = asRecord(fields.project);
  const issueType = asRecord(fields.issuetype);
  const status = asRecord(fields.status);
  const projectKey = nonEmpty(project.key);
  const summary = nonEmpty(fields.summary);
  const typeName = nonEmpty(issueType.name);
  const statusName = nonEmpty(status.name);
  if (!projectKey || !summary || !typeName || !statusName) throw safeError('UPSTREAM', 'Atlassian returned an incomplete issue');
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks : [];
  const linkedKeys = new Set<string>();
  for (const item of links) {
    const link = asRecord(item);
    for (const direction of ['inwardIssue', 'outwardIssue']) {
      if (link[direction]) {
        const linked = asRecord(link[direction]);
        const key = nonEmpty(linked.key);
        if (key) linkedKeys.add(key);
      }
    }
  }
  const components = Array.isArray(fields.components) ? fields.components.map((component) => nonEmpty(asRecord(component).name)).filter((s): s is string => !!s) : [];
  const ac = criteriaFields.map((field) => fields[field]).find((field) => field !== undefined && field !== null);
  const criteriaText = plainText(ac).trim();
  const data = {
    key: root.data.key,
    project_key: projectKey,
    summary,
    description: plainText(fields.description).trim(),
    acceptance_criteria: criteriaText ? criteriaText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
    issue_type: typeName,
    status: statusName,
    updated_at: toIso(fields.updated, fetchedAt),
    fetched_at: fetchedAt.toISOString(),
    comments,
    linked_issue_keys: [...linkedKeys],
    components,
    // Build a credential-free browser URL; never trust the upstream `self` field.
    url: new URL(`/browse/${encodeURIComponent(root.data.key)}`, site).toString(),
  };
  const parsed = issueSnapshotSchema.safeParse(data);
  if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian issue did not match the supported schema');
  return parsed.data;
}

function normalizeCellText(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? '';
  if (node.nodeName === 'br') return '\n';
  const content = (node.childNodes ?? []).map(normalizeCellText).join('');
  return ['p', 'div', 'li'].includes(node.nodeName) ? `${content}\n` : content;
}
interface HtmlNode { nodeName: string; value?: string; childNodes?: HtmlNode[]; tagName?: string; attrs?: { name: string; value: string }[] }
function descend(node: HtmlNode, name: string): HtmlNode[] {
  const output: HtmlNode[] = [];
  if (node.nodeName === name) output.push(node);
  for (const child of node.childNodes ?? []) output.push(...descend(child, name));
  return output;
}
export interface BranchMapProblem { project_key: string; reason: string }
export interface BranchMapReport {
  mappings: ProjectMapping[];
  ignored_rows: number;
  invalid_projects: BranchMapProblem[];
  page_version: number;
}

// Table structure errors throw MAPPING (fail closed for everything). Row problems are scoped:
// rows for projects outside jira.allowed_projects are ignored and counted; a bad row for an
// allowed project only invalidates that project (reported in invalid_projects).
function parseBranchMap(html: string, pageId: string, version: number, fetchedAt: Date, config: AutosConfig): BranchMapReport {
  const root = parseFragment(html) as unknown as HtmlNode;
  const tables = descend(root, 'table');
  const expected = ['project key', 'bitbucket workspace', 'repository slug', 'development branch', 'sandbox branch', 'enabled'];
  const allowedHeaders = [...expected, 'jdk', 'tomcat'];
  const matches = tables.filter((table) => {
    const firstRow = descend(table, 'tr')[0];
    if (!firstRow) return false;
    const cells = (firstRow.childNodes ?? []).filter((node) => node.nodeName === 'th' || node.nodeName === 'td');
    const names = cells.map((cell) => normalizeCellText(cell).trim().toLowerCase().replace(/\s+/g, ' '));
    return expected.every((column) => names.includes(column));
  });
  if (matches.length !== 1) throw safeError('MAPPING', 'Branch map must contain exactly one table with the required columns');
  const rows = descend(matches[0]!, 'tr');
  const headerCells = (rows[0]!.childNodes ?? []).filter((node) => node.nodeName === 'th' || node.nodeName === 'td');
  const headers = headerCells.map((cell) => normalizeCellText(cell).trim().toLowerCase().replace(/\s+/g, ' '));
  if (new Set(headers).size !== headers.length || headers.some((header) => !allowedHeaders.includes(header))) throw safeError('MAPPING', 'Branch map has duplicate or unsupported columns');
  const projectColumn = headers.indexOf('project key');
  const candidates = new Map<string, ProjectMapping[]>();
  const problems = new Map<string, string>();
  const problem = (project: string, reason: string): void => { if (!problems.has(project)) problems.set(project, reason); };
  let ignored = 0;
  for (const row of rows.slice(1)) {
    const cells = (row.childNodes ?? []).filter((node) => node.nodeName === 'th' || node.nodeName === 'td');
    const raw = cells.map((cell) => normalizeCellText(cell).trim());
    if (!raw.some(Boolean)) continue;
    const project = (raw[projectColumn] ?? '').toUpperCase();
    if (!config.jira.allowed_projects.includes(project)) { ignored += 1; continue; }
    if (raw.length !== headers.length) { problem(project, 'Branch map row for this project is malformed (wrong number of cells)'); continue; }
    const value = (header: string): string => raw[headers.indexOf(header)] ?? '';
    const enabledCell = value('enabled').toLowerCase();
    if (!['true', 'false', 'yes', 'no', 'enabled', 'disabled'].includes(enabledCell)) { problem(project, 'Branch map Enabled value for this project must be an explicit boolean'); continue; }
    const enabled = enabledCell === 'true' || enabledCell === 'yes' || enabledCell === 'enabled';
    const workspace = value('bitbucket workspace');
    const repositorySlug = value('repository slug');
    const exactAllowed = config.bitbucket.allowed_repositories.filter((repository) => repository.workspace === workspace && repository.repository_slug === repositorySlug);
    if (exactAllowed.length !== 1) { problem(project, 'Branch map repository for this project is not an exact configured allowlist entry'); continue; }
    const jdk = parseJdkCell(value('jdk'));
    if (jdk === undefined) { problem(project, 'Branch map JDK value for this project is not recognized (use a major version such as 21)'); continue; }
    const tomcat = parseTomcatCell(value('tomcat'));
    if (tomcat === undefined) { problem(project, 'Branch map Tomcat value for this project is not recognized (use a full version such as 11.0.24)'); continue; }
    const parsed = projectMappingSchema.safeParse({
      project_key: project, workspace, repository_slug: repositorySlug,
      development_branch: value('development branch'), sandbox_branch: value('sandbox branch') || null,
      enabled, jdk, tomcat, source: { page_id: pageId, version, fetched_at: fetchedAt.toISOString() },
    });
    if (!parsed.success) { problem(project, 'Branch map row for this project is invalid'); continue; }
    candidates.set(project, [...(candidates.get(project) ?? []), parsed.data]);
  }
  const mappings: ProjectMapping[] = [];
  for (const [project, list] of candidates) {
    if (problems.has(project)) continue;
    if (list.length > 1) { problem(project, 'Branch map contains duplicate rows for this project'); continue; }
    if (!list[0]!.enabled) problem(project, 'Project is disabled in the branch map');
    mappings.push(list[0]!);
  }
  return { mappings, ignored_rows: ignored, invalid_projects: [...problems].map(([project_key, reason]) => ({ project_key, reason })), page_version: version };
}

export class AtlassianClient implements AtlassianReadPort, KnowledgeReadPort {
  private readonly config: AutosConfig;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: Sleep;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly jiraAuth: string;
  private readonly confluenceAuth: string;
  readonly precedents: PrecedentReadPort;
  private readonly knowledge: KnowledgeReadPort;

  constructor(private readonly options: AtlassianOptions) {
    // Defense in depth: re-check the sections this client uses (the whole parsed config is resolved output, not input).
    for (const section of ['jira', 'confluence', 'bitbucket', 'jobs'] as const) {
      if (!configSectionSchemas[section].safeParse(options.config?.[section]).success) throw safeError('INVALID_CONFIG', `Invalid configuration fields: ${section}`);
    }
    this.config = options.config;
    if (!Number.isInteger(options.maxRetries ?? maxRetriesDefault) || (options.maxRetries ?? maxRetriesDefault) < 0 ||
        !Number.isInteger(options.requestTimeoutMs ?? readTimeout) || (options.requestTimeoutMs ?? readTimeout) < 1) {
      throw safeError('INVALID_INPUT', 'Atlassian client timeout and retry settings are invalid');
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.requestTimeoutMs ?? readTimeout;
    this.retries = options.maxRetries ?? maxRetriesDefault;
    this.jiraAuth = this.basic(options.credentials.jira);
    this.confluenceAuth = this.basic(options.credentials.confluence);
    this.knowledge = createKnowledgeReads({
      jira: { site: this.config.jira.site_url, auth: this.jiraAuth }, confluence: { site: this.config.confluence.site_url, auth: this.confluenceAuth },
      getJson: (site, path, auth, query, signal) => this.getJson(site, path, auth, query, signal),
      getBytes: (site, path, auth, query, maxBytes, signal) => this.getBytes(site, path, auth, query, maxBytes, signal),
      plainText, escapeJql, safeError,
    });
    this.precedents = { findPrecedents: async (issue, mapping, signal) => {
      if (!this.config.jobs.similar_tickets.enabled) return { outcome: 'DISABLED', items: [], disabled_reason: 'CONFIG_DISABLED' };
      if (options.precedentSearch) {
        const result = await options.precedentSearch(issue, mapping, signal);
        const parsed = precedentResultSchema.safeParse(result);
        if (!parsed.success || parsed.data.items.length > this.config.jobs.similar_tickets.max_candidates) throw safeError('UPSTREAM', 'Precedent source returned invalid evidence');
        this.assertSafePrecedents(parsed.data.items);
        return parsed.data;
      }
      if (!options.credentials.bitbucketToken) return { outcome: 'DISABLED', items: [], disabled_reason: 'MISSING_CREDENTIALS' };
      const result = await this.findHistoricalPrecedents(issue, mapping, options.credentials.bitbucketToken, signal);
      const parsed = precedentResultSchema.safeParse(result);
      if (!parsed.success) throw safeError('UPSTREAM', 'Precedent source returned invalid evidence');
      if (parsed.data.items.length > this.config.jobs.similar_tickets.max_candidates) throw safeError('UPSTREAM', 'Precedent source exceeded the configured result limit');
      this.assertSafePrecedents(parsed.data.items);
      return parsed.data;
    } };
  }

  private assertSafePrecedents(items: PrecedentResult['items']): void {
    for (const item of items) {
        const issueUrl = new URL(item.issue_url);
        const evidenceUrl = new URL(item.evidence_url);
        const expectedIssueUrl = new URL(`/browse/${encodeURIComponent(item.issue_key)}`, this.config.jira.site_url).toString();
        const allowedRepo = this.config.bitbucket.allowed_repositories.some((repository) => {
          const repoPath = `/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repository_slug)}`;
          return evidenceUrl.origin === 'https://bitbucket.org' && evidenceUrl.pathname === `${repoPath}/commits/${item.commit_sha}`;
        });
        if (issueUrl.toString() !== expectedIssueUrl || issueUrl.username || issueUrl.password || issueUrl.search || issueUrl.hash ||
            evidenceUrl.protocol !== 'https:' || evidenceUrl.username || evidenceUrl.password || evidenceUrl.search || evidenceUrl.hash || !allowedRepo) {
          throw safeError('UPSTREAM', 'Precedent source returned an unsafe evidence URL');
        }
    }
  }

  private async searchCandidateKeys(jql: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    const keys = new Set<string>();
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < Math.min(maxPages, 10) && keys.size < limit; page += 1) {
      const query: Record<string, string> = { jql, maxResults: String(Math.min(pageSize, limit - keys.size)), fields: 'key' };
      if (token) query.nextPageToken = token;
      const raw = await this.getJson(this.config.jira.site_url, '/rest/api/3/search/jql', this.jiraAuth, query, signal);
      const parsed = searchResponseSchema.safeParse(raw);
      if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid precedent search page');
      for (const value of parsed.data.issues) {
        const row = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9]\d*$/) }).safeParse(value);
        if (row.success) keys.add(row.data.key);
        if (keys.size >= limit) break;
      }
      const next = parsed.data.nextPageToken;
      if (parsed.data.isLast === false && !next) throw safeError('UPSTREAM', 'Atlassian indicated more precedent results without a continuation token');
      if (!next || parsed.data.isLast === true) break;
      if (seen.has(next)) throw safeError('UPSTREAM', 'Atlassian repeated a precedent pagination token');
      seen.add(next); token = next;
    }
    if (token && keys.size < limit && seen.size >= 10) throw safeError('UPSTREAM', 'Atlassian precedent search exceeded the pagination safety limit');
    return [...keys];
  }

  private async findHistoricalPrecedents(issue: IssueSnapshot, mapping: ProjectMapping, token: string, signal?: AbortSignal): Promise<PrecedentResult> {
    if (!mapping.enabled || mapping.project_key !== issue.project_key || !this.config.bitbucket.allowed_repositories.some((repo) => repo.workspace === mapping.workspace && repo.repository_slug === mapping.repository_slug)) {
      throw safeError('MAPPING', 'Precedent repository mapping is disabled or outside the configured allowlist');
    }
    if (!token.trim() || /[\r\n]/.test(token)) throw safeError('AUTH', 'Bitbucket read credential is invalid');
    const limit = Math.min(5, this.config.jobs.similar_tickets.max_candidates);
    const candidates: string[] = [];
    const add = (keys: string[]) => { for (const key of keys) if (key !== issue.key && !candidates.includes(key) && candidates.length < limit) candidates.push(key); };
    if (issue.linked_issue_keys.length) {
      const keys = issue.linked_issue_keys.map((key) => `"${escapeJql(key)}"`).join(', ');
      add(await this.searchCandidateKeys(`key in (${keys}) AND resolution IS NOT EMPTY`, limit, signal));
    }
    if (candidates.length < limit) {
      for (const component of issue.components.slice(0, 3)) {
        add(await this.searchCandidateKeys(`project = ${issue.project_key} AND issuetype = Bug AND resolution IS NOT EMPTY AND component = "${escapeJql(component)}" ORDER BY updated DESC`, limit - candidates.length, signal));
        if (candidates.length >= limit) break;
      }
    }
    if (candidates.length < limit) {
      const stopWords = new Set(['that', 'this', 'with', 'from', 'when', 'then', 'have', 'will', 'into', 'after', 'before', 'does', 'should', 'could']);
      const keywords = [...new Set(issue.summary.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])].filter((word) => !stopWords.has(word)).slice(0, 5);
      for (const keyword of keywords) {
        add(await this.searchCandidateKeys(`project = ${issue.project_key} AND issuetype = Bug AND resolution IS NOT EMPTY AND text ~ "${escapeJql(keyword)}" ORDER BY updated DESC`, limit - candidates.length, signal));
        if (candidates.length >= limit) break;
      }
    }
    if (!candidates.length) return { outcome: 'NO_MATCH', items: [] };

    const issueData = new Map<string, IssueSnapshot>();
    for (const key of candidates) issueData.set(key, await this.getIssue(key, signal));
    const repositoryPath = `/2.0/repositories/${encodeURIComponent(mapping.workspace)}/${encodeURIComponent(mapping.repository_slug)}/commits/${encodeURIComponent(mapping.development_branch)}`;
    const repoUrl = new URL(repositoryPath, 'https://api.bitbucket.org');
    repoUrl.searchParams.set('pagelen', '100');
    const byIssue = new Map<string, { hash: string; message: string }>();
    let pageUrl: URL | undefined = repoUrl;
    const expectedOrigin = 'https://api.bitbucket.org';
    const visitedCommitPages = new Set<string>();
    for (let page = 0; page < MAX_COMMIT_PAGES && pageUrl && byIssue.size < candidates.length; page += 1) {
      if (pageUrl.origin !== expectedOrigin || pageUrl.pathname !== repositoryPath || pageUrl.username || pageUrl.password || pageUrl.hash) throw safeError('UPSTREAM', 'Bitbucket returned an unsafe pagination URL');
      const pageIdentity = pageUrl.toString();
      if (visitedCommitPages.has(pageIdentity)) throw safeError('UPSTREAM', 'Bitbucket repeated a commit pagination URL');
      visitedCommitPages.add(pageIdentity);
      const raw = await this.getJson(pageUrl.origin, pageUrl.pathname, `Bearer ${token}`, Object.fromEntries(pageUrl.searchParams), signal);
      const parsed = bbCommitPageSchema.safeParse(raw);
      if (!parsed.success) throw safeError('UPSTREAM', 'Bitbucket returned invalid commit history');
      for (const commit of parsed.data.values) {
        for (const key of candidates) {
          if (!byIssue.has(key) && new RegExp(`(?:^|[^A-Z0-9])${key}(?:$|[^A-Z0-9])`, 'i').test(commit.message)) byIssue.set(key, commit);
        }
      }
      pageUrl = parsed.data.next ? new URL(parsed.data.next) : undefined;
    }
    const searchTruncated = !!pageUrl && byIssue.size < candidates.length;
    const found: PrecedentResult['items'] = [];
    for (const key of candidates) {
      const commit = byIssue.get(key);
      const historic = issueData.get(key);
      if (!commit || !historic) continue;
      const diffUrl = new URL(`/2.0/repositories/${encodeURIComponent(mapping.workspace)}/${encodeURIComponent(mapping.repository_slug)}/diff/${commit.hash}`, expectedOrigin);
      const diff = await this.getText(diffUrl, `Bearer ${token}`, MAX_DIFF_CHARS, signal);
      if (!diff.trim()) continue;
      found.push({
        issue_key: key,
        issue_url: new URL(`/browse/${encodeURIComponent(key)}`, this.config.jira.site_url).toString(),
        reason: issue.linked_issue_keys.includes(key) ? 'Resolved issue linked from the current ticket; a configured-repository commit references its key.' : 'Resolved issue matched a shared component or summary term; a configured-repository commit references its key.',
        commit_sha: commit.hash.toLowerCase(),
        evidence_url: `https://bitbucket.org/${encodeURIComponent(mapping.workspace)}/${encodeURIComponent(mapping.repository_slug)}/commits/${commit.hash.toLowerCase()}`,
        diff,
        caveats: [
          'Historical similarity is evidence for review, not a proposed fix or proof of applicability.',
          ...(searchTruncated ? ['Commit history scan reached its configured page limit; additional matches may exist.'] : []),
        ],
      });
    }
    return { outcome: found.length ? 'FOUND' : 'NO_MATCH', items: found, ...(searchTruncated ? { search_truncated: true } : {}) };
  }

  private async getText(url: URL, auth: string, maxChars: number, signal?: AbortSignal, attempt = 0): Promise<string> {
    if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
    if (url.origin !== 'https://api.bitbucket.org') throw safeError('INTERNAL', 'Refused an unsafe Bitbucket URL');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortParent = () => controller.abort();
    signal?.addEventListener('abort', abortParent, { once: true });
    try {
      const response = await this.fetcher(url, { method: 'GET', headers: { Accept: 'text/plain', Authorization: auth }, redirect: 'manual', signal: controller.signal });
      if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
      if (controller.signal.aborted) throw safeError('TIMEOUT', 'Bitbucket request timed out', true);
      if (response.status >= 300 && response.status < 400) throw safeError('FORBIDDEN', 'Bitbucket redirected a read request; redirect refused');
      if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
        const delay = Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1000)) : Math.min(5_000, 200 * 2 ** attempt);
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(delay, signal);
        return this.getText(url, auth, maxChars, signal, attempt + 1);
      }
      if (response.status === 401) throw safeError('AUTH', 'Bitbucket authentication failed');
      if (response.status === 403) throw safeError('FORBIDDEN', 'Bitbucket denied access to the configured repository');
      if (response.status === 404) throw safeError('NOT_FOUND', 'Bitbucket commit evidence was not found');
      if (!response.ok) throw safeError('UPSTREAM', 'Bitbucket diff request failed', response.status >= 500);
      const reader = response.body?.getReader();
      if (!reader) {
        const text = (await response.text()).slice(0, maxChars);
        if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
        if (controller.signal.aborted) throw safeError('TIMEOUT', 'Bitbucket request timed out', true);
        return text;
      }
      const decoder = new TextDecoder(); let text = '';
      try {
        while (text.length <= maxChars) {
          if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
          const { done, value } = await reader.read();
          if (done) {
            if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
            if (controller.signal.aborted) throw safeError('TIMEOUT', 'Bitbucket request timed out', true);
            return text + decoder.decode();
          }
          text += decoder.decode(value, { stream: true });
        }
      } finally { await reader.cancel().catch(() => undefined); }
      throw safeError('UPSTREAM', 'Bitbucket diff exceeded the evidence size limit');
    } catch (error) {
      if (error instanceof AutosError) throw error;
      if (signal?.aborted) throw safeError('CANCELLED', 'Bitbucket request cancelled');
      if (controller.signal.aborted) throw safeError('TIMEOUT', 'Bitbucket request timed out', true);
      throw safeError('UPSTREAM', 'Bitbucket could not be reached', true);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abortParent); }
  }

  private basic(credentials: JiraCredentials): string {
    if (!credentials.username || !credentials.token || /[\r\n]/.test(credentials.username + credentials.token)) throw safeError('AUTH', 'Atlassian credentials are missing or invalid');
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}`;
  }

  private url(site: string, path: string, query?: Record<string, string>): URL {
    return siteUrl(site, path, query);
  }

  getIssueDetail: KnowledgeReadPort['getIssueDetail'] = (key, signal) => this.knowledge.getIssueDetail(key, signal);
  getIssueComments: KnowledgeReadPort['getIssueComments'] = (key, signal) => this.knowledge.getIssueComments(key, signal);
  getIssueAttachment: KnowledgeReadPort['getIssueAttachment'] = (key, id, max, signal) => this.knowledge.getIssueAttachment(key, id, max, signal);
  searchIssues: KnowledgeReadPort['searchIssues'] = (input, signal) => this.knowledge.searchIssues(input, signal);
  searchPages: KnowledgeReadPort['searchPages'] = (input, signal) => this.knowledge.searchPages(input, signal);
  getPage: KnowledgeReadPort['getPage'] = (id, signal) => this.knowledge.getPage(id, signal);
  getPageChildren: KnowledgeReadPort['getPageChildren'] = (id, limit, signal) => this.knowledge.getPageChildren(id, limit, signal);

  /** GET raw bytes (attachments). Refuses redirects, caps the body while streaming. Same retry/timeout handling as getJson. */
  private async getBytes(site: string, path: string, auth: string, query: Record<string, string>, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const url = this.url(site, path, query);
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const abortParent = () => controller.abort();
      signal?.addEventListener('abort', abortParent, { once: true });
      try {
        const response = await this.fetcher(url, { method: 'GET', headers: { Accept: '*/*', Authorization: auth }, redirect: 'manual', signal: controller.signal });
        if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
        if (response.status >= 300 && response.status < 400) throw safeError('FORBIDDEN', 'Atlassian redirected a read request; redirect refused');
        if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
          await response.body?.cancel().catch(() => undefined);
          await this.sleep(Number.isFinite(seconds) ? Math.min(30_000, seconds * 1000) : Math.min(5_000, 200 * 2 ** attempt), signal);
          continue;
        }
        if (response.status === 401) throw safeError('AUTH', 'Atlassian authentication failed; use a classic (unscoped) API token for this site');
        if (response.status === 403) throw safeError('FORBIDDEN', 'Atlassian denied access to the requested resource');
        if (response.status === 404) throw safeError('NOT_FOUND', 'Atlassian resource was not found');
        if (response.status === 429) throw safeError('RATE_LIMIT', 'Atlassian rate limit persisted after retries', true);
        if (!response.ok) throw safeError('UPSTREAM', 'Atlassian read request failed', response.status >= 500);
        const reader = response.body?.getReader();
        if (!reader) throw safeError('UPSTREAM', 'Atlassian returned an empty response body');
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw safeError('INVALID_INPUT', 'Attachment exceeds the size limit');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
        if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return data;
      } catch (error) {
        if (error instanceof AutosError) throw error;
        if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
        if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
        throw safeError('UPSTREAM', 'Atlassian could not be reached', true);
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abortParent); }
    }
  }

  private async getJson(site: string, path: string, auth: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const url = this.url(site, path, query);
    return (await requestJson({ fetcher: this.fetcher, sleep: this.sleep, timeoutMs: this.timeoutMs, retries: this.retries, url, auth, signal })).json;
  }

  /**
   * One page of issues for the precedent index (read-only). JQL is built from validated project keys and dates only.
   * Security-level issues and visibility-restricted comments are never returned; malformed rows are skipped and counted.
   */
  async searchIssuesForIndex(input: { projects: string[]; updatedSince?: Date; windowWeeks: number; nextPageToken?: string }, signal?: AbortSignal): Promise<{
    issues: IndexedIssue[]; nextPageToken?: string; skipped_restricted: number; skipped_invalid: number;
  }> {
    const jql = buildIndexJql(input);
    validateNextPageToken(input.nextPageToken);
    const query: Record<string, string> = { jql, maxResults: String(pageSize), fields: INDEX_ISSUE_FIELDS.join(',') };
    if (input.nextPageToken) query.nextPageToken = input.nextPageToken;
    const raw = await this.getJson(this.config.jira.site_url, '/rest/api/3/search/jql', this.jiraAuth, query, signal);
    const page = parseSearchPage(raw, input.nextPageToken);
    const projects = new Set(input.projects);
    const issues: IndexedIssue[] = [];
    let restricted = 0; let invalid = 0;
    for (const row of page.issues) {
      const result = normalizeIndexedIssue(row, projects, plainText);
      if (result.kind === 'issue') issues.push(result.issue);
      else if (result.kind === 'restricted') restricted += 1;
      else invalid += 1;
    }
    return { issues, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}), skipped_restricted: restricted, skipped_invalid: invalid };
  }

  /**
   * One page of comments for an indexed issue, used only when the search page reported comments_truncated.
   * Named differently from KnowledgeReadPort.getIssueComments (agent tool, by key) on purpose.
   */
  async getIndexComments(issueId: string, startAt: number, signal?: AbortSignal): Promise<{ comments: IndexedComment[]; next_start_at: number | null; skipped_invalid: number }> {
    if (typeof issueId !== 'string' || !/^[0-9]{1,20}$/.test(issueId)) throw safeError('INVALID_INPUT', 'Issue id is invalid');
    if (!Number.isInteger(startAt) || startAt < 0 || startAt > 1_000_000) throw safeError('INVALID_INPUT', 'Comment offset is invalid');
    const raw = await this.getJson(this.config.jira.site_url, `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, this.jiraAuth,
      { startAt: String(startAt), maxResults: String(pageSize), orderBy: 'created' }, signal);
    const page = indexCommentPageSchema.safeParse(raw);
    if (!page.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid comments page');
    const comments: IndexedComment[] = [];
    let invalid = 0;
    for (const entry of page.data.comments) {
      try {
        const comment = normalizeIndexedComment(entry, plainText);
        if (comment) comments.push(comment);
      } catch { invalid += 1; }
    }
    const next = startAt + page.data.comments.length;
    const more = page.data.comments.length > 0 && (page.data.total === undefined ? page.data.comments.length >= pageSize : next < page.data.total);
    return { comments, next_start_at: more ? next : null, skipped_invalid: invalid };
  }

  /** One page of `{id, key, updated}` for reconciliation. Any malformed row fails the page (a skipped id would look deleted). */
  async listIssueIds(input: { projects: string[]; windowWeeks: number; nextPageToken?: string }, signal?: AbortSignal): Promise<{ ids: { id: string; key: string; updated: string }[]; nextPageToken?: string }> {
    const jql = buildIndexJql({ projects: input.projects, windowWeeks: input.windowWeeks });
    validateNextPageToken(input.nextPageToken);
    const query: Record<string, string> = { jql, maxResults: String(pageSize), fields: 'id,key,updated' };
    if (input.nextPageToken) query.nextPageToken = input.nextPageToken;
    const raw = await this.getJson(this.config.jira.site_url, '/rest/api/3/search/jql', this.jiraAuth, query, signal);
    const page = parseSearchPage(raw, input.nextPageToken);
    return { ids: page.issues.map(normalizeIdRow), ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  async getSavedFilter(filterId: string, signal?: AbortSignal): Promise<SavedFilter> {
    if (!/^\d+$/.test(filterId) || filterId !== this.config.jira.saved_filter_id) throw safeError('FORBIDDEN', 'Only the configured Jira filter may be read');
    const json = await this.getJson(this.config.jira.site_url, `/rest/api/3/filter/${encodeURIComponent(filterId)}`, this.jiraAuth, {}, signal);
    const upstream = filterResponseSchema.safeParse(json);
    if (!upstream.success || String(upstream.data.id) !== filterId) throw safeError('UPSTREAM', 'Atlassian returned an invalid filter');
    const parsed = savedFilterSchema.safeParse({ id: String(upstream.data.id), name: upstream.data.name, jql: upstream.data.jql });
    if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian filter did not match the supported schema');
    return parsed.data;
  }

  async listIssues(jql: string, signal?: AbortSignal): Promise<IssueSnapshot[]> {
    const keys = await this.listIssueKeys(jql, signal);
    const snapshots: IssueSnapshot[] = [];
    for (const key of keys) snapshots.push(await this.getIssue(key, signal));
    return snapshots;
  }

  async listIssueKeys(jql: string, signal?: AbortSignal): Promise<string[]> {
    if (typeof jql !== 'string' || !jql.trim() || jql.length > 20_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(jql)) throw safeError('INVALID_INPUT', 'JQL input is invalid');
    const keys: string[] = [];
    const seenIssues = new Set<string>();
    let nextPageToken: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, string> = { jql, maxResults: String(pageSize), fields: 'key' };
      if (nextPageToken) query.nextPageToken = nextPageToken;
      const raw = await this.getJson(this.config.jira.site_url, '/rest/api/3/search/jql', this.jiraAuth, query, signal);
      const parsed = searchResponseSchema.safeParse(raw);
      if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid search page');
      for (const item of parsed.data.issues) {
        const key = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9]\d*$/) }).safeParse(item);
        if (!key.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid search issue key');
        if (!seenIssues.has(key.data.key)) { seenIssues.add(key.data.key); keys.push(key.data.key); }
      }
      const next = parsed.data.nextPageToken;
      if (parsed.data.isLast === false && !next) throw safeError('UPSTREAM', 'Atlassian indicated more results without a continuation token');
      if (parsed.data.isLast === true || !next) {
        return keys;
      }
      if (seenTokens.has(next)) throw safeError('UPSTREAM', 'Atlassian repeated a pagination token');
      seenTokens.add(next);
      nextPageToken = next;
    }
    throw safeError('UPSTREAM', 'Atlassian search exceeded the pagination safety limit');
  }

  private issueFields(): string {
    return ['summary', 'description', 'project', 'issuetype', 'status', 'updated', 'components', 'issuelinks', ...this.config.jira.acceptance_criteria_fields].join(',');
  }

  async getIssue(issueKey: string, signal?: AbortSignal): Promise<IssueSnapshot> {
    if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(issueKey)) throw safeError('INVALID_INPUT', 'Issue key is invalid');
    const site = this.config.jira.site_url;
    const issueRaw = await this.getJson(site, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, this.jiraAuth, { fields: this.issueFields() }, signal);
    const issue = issueResponseSchema.safeParse(issueRaw);
    if (!issue.success || issue.data.key !== issueKey) throw safeError('UPSTREAM', 'Atlassian returned a different issue than requested');
    const project = nonEmpty(asRecord(issue.data.fields.project).key);
    if (!project || !this.config.jira.allowed_projects.includes(project)) throw safeError('FORBIDDEN', 'Issue project is outside the configured allowlist');
    const comments: IssueSnapshot['comments'] = [];
    let startAt = 0;
    let total: number | undefined;
    let completed = false;
    for (let page = 0; page < maxPages; page += 1) {
      const raw = await this.getJson(site, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, this.jiraAuth, { startAt: String(startAt), maxResults: String(pageSize) }, signal);
      const parsed = commentPageSchema.safeParse(raw);
      if (!parsed.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid comments page');
      total = parsed.data.total ?? total;
      if (parsed.data.comments.length === 0) { completed = true; break; }
      for (const entry of parsed.data.comments) {
        const comment = commentSchema.safeParse(entry);
        if (!comment.success) throw safeError('UPSTREAM', 'Atlassian returned an invalid comment');
        comments.push({ id: String(comment.data.id), body: plainText(comment.data.body).trim() });
      }
      startAt += parsed.data.comments.length;
      if (total !== undefined && startAt >= total) { completed = true; break; }
      if (parsed.data.comments.length < (parsed.data.maxResults ?? pageSize)) { completed = true; break; }
    }
    if (!completed) throw safeError('UPSTREAM', 'Atlassian comments exceeded the pagination safety limit');
    if (total !== undefined && comments.length < total) throw safeError('UPSTREAM', 'Atlassian comments pagination was incomplete');
    const snapshot = normalizeIssue(issueRaw, this.now(), site, this.config.jira.acceptance_criteria_fields, comments);
    if (!this.config.jira.allowed_projects.includes(snapshot.project_key)) throw safeError('FORBIDDEN', 'Issue project is outside the configured allowlist');
    return snapshot;
  }

  async getBranchMap(pageId: string, signal?: AbortSignal): Promise<ProjectMapping[]> {
    return (await this.getBranchMapReport(pageId, signal)).mappings;
  }

  async getBranchMapReport(pageId: string, signal?: AbortSignal): Promise<BranchMapReport> {
    if (!/^\d+$/.test(pageId) || pageId !== this.config.confluence.branch_map_page_id) throw safeError('FORBIDDEN', 'Only the configured Confluence page may be read');
    const raw = await this.getJson(this.config.confluence.site_url, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, this.confluenceAuth, { 'body-format': 'storage' }, signal);
    const page = pageResponseSchema.safeParse(raw);
    if (!page.success || String(page.data.id) !== pageId || !page.data.body?.storage?.value) throw safeError('MAPPING', 'Configured Confluence page is missing a storage-format mapping table');
    return parseBranchMap(page.data.body.storage.value, pageId, page.data.version.number, this.now(), this.config);
  }

  async resolveProjectMapping(projectKey: string, signal?: AbortSignal): Promise<ProjectMapping> {
    if (!/^[A-Z][A-Z0-9]*$/.test(projectKey) || !this.config.jira.allowed_projects.includes(projectKey)) {
      throw safeError('FORBIDDEN', 'Project is outside the configured allowlist');
    }
    const report = await this.getBranchMapReport(this.config.confluence.branch_map_page_id, signal);
    const invalid = report.invalid_projects.find((item) => item.project_key === projectKey);
    if (invalid) throw safeError('MAPPING', invalid.reason);
    const matches = report.mappings.filter((mapping) => mapping.project_key === projectKey);
    if (!matches.length) throw safeError('MAPPING', 'No branch mapping exists for the requested project');
    if (matches.length !== 1) throw safeError('MAPPING', 'Branch mapping is ambiguous for the requested project');
    if (!matches[0]!.enabled) throw safeError('MAPPING', 'Project is disabled in the branch map');
    return matches[0]!;
  }
}

export { ConfluenceDraftWriter, renderFixDocumentStorage, fixDocumentTitle, type ConfluenceDraftWriterOptions, type FixDocumentInput } from './drafts.js';

export function createAtlassianClient(options: AtlassianOptions): AtlassianClient {
  return new AtlassianClient(options);
}

