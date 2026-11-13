import { z } from 'zod';
import {
  AutosError, confluenceDraftRecordSchema, lineageNodeSchema, precedentIndexStatusSchema, precedentSyncReportSchema, semanticPrecedentResultSchema, semanticPrecedentSchema,
  type ConfluenceDraftRecord, type PrecedentIndexStatus, type PrecedentSyncReport, type SemanticPrecedent, type SemanticPrecedentResult,
} from '@autos/contracts';

/**
 * `autos index|lineage|precedents|confluence` commands: thin clients of the running controller's /v1 API (the index
 * lives in the controller process). Output is counts, keys and the operator's own search results; nothing is logged.
 */

export interface PrecedentApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}
export interface PrecedentCommandContext {
  api: PrecedentApi;
  json: boolean;
  stdout(text: string): void;
  /** Whether a confirmation prompt may be shown (stdin is a terminal). */
  interactive: boolean;
  prompt(question: string): Promise<string>;
  now: number;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const operationSchema = z.object({
  kind: z.enum(['sync', 'rebuild']), full: z.boolean(), reconcile: z.boolean(), running: z.boolean(),
  started_at: z.string(), finished_at: z.string().nullable(), reports: z.array(precedentSyncReportSchema), error_code: z.string().nullable(),
});
export type IndexOperationView = z.infer<typeof operationSchema>;
const indexStatusResponseSchema = z.object({
  index: precedentIndexStatusSchema, auto_sync: z.boolean(),
  loop: z.object({ active: z.boolean(), last_tick_at: z.string().nullable(), last_tick_error_code: z.string().nullable(), ticks: z.number().int().min(0) }),
  operation: operationSchema.nullable(),
});
export type IndexStatusView = z.infer<typeof indexStatusResponseSchema>;
const lineageResponseSchema = z.object({ nodes: z.array(lineageNodeSchema), unattached: z.array(z.string()), missing: z.array(z.string()) });
export type LineageView = z.infer<typeof lineageResponseSchema>;
const searchResponseSchema = z.object({ result: semanticPrecedentResultSchema, related: z.array(semanticPrecedentSchema), explain: z.array(z.unknown()) });
export type SearchView = z.infer<typeof searchResponseSchema>;

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AutosError('UPSTREAM', `Controller returned an unexpected ${what} response`);
  return parsed.data;
}
function flags(args: string[], spec: { bool: readonly string[]; value: readonly string[] }, usage: string): { flags: Set<string>; values: Map<string, string> } {
  const set = new Set<string>(); const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (spec.bool.includes(arg) && !set.has(arg)) set.add(arg);
    else if (spec.value.includes(arg) && !values.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new AutosError('INVALID_INPUT', usage);
      values.set(arg, value);
    } else throw new AutosError('INVALID_INPUT', usage);
  }
  return { flags: set, values };
}
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}
/** One display line of untrusted text: control characters removed, length capped. */
function cell(text: string, max: number): string {
  const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
function ago(at: string | null, now: number): string {
  if (!at) return 'never';
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  const span = seconds >= 86_400 ? `${Math.floor(seconds / 86_400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
  return `${at.slice(0, 16).replace('T', ' ')}Z (${span} ago)`;
}

async function confirm(ctx: PrecedentCommandContext, yes: boolean, question: string, refusal: string): Promise<boolean> {
  if (yes) return true;
  if (!ctx.interactive) throw new AutosError('INVALID_INPUT', refusal);
  const answer = await ctx.prompt(question);
  if (/^y(es)?$/i.test(answer.trim())) return true;
  ctx.stdout('Aborted; nothing changed.');
  return false;
}

// ---- Formatting (exported for tests) ----

export function formatSyncReports(reports: PrecedentSyncReport[]): string[] {
  if (reports.length === 0) return [];
  return table(['MODE', 'UPSERTED', 'DELETED', 'EMBEDDED', 'FIXES', 'REQUESTS', 'COMPLETE', 'ERROR'], reports.map((report) => [
    report.mode, String(report.issues_upserted), String(report.issues_deleted), String(report.chunks_embedded), String(report.fixes_found), String(report.requests), report.complete ? 'yes' : 'no', report.error_code ?? '-',
  ]));
}
function operationLabel(operation: IndexOperationView): string {
  const options = [operation.full ? 'full' : '', operation.reconcile ? 'reconcile' : ''].filter(Boolean).join(', ');
  return `${operation.kind}${options ? ` (${options})` : ''}`;
}
export function formatIndexStatus(view: IndexStatusView, now: number): string[] {
  const s: PrecedentIndexStatus = view.index;
  const lines = [
    `Precedent index: ${s.ready ? 'READY' : 'NOT READY'}${s.running ? ', sync running' : ''} (source ${s.source}${s.enabled ? '' : ', disabled'})`,
    `Issues ${s.issues}  chunks ${s.chunks}  vectors ${s.vectors}  fixes ${s.fixes}  projects ${s.projects.length ? s.projects.join(', ') : '-'}`,
    `Embedding model: ${s.embedding_model ?? 'none (keyword and error-signature search only)'}`,
    `Last sync ${ago(s.last_sync_at, now)}; full ${ago(s.last_full_sync_at, now)}; reconcile ${ago(s.last_reconcile_at, now)}; mirror scan ${ago(s.last_mirror_scan_at, now)}`,
  ];
  if (s.last_error_code) lines.push(`Last error: ${s.last_error_code}`);
  lines.push(view.loop.active
    ? `Background loop: on; last tick ${ago(view.loop.last_tick_at, now)}${view.loop.last_tick_error_code ? ` (${view.loop.last_tick_error_code})` : ''}`
    : `Background loop: off${view.auto_sync ? ' (auto_sync on, but this controller does not run the loop)' : ' (precedents.index.auto_sync is false; use autos index sync)'}`);
  const op = view.operation;
  if (op) {
    lines.push(op.running ? `Operation: ${operationLabel(op)} running since ${ago(op.started_at, now)}` : `Last operation: ${operationLabel(op)} finished ${ago(op.finished_at, now)}${op.error_code ? ` with ${op.error_code}` : ''}`);
    lines.push(...formatSyncReports(op.reports));
  }
  return lines;
}
export function formatLineage(view: LineageView): string[] {
  const lines = view.nodes.length === 0 ? ['No lineage nodes (configure precedents.lineages and run autos index sync).'] : table(['LINEAGE', 'PROJECT', 'BRANCH', 'FORK POINT', 'FORK DATE', 'DEV/SBX'], view.nodes.map((node) => [
    node.lineage_id, node.project_key, node.branch, node.fork_point.slice(0, 12), node.fork_date.slice(0, 10), node.side_branches.length ? node.side_branches.map((side) => `${side.branch} (${side.kind}, ${side.method})`).join(', ') : '-',
  ]));
  if (view.unattached.length) lines.push(`Unattached branches: ${view.unattached.join(', ')}`);
  if (view.missing.length) lines.push(`Missing: ${view.missing.join(', ')}`);
  return lines;
}
function precedentRows(items: SemanticPrecedent[]): string[] {
  return table(['KIND', 'KEY', 'STATUS', 'SCORE', 'JUDGE', 'SIGNALS', 'FIX', 'SUMMARY'], items.map((item) => [
    item.kind, item.issue_key, cell(`${item.status}${item.resolution ? `/${item.resolution}` : ''}`, 24), item.score.toFixed(2), item.judge ? `${item.judge.verdict} ${item.judge.confidence.toFixed(2)}` : '-',
    item.signals.join(','), item.fix ? `${item.fix.commit_shas[0]!.slice(0, 10)} on ${item.fix.branch}${item.fix.applies_cleanly === true ? ' (applies)' : item.fix.applies_cleanly === false ? ' (needs adaptation)' : ''}` : '-', cell(item.summary, 60),
  ]));
}
export function formatSearch(view: SearchView): string[] {
  const r: SemanticPrecedentResult = view.result;
  const lines = [`Precedents: ${r.outcome} (${r.checked} checked, ${r.items.length} shown; judge ${r.judge})${r.index ? `; index ${r.index.issues} issues as of ${r.index.as_of.slice(0, 16).replace('T', ' ')}Z` : ''}`];
  if (r.items.length) lines.push(...precedentRows(r.items));
  if (r.also_reported.length) lines.push('', 'Same bug may be open in other projects (never given to agents):', ...precedentRows(r.also_reported));
  if (view.related.length) lines.push('', 'Related fixes (search only):', ...precedentRows(view.related));
  if (r.rejected.length) lines.push('', `Rejected: ${r.rejected.map((entry) => `${entry.issue_key} (${cell(entry.reason, 80)})`).join(', ')}`);
  if (view.explain.length) lines.push('', 'Explain:', ...view.explain.map((record) => JSON.stringify(record)));
  return lines;
}
export function formatDraft(record: ConfluenceDraftRecord): string[] {
  return [
    `Confluence draft for ${record.issue_key} (job ${record.job_id}): page ${record.draft.page_id}, version ${record.draft.version}`,
    `Edit: ${record.draft.edit_url}`,
    ...(record.supersedes_page_id ? [`Supersedes page ${record.supersedes_page_id} (it was published or edited, so Autos left it untouched).`] : []),
    'The draft is unpublished and visible only to the Atlassian account whose token the controller uses. Review it and publish it yourself in Confluence; Autos never publishes.',
  ];
}

// ---- Commands ----

export const indexUsage = 'Usage: autos index status | sync [--full] [--reconcile] | rebuild [--yes] | purge --project KEY [--yes]  (all accept [--url URL])';
export async function indexCommand(args: string[], ctx: PrecedentCommandContext): Promise<number> {
  const sub = args[0];
  if (sub === 'status') {
    flags(args.slice(1), { bool: [], value: [] }, indexUsage);
    const view = parse(indexStatusResponseSchema, await ctx.api.get('/v1/index/status'), 'index status');
    if (ctx.json) ctx.stdout(JSON.stringify(view, null, 2)); else for (const line of formatIndexStatus(view, ctx.now)) ctx.stdout(line);
    return 0;
  }
  if (sub === 'sync') {
    const { flags: set } = flags(args.slice(1), { bool: ['--full', '--reconcile'], value: [] }, indexUsage);
    const operation = parse(operationSchema, await ctx.api.post('/v1/index/sync', { full: set.has('--full'), reconcile: set.has('--reconcile') }), 'index sync');
    if (ctx.json) ctx.stdout(JSON.stringify(operation, null, 2)); else ctx.stdout(`Index ${operationLabel(operation)} started at ${operation.started_at}. It runs in the controller; follow it with \`autos index status\`.`);
    return 0;
  }
  if (sub === 'rebuild') {
    const { flags: set } = flags(args.slice(1), { bool: ['--yes'], value: [] }, indexUsage);
    if (!await confirm(ctx, set.has('--yes'), 'Rebuild the precedent index from scratch? Search returns INDEX_NOT_READY until it finishes (hours on CPU). [y/N] ', 'Rebuilding discards the local index; pass --yes to confirm when not running on a terminal')) return 1;
    const operation = parse(operationSchema, await ctx.api.post('/v1/index/rebuild', {}), 'index rebuild');
    if (ctx.json) ctx.stdout(JSON.stringify(operation, null, 2)); else ctx.stdout(`Index rebuild started at ${operation.started_at}. It runs in the controller; follow it with \`autos index status\`.`);
    return 0;
  }
  if (sub === 'purge') {
    const { flags: set, values } = flags(args.slice(1), { bool: ['--yes'], value: ['--project'] }, indexUsage);
    const project = values.get('--project');
    if (!project || !PROJECT_KEY.test(project)) throw new AutosError('INVALID_INPUT', `--project KEY is required (a Jira project key such as ABC). ${indexUsage}`);
    if (!await confirm(ctx, set.has('--yes'), `Delete every indexed issue of ${project} from the precedent index now? [y/N] `, 'Purging deletes indexed issues; pass --yes to confirm when not running on a terminal')) return 1;
    const body = parse(z.object({ project_key: z.string(), issues_deleted: z.number().int().min(0) }), await ctx.api.post('/v1/index/purge', { project_key: project }), 'index purge');
    if (ctx.json) ctx.stdout(JSON.stringify(body, null, 2));
    else ctx.stdout(`Purged ${body.issues_deleted} indexed issue${body.issues_deleted === 1 ? '' : 's'} of ${project}. Add ${project} to precedents.index.exclude_projects to keep it out of later syncs.`);
    return 0;
  }
  throw new AutosError('INVALID_INPUT', indexUsage);
}

export const lineageUsage = 'Usage: autos lineage show [--url URL]';
export async function lineageCommand(args: string[], ctx: PrecedentCommandContext): Promise<number> {
  if (args[0] !== 'show') throw new AutosError('INVALID_INPUT', lineageUsage);
  flags(args.slice(1), { bool: [], value: [] }, lineageUsage);
  const view = parse(lineageResponseSchema, await ctx.api.get('/v1/lineage'), 'lineage');
  if (ctx.json) ctx.stdout(JSON.stringify(view, null, 2)); else for (const line of formatLineage(view)) ctx.stdout(line);
  return 0;
}

export const precedentsUsage = 'Usage: autos precedents search (--issue KEY | --text "...") [--limit N] [--include-unresolved] [--no-judge] [--explain] [--url URL] | autos precedents show KEY [--url URL]';
export async function precedentsCommand(args: string[], ctx: PrecedentCommandContext): Promise<number> {
  if (args[0] === 'search') {
    const { flags: set, values } = flags(args.slice(1), { bool: ['--include-unresolved', '--no-judge', '--explain'], value: ['--issue', '--text', '--limit'] }, precedentsUsage);
    const issue = values.get('--issue'); const text = values.get('--text'); const limit = values.get('--limit');
    if ((issue === undefined) === (text === undefined)) throw new AutosError('INVALID_INPUT', `Exactly one of --issue or --text is required. ${precedentsUsage}`);
    if (issue !== undefined && !ISSUE_KEY.test(issue)) throw new AutosError('INVALID_INPUT', '--issue must look like ABC-123');
    if (text !== undefined && (text.trim().length < 3 || text.length > 4000)) throw new AutosError('INVALID_INPUT', '--text must contain 3 to 4000 characters');
    if (limit !== undefined && (!/^[0-9]{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 20)) throw new AutosError('INVALID_INPUT', '--limit must be from 1 to 20');
    const body = {
      ...(issue !== undefined ? { issue_key: issue } : { text: text!.trim() }), ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(set.has('--include-unresolved') ? { include_unresolved: true } : {}), ...(set.has('--no-judge') ? { judge: false } : {}), ...(set.has('--explain') ? { explain: true } : {}),
    };
    const view = parse(searchResponseSchema, await ctx.api.post('/v1/precedents/search', body), 'precedent search');
    if (ctx.json) ctx.stdout(JSON.stringify(view, null, 2)); else for (const line of formatSearch(view)) ctx.stdout(line);
    return 0;
  }
  if (args[0] === 'show') {
    const key = args[1];
    if (!key || !ISSUE_KEY.test(key)) throw new AutosError('INVALID_INPUT', precedentsUsage);
    flags(args.slice(2), { bool: [], value: [] }, precedentsUsage);
    const record = parse(z.record(z.string(), z.unknown()), await ctx.api.get(`/v1/precedents/${key}`), 'precedent');
    ctx.stdout(JSON.stringify(record, null, 2));
    return 0;
  }
  throw new AutosError('INVALID_INPUT', precedentsUsage);
}

export const confluenceUsage = 'Usage: autos confluence draft JOB_ID|ISSUE-KEY [--url URL]';
export async function confluenceCommand(args: string[], ctx: PrecedentCommandContext): Promise<number> {
  const target = args[1];
  if (args[0] !== 'draft' || !target || !(UUID.test(target) || ISSUE_KEY.test(target))) throw new AutosError('INVALID_INPUT', confluenceUsage);
  flags(args.slice(2), { bool: [], value: [] }, confluenceUsage);
  const record = parse(confluenceDraftRecordSchema, await ctx.api.post('/v1/confluence-drafts', UUID.test(target) ? { job_id: target.toLowerCase() } : { issue_key: target }), 'Confluence draft');
  if (ctx.json) ctx.stdout(JSON.stringify(record, null, 2)); else for (const line of formatDraft(record)) ctx.stdout(line);
  return 0;
}
