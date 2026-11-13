import { AutosError, type EmbeddingPort, type ErrorCode, type IndexedComment, type IndexedIssue } from '@autos/contracts';
import { computeTermStats, learnTemplates, prepareIssue, templateFromLines, type ProjectTemplate } from './text.js';
import type { PrecedentStore } from './store.js';

/**
 * Read-only Jira source for the index (plan §3.1), implemented by `@autos/atlassian` (Task A). Restricted issues
 * (security levels) and restricted comments are dropped by the source before these shapes are built. JQL is built
 * by the source from validated project keys; this package never constructs JQL.
 */
export interface JiraIndexSource {
  /** One page, ordered by `updated ASC, id ASC`; `updatedSince` is an ISO UTC instant or null (window only). */
  searchIssuesForIndex(opts: { projects: string[]; updatedSince: string | null; windowWeeks: number; pageToken: string | null; pageSize: number; signal?: AbortSignal }):
    Promise<{ issues: IndexedIssue[]; nextPageToken?: string | null; skipped_restricted: number; skipped_invalid: number }>;
  /** Remaining comments of an issue whose embedded comment page was incomplete. */
  getIndexComments(issueId: string, startAt: number, signal?: AbortSignal): Promise<{ comments: IndexedComment[]; next_start_at: number | null; skipped_invalid: number }>;
  /** One page of `id, key, updated` for every issue in scope (reconciliation). */
  listIssueIds(opts: { projects: string[]; windowWeeks: number; pageToken: string | null; signal?: AbortSignal }):
    Promise<{ ids: Array<{ id: string; key: string; updated: string }>; nextPageToken?: string | null }>;
}

export interface IndexSyncOptions {
  projects: string[];
  windowWeeks?: number;
  /** Incremental re-read overlap. Default 24 h: JQL dates use the Jira user's time zone; content hashes make re-reads cheap. */
  overlapMs?: number;
  pageSize?: number;
  maxRequestsPerRun?: number;
  /** Minimum spacing between Jira requests (default 250 ms; one request in flight). */
  minSpacingMs?: number;
  embedBatchSize?: number;
  embedder?: EmbeddingPort | null;
  /** Relearn templates and the stoplist after each completed full sync (default true). */
  relearnAfterFull?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncRunReport {
  mode: 'full' | 'incremental';
  started_at: string;
  finished_at: string;
  completed: boolean;
  budget_exhausted: boolean;
  requests: number;
  issues_seen: number;
  issues_changed: number;
  skipped_restricted: number;
  skipped_invalid: number;
  vectors_written: number;
  reconciled: boolean;
  deleted: number;
  /** Error code only; never upstream text. */
  error_code: ErrorCode | null;
}

export interface IndexSyncStatus {
  running: boolean;
  cursor: string | null;
  last_full_at: string | null;
  in_progress: { mode: 'full' | 'incremental'; since: string | null; pages: number } | null;
  last_run: SyncRunReport | null;
  store: ReturnType<PrecedentStore['status']>;
}

interface Progress { mode: 'full' | 'incremental'; since: string | null; page_token: string | null; high_water: string | null; pages: number }
interface Cursor { updated: string | null; last_full_at: string | null }

const STATE_PROGRESS = 'jira_progress';
const STATE_CURSOR = 'jira_cursor';
const STATE_LAST_RUN = 'last_run';

class BudgetExhausted extends Error {}

/** Background indexer: Jira → prepared issues → store → embeddings. One run at a time per instance. */
export class IndexSync {
  private inflight: Promise<SyncRunReport> | null = null;
  private lastRequestAt = 0;
  private readonly o: Required<Omit<IndexSyncOptions, 'embedder'>> & { embedder: EmbeddingPort | null };
  constructor(private readonly store: PrecedentStore, private readonly source: JiraIndexSource, opts: IndexSyncOptions) {
    for (const p of opts.projects) if (!/^[A-Z][A-Z0-9]*$/.test(p)) throw new AutosError('INVALID_CONFIG', 'Invalid project key in index scope');
    this.o = {
      projects: [...new Set(opts.projects)].sort(), windowWeeks: opts.windowWeeks ?? 104, overlapMs: opts.overlapMs ?? 24 * 3_600_000, pageSize: opts.pageSize ?? 100,
      maxRequestsPerRun: opts.maxRequestsPerRun ?? 5000, minSpacingMs: opts.minSpacingMs ?? 250, embedBatchSize: opts.embedBatchSize ?? 32,
      embedder: opts.embedder ?? null, relearnAfterFull: opts.relearnAfterFull ?? true, now: opts.now ?? (() => new Date()),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
    if (this.o.embedder) store.assertModel(this.o.embedder.model());
  }

  get running(): boolean { return this.inflight !== null; }

  /** Single-flight: a call while a run is active joins that run. */
  sync(opts: { full?: boolean; reconcile?: boolean; signal?: AbortSignal } = {}): Promise<SyncRunReport> {
    if (this.inflight) return this.inflight;
    const p = this.run(opts).finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  status(): IndexSyncStatus {
    const progress = this.store.getState<Progress>(STATE_PROGRESS); const cursor = this.store.getState<Cursor>(STATE_CURSOR);
    return { running: this.running, cursor: cursor?.updated ?? null, last_full_at: cursor?.last_full_at ?? null,
      in_progress: progress ? { mode: progress.mode, since: progress.since, pages: progress.pages } : null,
      last_run: this.store.getState<SyncRunReport>(STATE_LAST_RUN), store: this.store.status() };
  }

  private async request<T>(report: SyncRunReport, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new AutosError('CANCELLED', 'Index sync cancelled');
    if (report.requests >= this.o.maxRequestsPerRun) throw new BudgetExhausted();
    const wait = this.lastRequestAt + this.o.minSpacingMs - Date.now();
    if (wait > 0) await this.o.sleep(wait);
    report.requests++;
    try { return await fn(); } finally { this.lastRequestAt = Date.now(); }
  }

  private templates(): Map<string, ProjectTemplate> {
    const out = new Map<string, ProjectTemplate>();
    for (const [project, lines] of this.store.loadTemplates()) out.set(project, templateFromLines(project, lines));
    return out;
  }

  private async run(opts: { full?: boolean; reconcile?: boolean; signal?: AbortSignal }): Promise<SyncRunReport> {
    const signal = opts.signal;
    const prior = this.store.getState<Progress>(STATE_PROGRESS);
    const cursor = this.store.getState<Cursor>(STATE_CURSOR) ?? { updated: null, last_full_at: null };
    const fullRequested = !!opts.full || !cursor.last_full_at;
    let progress: Progress;
    if (prior && (!opts.full || prior.mode === 'full')) progress = prior; // resume the interrupted run
    else if (fullRequested) progress = { mode: 'full', since: null, page_token: null, high_water: null, pages: 0 };
    else progress = { mode: 'incremental', since: cursor.updated ? new Date(Date.parse(cursor.updated) - this.o.overlapMs).toISOString() : null, page_token: null, high_water: null, pages: 0 };
    const report: SyncRunReport = { mode: progress.mode, started_at: this.o.now().toISOString(), finished_at: '', completed: false, budget_exhausted: false, requests: 0,
      issues_seen: 0, issues_changed: 0, skipped_restricted: 0, skipped_invalid: 0, vectors_written: 0, reconciled: false, deleted: 0, error_code: null };
    const templates = this.templates();
    const projects = new Set(this.o.projects);
    try {
      for (;;) {
        const page = await this.request(report, signal, () => this.source.searchIssuesForIndex({ projects: this.o.projects, updatedSince: progress.since, windowWeeks: this.o.windowWeeks,
          pageToken: progress.page_token, pageSize: this.o.pageSize, ...(signal ? { signal } : {}) }));
        report.skipped_restricted += page.skipped_restricted; report.skipped_invalid += page.skipped_invalid;
        for (const raw of page.issues) {
          if (!projects.has(raw.project_key)) continue;
          let issue = raw;
          if (raw.comments_truncated) {
            const comments = [...raw.comments]; let start: number | null = raw.comments.length;
            while (start !== null) {
              const at: number = start;
              const more = await this.request(report, signal, () => this.source.getIndexComments(raw.id, at, signal));
              report.skipped_invalid += more.skipped_invalid; comments.push(...more.comments);
              start = more.next_start_at !== null && more.next_start_at > at ? more.next_start_at : null;
            }
            issue = { ...raw, comments, comments_truncated: false };
          }
          report.issues_seen++;
          const prepared = prepareIssue(issue, { template: templates.get(issue.project_key) ?? null, fixes: this.fixSummaries(issue.id) });
          if (this.store.upsertIssue(prepared).changed) report.issues_changed++;
          if (!progress.high_water || issue.updated_at > progress.high_water) progress.high_water = issue.updated_at;
        }
        report.vectors_written += await this.embedMissing(signal);
        progress.page_token = page.nextPageToken ?? null; progress.pages++;
        if (!progress.page_token) break;
        this.store.setState(STATE_PROGRESS, progress);
      }
      // Completed: advance the cursor, clear progress.
      const next: Cursor = { updated: progress.high_water && (!cursor.updated || progress.high_water > cursor.updated) ? progress.high_water : cursor.updated,
        last_full_at: progress.mode === 'full' ? report.started_at : cursor.last_full_at };
      this.store.setState(STATE_CURSOR, next); this.store.clearState(STATE_PROGRESS);
      report.completed = true;
      if (progress.mode === 'full' && this.o.relearnAfterFull) report.vectors_written += await this.relearn(signal);
      if (opts.reconcile) { report.deleted = await this.reconcile(report, signal); report.reconciled = true; }
    } catch (error) {
      if (!report.completed) this.store.setState(STATE_PROGRESS, progress);
      if (error instanceof BudgetExhausted) report.budget_exhausted = true;
      else report.error_code = error instanceof AutosError ? error.code : 'INTERNAL';
    }
    report.finished_at = this.o.now().toISOString();
    this.store.setState(STATE_LAST_RUN, report);
    return report;
  }

  private fixSummaries(issueId: string) { return this.store.fixesForIssue(issueId).map((f) => ({ commit_sha: f.commit_sha, subject: f.subject, files: f.files })); }

  /** Embeds every chunk still missing a vector, in batches. Returns the number written. */
  async embedMissing(signal?: AbortSignal): Promise<number> {
    const embedder = this.o.embedder; if (!embedder) return 0;
    let written = 0;
    for (;;) {
      if (signal?.aborted) throw new AutosError('CANCELLED', 'Index sync cancelled');
      const batch = this.store.chunksMissingVectors(this.o.embedBatchSize);
      if (!batch.length) return written;
      const vectors = await embedder.embed(batch.map((c) => c.text), signal);
      if (vectors.length !== batch.length) throw new AutosError('INVALID_OUTPUT', 'Embedding count mismatch');
      written += this.store.setVectors(batch.map((c, i) => ({ chunk_id: c.id, vector: vectors[i] as Float32Array })));
    }
  }

  /** Relearns per-project templates and the corpus stoplist, then reprocesses stored issues (only changed chunks re-embed). */
  async relearn(signal?: AbortSignal): Promise<number> {
    const docs = this.store.allIssueDocs();
    const byProject = new Map<string, string[]>();
    for (const d of docs) byProject.set(d.project_key, [...(byProject.get(d.project_key) ?? []), d.description]);
    const templates = new Map<string, ProjectTemplate>();
    for (const [project, descriptions] of byProject) { const t = learnTemplates(project, descriptions); this.store.saveTemplate(t); templates.set(project, t); }
    for (const d of docs) this.store.upsertIssue(prepareIssue(d, { template: templates.get(d.project_key) ?? null, fixes: this.fixSummaries(d.id) }));
    this.store.saveTermStats(computeTermStats(docs.map((d) => ({ project: d.project_key, text: `${d.summary}\n${d.description}` }))));
    return this.embedMissing(signal);
  }

  /**
   * Deletes indexed issues no longer listed by Jira (deleted, moved out of scope, permission lost) and purges
   * issues outside the window or scope. Deletion only happens when the listing completed.
   */
  private async reconcile(report: SyncRunReport, signal?: AbortSignal): Promise<number> {
    const listed = new Set<string>(); let token: string | null = null;
    do {
      const pageToken: string | null = token;
      const page: Awaited<ReturnType<JiraIndexSource['listIssueIds']>> = await this.request(report, signal, () => this.source.listIssueIds({ projects: this.o.projects, windowWeeks: this.o.windowWeeks, pageToken, ...(signal ? { signal } : {}) }));
      for (const i of page.ids) listed.add(i.id);
      token = page.nextPageToken ?? null;
    } while (token);
    let deleted = this.store.deleteIssues(this.store.listIssueIds().filter((id) => !listed.has(id)));
    deleted += this.store.purgeProjectsNotIn(this.o.projects);
    deleted += this.store.purgeOlderThan(new Date(this.o.now().getTime() - this.o.windowWeeks * 7 * 86_400_000).toISOString());
    return deleted;
  }
}
