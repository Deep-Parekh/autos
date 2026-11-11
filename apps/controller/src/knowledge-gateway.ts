import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  AutosError, KNOWLEDGE_TOOL_INPUTS, knowledgeToolNameSchema,
  type AgentRole, type AutosConfig, type KnowledgeAuditEntry, type KnowledgeCallResponse, type KnowledgeContent, type KnowledgeConfig,
  type KnowledgeReadPort, type KnowledgeSession, type KnowledgeSessionPort, type KnowledgeSessionSummary, type KnowledgeToolName,
} from '@autos/contracts';

/**
 * Knowledge gateway: the only path from an agent to Jira/Confluence (docs/atlassian-mcp-plan.md).
 *
 * Trust model: callers are agent containers holding a per-run token. Everything they send is untrusted. The gateway
 * validates input, enforces the allow-list and the budgets itself, composes every upstream query through the read-only
 * port, and never returns upstream error text. It has no write operation of any kind.
 */
export interface KnowledgeGatewayOptions {
  config: Pick<AutosConfig, 'jira' | 'confluence'> & { knowledge?: KnowledgeConfig | undefined };
  reads: KnowledgeReadPort;
  now?: () => number;
  /** Structured, content-free log lines (listener errors, rejected tokens). */
  log?: (record: Record<string, unknown>) => void;
}

type Failure = Extract<KnowledgeCallResponse, { ok: false }>;
type FailureCode = Failure['code'];
interface SessionState { job_id: string; issue_key: string; role: AgentRole; calls: number; chars: number; entries: KnowledgeAuditEntry[] }

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|sql|javascript|x-sh|x-www-form-urlencoded)\b)/i;
const TEXT_EXTENSION = /\.(?:txt|log|md|csv|tsv|json|xml|ya?ml|sql|properties|ini|conf|java|js|ts|jsx|tsx|html?|css|sh|py|out|err|trace)$/i;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 2_000_000;
/** An image counts as this many characters against the run budget (its base64 is not text the model reads). */
const IMAGE_BUDGET_CHARS = 20_000;
const MAX_BODY_BYTES = 16_384;
const CALL_TIMEOUT_MS = 45_000;
const MAX_AUDIT_ENTRIES = 1000;

class Refusal extends Error { constructor(readonly code: FailureCode, message: string) { super(message); } }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class KnowledgeGateway implements KnowledgeSessionPort {
  private readonly sessions = new Map<string, SessionState>();
  private readonly knowledge: KnowledgeConfig | undefined;
  private readonly now: () => number;
  private server: Server | undefined;
  private listening: Promise<void> | undefined;

  constructor(private readonly options: KnowledgeGatewayOptions) {
    this.knowledge = options.config.knowledge?.enabled ? options.config.knowledge : undefined;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean { return this.knowledge !== undefined; }
  private get projects(): string[] { return this.knowledge?.jira.projects ?? this.options.config.jira.allowed_projects; }

  open(scope: { job_id: string; issue_key: string; role: AgentRole }): KnowledgeSession | null {
    const knowledge = this.knowledge;
    if (!knowledge || !knowledge.roles.includes(scope.role)) return null;
    // The listener starts with the first session, so processes that never run a role (CLI commands) never bind the port.
    void this.listen().catch(() => undefined);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(hash(token), { ...scope, calls: 0, chars: 0, entries: [] });
    return { url: knowledge.gateway.advertise_url.replace(/\/$/, ''), token };
  }

  close(token: string): KnowledgeSessionSummary {
    const key = hash(token); const session = this.sessions.get(key);
    this.sessions.delete(key);
    return session ? { calls: session.calls, chars: session.chars, entries: session.entries } : { calls: 0, chars: 0, entries: [] };
  }

  /** Starts the HTTP listener (idempotent). Rejects when the address cannot be bound; tool calls then fail closed. */
  listen(): Promise<void> {
    const knowledge = this.knowledge;
    if (!knowledge) return Promise.resolve();
    this.listening ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req.method ?? '', req.url ?? '', req.headers.authorization, req).then((response) => {
          res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(response.body));
        }).catch(() => { res.statusCode = 500; res.end(JSON.stringify({ ok: false, code: 'UNAVAILABLE', message: 'The knowledge gateway failed' })); });
      });
      this.server = server; // set before binding so stop() also closes a listener that is still starting
      server.requestTimeout = 60_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
      server.once('error', (error) => { this.listening = undefined; if (this.server === server) this.server = undefined; this.options.log?.({ event: 'knowledge_gateway_listen_failed', code: (error as NodeJS.ErrnoException).code ?? 'ERROR' }); reject(new AutosError('UNAVAILABLE', 'The knowledge gateway could not bind its address')); });
      server.listen(knowledge.gateway.port, knowledge.gateway.listen_host, () => { server.unref(); resolve(); });
    });
    return this.listening;
  }

  async stop(): Promise<void> {
    const server = this.server; this.server = undefined; this.listening = undefined; this.sessions.clear();
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  /** The bound port (tests bind port 0-like ephemeral ports through config). */
  get port(): number | null { const address = this.server?.address(); return address && typeof address === 'object' ? address.port : null; }

  private async handle(method: string, url: string, authorization: string | undefined, body: AsyncIterable<Buffer>): Promise<{ status: number; body: KnowledgeCallResponse }> {
    const fail = (status: number, code: FailureCode, message: string) => ({ status, body: { ok: false as const, code, message } });
    const match = /^\/v1\/tools\/([a-z_]{1,40})$/.exec(url);
    if (method !== 'POST' || !match) return fail(404, 'NOT_FOUND', 'Unknown endpoint');
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization ?? '')?.[1];
    if (!token || !this.sessions.has(hash(token))) { this.options.log?.({ event: 'knowledge_gateway_unauthorized' }); return fail(401, 'UNAUTHORIZED', 'The knowledge session is not valid'); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of body) { size += chunk.length; if (size > MAX_BODY_BYTES) return fail(413, 'INVALID_INPUT', 'The request is too large'); chunks.push(chunk); }
    let input: unknown;
    try { input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return fail(400, 'INVALID_INPUT', 'The request is not valid JSON'); }
    const response = await this.call(token, match[1]!, input);
    return { status: response.ok ? 200 : response.code === 'UNAUTHORIZED' ? 401 : response.code === 'FORBIDDEN' ? 403 : response.code === 'NOT_FOUND' ? 404 : response.code === 'BUDGET' ? 429 : response.code === 'UNAVAILABLE' ? 503 : 400, body: response };
  }

  /** One tool call for a session token. Never throws; never returns upstream text in an error. */
  async call(token: string, toolName: string, untrustedInput: unknown): Promise<KnowledgeCallResponse> {
    const knowledge = this.knowledge; const session = this.sessions.get(hash(token));
    if (!knowledge || !session) return { ok: false, code: 'UNAUTHORIZED', message: 'The knowledge session is not valid' };
    const parsedName = knowledgeToolNameSchema.safeParse(toolName);
    if (!parsedName.success) return { ok: false, code: 'NOT_FOUND', message: 'Unknown tool' };
    const tool = parsedName.data; const started = this.now(); let target = '';
    const record = (outcome: KnowledgeAuditEntry['outcome'], chars: number) => {
      if (session.entries.length < MAX_AUDIT_ENTRIES) session.entries.push({ at: new Date(started).toISOString(), tool, target: target.slice(0, 80), outcome, chars, elapsed_ms: Math.max(0, Math.round(this.now() - started)) });
    };
    const refuse = (code: Exclude<FailureCode, 'UNAUTHORIZED'>, message: string): Failure => { record(code, 0); return { ok: false, code, message }; };
    session.calls += 1;
    if (session.calls > knowledge.limits.max_calls_per_run) return refuse('BUDGET', `This run's limit of ${knowledge.limits.max_calls_per_run} knowledge calls is used up; continue with what you have`);
    if (session.chars >= knowledge.limits.max_total_chars_per_run) return refuse('BUDGET', 'This run\'s knowledge reading budget is used up; continue with what you have');
    const input = KNOWLEDGE_TOOL_INPUTS[tool].safeParse(untrustedInput);
    if (!input.success) return refuse('INVALID_INPUT', `Invalid input for ${tool}: check the tool's parameters`);
    try {
      const result = await this.run(tool, input.data as Record<string, unknown>, knowledge, AbortSignal.timeout(CALL_TIMEOUT_MS), (value) => { target = value; });
      let truncated = false; let chars = 0;
      const remaining = knowledge.limits.max_total_chars_per_run - session.chars;
      const content = result.map((block): KnowledgeContent => {
        if (block.type === 'image') { chars += IMAGE_BUDGET_CHARS; return block; }
        const limit = Math.max(0, Math.min(knowledge.limits.max_result_chars, remaining - chars));
        const text = block.text.length > limit ? (truncated = true, block.text.slice(0, limit)) : block.text;
        chars += text.length; return { type: 'text', text };
      });
      session.chars += chars; record('OK', chars);
      return { ok: true, content, ...(truncated ? { truncated: true } : {}) };
    } catch (error) {
      if (error instanceof Refusal) return refuse(error.code as Exclude<FailureCode, 'UNAUTHORIZED'>, error.message);
      const code = error instanceof AutosError ? error.code : 'INTERNAL';
      if (code === 'NOT_FOUND') return refuse('NOT_FOUND', 'Not found in Jira/Confluence (or not visible to Autos)');
      if (code === 'INVALID_INPUT') return refuse('INVALID_INPUT', 'Jira/Confluence rejected the request (for example an attachment that is too large)');
      if (code === 'FORBIDDEN') return refuse('FORBIDDEN', 'Jira/Confluence denied access to this item');
      return refuse('UNAVAILABLE', 'Jira/Confluence could not be read right now');
    }
  }

  private requireProject(projectKey: string): void {
    if (!this.projects.includes(projectKey)) throw new Refusal('FORBIDDEN', `Jira project ${projectKey} is not on the knowledge allow-list`);
  }

  private pageAllowed(page: { id: string; space_key: string; ancestor_ids: string[] }, knowledge: KnowledgeConfig): boolean {
    const { spaces, pages } = knowledge.confluence;
    return spaces.some((space) => same(space, page.space_key)) || pages.includes(page.id) || page.ancestor_ids.some((id) => pages.includes(id));
  }

  /** A page ID, or a page URL on the configured Confluence site. */
  private pageId(reference: string): string {
    if (/^[0-9]{1,20}$/.test(reference)) return reference;
    let url: URL;
    try { url = new URL(reference); } catch { throw new Refusal('INVALID_INPUT', 'Give a numeric page ID or a page URL'); }
    if (url.origin !== new URL(this.options.config.confluence.site_url).origin) throw new Refusal('FORBIDDEN', 'Only pages on the configured Confluence site can be read');
    const id = /\/pages\/(?:viewpage\.action|edit-v2\/)?([0-9]{1,20})(?:\/|$)/.exec(url.pathname)?.[1] ?? /^[0-9]{1,20}$/.exec(url.searchParams.get('pageId') ?? '')?.[0];
    if (!id) throw new Refusal('INVALID_INPUT', 'The URL does not contain a page ID');
    return id;
  }

  private async run(tool: KnowledgeToolName, input: Record<string, unknown>, knowledge: KnowledgeConfig, signal: AbortSignal, setTarget: (value: string) => void): Promise<KnowledgeContent[]> {
    const reads = this.options.reads; const text = (value: string): KnowledgeContent[] => [{ type: 'text', text: value || '(empty)' }];
    const projectOf = (issueKey: string) => issueKey.slice(0, issueKey.lastIndexOf('-'));
    switch (tool) {
      case 'jira_get_issue': {
        const key = input.issue_key as string; setTarget(key); this.requireProject(projectOf(key));
        const issue = await reads.getIssueDetail(key, signal);
        return text([
          `${issue.key}: ${issue.summary}`,
          `Type: ${issue.issue_type} | Status: ${issue.status} | Resolution: ${issue.resolution ?? 'unresolved'} | Updated: ${issue.updated}`,
          ...(issue.labels.length ? [`Labels: ${issue.labels.join(', ')}`] : []), ...(issue.components.length ? [`Components: ${issue.components.join(', ')}`] : []),
          '', 'Description:', issue.description || '(none)',
          ...(issue.links.length ? ['', 'Linked issues:', ...issue.links.map((link) => `- ${link.relation} ${link.key} [${link.status}]: ${link.summary}`)] : []),
          ...(issue.attachments.length ? ['', 'Attachments (read with jira_get_attachment):', ...issue.attachments.map((a) => `- id ${a.id}: ${a.filename} (${a.mime_type}, ${a.size} bytes, ${a.created})`)] : []),
        ].join('\n'));
      }
      case 'jira_get_comments': {
        const key = input.issue_key as string; setTarget(key); this.requireProject(projectOf(key));
        const comments = await reads.getIssueComments(key, signal);
        return text(comments.length ? comments.map((c) => `--- ${c.author}, ${c.created} ---\n${c.body}`).join('\n\n') : 'No comments.');
      }
      case 'jira_get_attachment': {
        const key = input.issue_key as string; const id = input.attachment_id as string; setTarget(`${key}#${id}`); this.requireProject(projectOf(key));
        const { meta, data } = await reads.getIssueAttachment(key, id, knowledge.limits.max_attachment_bytes, signal);
        const header = `${meta.filename} (${meta.mime_type}, ${data.byteLength} bytes)`;
        const mime = meta.mime_type.toLowerCase().split(';')[0]!.trim();
        if (IMAGE_MIME.has(mime)) {
          if (data.byteLength > MAX_IMAGE_BYTES) return text(`${header}\nImage is too large to pass on (limit ${MAX_IMAGE_BYTES} bytes).`);
          return [{ type: 'text', text: header }, { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: mime as 'image/png' }];
        }
        if (TEXT_MIME.test(mime) || TEXT_EXTENSION.test(meta.filename)) return text(`${header}\n\n${Buffer.from(data).toString('utf8').replace(/\u0000/g, '')}`);
        return text(`${header}\nBinary attachment: content is not available through this tool.`);
      }
      case 'jira_search': {
        const query = input.query as string; const project = input.project as string | undefined; setTarget(`query:${query.length}`);
        if (project !== undefined) this.requireProject(project);
        const hits = await reads.searchIssues({ text: query, projects: project !== undefined ? [project] : this.projects, resolvedOnly: input.resolved_only === true, limit: knowledge.limits.search_results }, signal);
        const allowed = hits.filter((hit) => this.projects.includes(projectOf(hit.key)));
        return text(allowed.length ? allowed.map((hit) => `- ${hit.key} [${hit.status}${hit.resolution ? `, ${hit.resolution}` : ''}] ${hit.summary} (updated ${hit.updated})`).join('\n') : 'No matching issues in the allowed projects.');
      }
      case 'confluence_search': {
        const query = input.query as string; const space = input.space as string | undefined; setTarget(`query:${query.length}`);
        const { spaces, pages } = knowledge.confluence;
        if (space !== undefined && !spaces.some((allowed) => same(allowed, space))) throw new Refusal('FORBIDDEN', `Confluence space ${space} is not on the knowledge allow-list`);
        if (spaces.length === 0 && pages.length === 0) throw new Refusal('FORBIDDEN', 'No Confluence spaces or pages are on the knowledge allow-list');
        const scope = space !== undefined ? { spaces: [spaces.find((allowed) => same(allowed, space))!], ancestors: [] } : { spaces, ancestors: pages };
        const hits = await reads.searchPages({ text: query, ...scope, limit: knowledge.limits.search_results }, signal);
        // Defence in depth: with no page trees in play every hit must be in an allowed space.
        const allowed = scope.ancestors.length ? hits : hits.filter((hit) => scope.spaces.some((key) => same(key, hit.space_key)));
        return text(allowed.length ? allowed.map((hit) => `- page ${hit.id} [${hit.space_key}] ${hit.title}${hit.excerpt ? `\n  ${hit.excerpt}` : ''}`).join('\n') : 'No matching pages in the allowed spaces.');
      }
      case 'confluence_get_page': {
        const id = this.pageId(input.page as string); setTarget(id);
        const page = await reads.getPage(id, signal);
        if (!this.pageAllowed(page, knowledge)) throw new Refusal('FORBIDDEN', `This page is in space ${page.space_key}, which is not on the knowledge allow-list`);
        return text(`${page.title} (page ${page.id}, space ${page.space_key}, updated ${page.updated})\n\n${page.body}`);
      }
      case 'confluence_get_children': {
        const id = input.page_id as string; setTarget(id);
        const parent = await reads.getPage(id, signal);
        if (!this.pageAllowed(parent, knowledge)) throw new Refusal('FORBIDDEN', `This page is in space ${parent.space_key}, which is not on the knowledge allow-list`);
        const children = await reads.getPageChildren(id, 50, signal);
        return text(children.length ? children.map((child) => `- page ${child.id}: ${child.title}`).join('\n') : 'No child pages.');
      }
    }
  }
}
