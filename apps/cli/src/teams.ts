/**
 * Phase 1 Teams integration: one-way notifications. `autos teams relay` follows the controller's event stream and posts
 * Adaptive Cards to a Teams Workflows webhook. Outbound HTTPS only: nothing is exposed and the controller stays on
 * loopback. Cards carry Autos-authored facts only (issue key, state, codes, branch/commit, tier, Autos' own reason);
 * never ticket text, operator notes, diffs or provider output. The webhook URL is a secret and is never logged.
 */
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutosError, type AutosConfig, type JobEvent, type JobRecord, type TeamsNotifyKind } from '@autos/contracts';

/** Hosts Teams Workflows ("Post to a channel when a webhook request is received") issue webhook URLs on. */
export const TEAMS_WEBHOOK_HOST_SUFFIXES = ['.logic.azure.com', '.api.powerplatform.com'] as const;

/** Validates the webhook URL from the environment. Errors never echo the URL (it carries a signature). */
export function parseTeamsWebhookUrl(raw: string | undefined, envName: string): URL {
  if (!raw?.trim()) throw new AutosError('INVALID_CONFIG', `Teams webhook environment variable ${envName} must be set`);
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AutosError('INVALID_CONFIG', `${envName} is not a valid URL`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new AutosError('INVALID_CONFIG', `${envName} must be a credential-free https URL`);
  if (!TEAMS_WEBHOOK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new AutosError('INVALID_CONFIG', `${envName} must be a Teams Workflows webhook (host ending in ${TEAMS_WEBHOOK_HOST_SUFFIXES.join(' or ')})`);
  return url;
}

/** Which notification an event is, or null for events the relay never posts. */
export function notificationKind(event: JobEvent): TeamsNotifyKind | null {
  if (event.type === 'job_finished' && event.state && ['READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED', 'PLANNED'].includes(event.state)) return event.state as TeamsNotifyKind;
  if (event.type === 'job_paused') return 'PAUSED';
  if (event.type === 'tier_escalated') return 'TIER_ESCALATED';
  if (event.type === 'provider_gate_opened') return 'PROVIDER_GATE';
  return null;
}

/** Remembers each job's SWE start tier and current tier from tier_selected / tier_escalated events seen by the relay. */
export class TierTracker {
  private readonly jobs = new Map<string, { start: string; current: string; escalations: number }>();
  observe(event: JobEvent): void {
    if (!event.job_id || event.role !== 'swe' || !event.tier) return;
    if (event.type === 'tier_selected') this.jobs.set(event.job_id, { start: event.tier, current: event.tier, escalations: 0 });
    else if (event.type === 'tier_escalated') {
      const known = this.jobs.get(event.job_id);
      this.jobs.set(event.job_id, known ? { ...known, current: event.tier, escalations: known.escalations + 1 } : { start: '?', current: event.tier, escalations: 1 });
    }
  }
  get(jobId: string | null): { start: string; current: string; escalations: number } | undefined { return jobId ? this.jobs.get(jobId) : undefined; }
  forget(jobId: string | null): void { if (jobId) this.jobs.delete(jobId); }
}

/** Plain text for card fields: no control characters, no markdown link brackets or emphasis, bounded. */
const text = (value: string, max = 300): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[[\]*`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export interface CardFacts { job?: JobRecord | null; tier?: { start: string; current: string; escalations: number } | undefined }
/** Builds the Workflows message payload (one Adaptive Card 1.4 attachment). */
export function buildTeamsMessage(event: JobEvent, kind: TeamsNotifyKind, facts: CardFacts, config: Pick<AutosConfig, 'jira'> & { notifications?: AutosConfig['notifications'] }): Record<string, unknown> {
  const key = event.issue_key; const job = facts.job ?? null; const jobId = event.job_id;
  const titles: Record<TeamsNotifyKind, [string, string]> = {
    READY_FOR_HUMAN: [`✅ ${key} is ready for review`, 'Good'],
    BLOCKED: [`⛔ ${key} is blocked${event.code ? ` (${event.code})` : ''}`, 'Attention'],
    CANCELLED: [`✖ ${key} was cancelled`, 'Default'],
    PLANNED: [`📝 ${key}: dry run planned`, 'Default'],
    PAUSED: [`⏸ ${key} paused: provider limits`, 'Warning'],
    TIER_ESCALATED: [`⬆ ${key}: ${event.role ?? 'role'} moved up to ${event.tier ?? 'the next tier'}`, 'Accent'],
    PROVIDER_GATE: ['⏳ New tickets are waiting: provider limits', 'Warning'],
  };
  const [title, color] = titles[kind];
  const factList: Array<{ title: string; value: string }> = [];
  const add = (name: string, value: string | number | null | undefined) => { if (value !== null && value !== undefined && String(value).length) factList.push({ title: name, value: text(String(value)) }); };
  add('Job', jobId);
  if (job) {
    if ((job.revision ?? 0) > 0) add('Revision', job.revision);
    add('Branch', job.feature_branch); add('Commit', job.commit_sha?.slice(0, 12)); add('Base', job.base_branch);
    if (kind === 'READY_FOR_HUMAN' || kind === 'BLOCKED') add('Repair rounds', job.repair_round);
    if (kind === 'BLOCKED') add('Reason', job.blocked_reason);
  }
  if (facts.tier && kind !== 'PROVIDER_GATE') add('SWE tier', facts.tier.start === facts.tier.current ? facts.tier.current : `${facts.tier.start} → ${facts.tier.current} (${facts.tier.escalations} escalation${facts.tier.escalations === 1 ? '' : 's'})`);
  if (kind === 'PAUSED') { add('Role', event.role); add('Code', event.code); add('Resumes', event.resume_at); }
  if (kind === 'PROVIDER_GATE') { add('Lifts by', event.resume_at); add('Detail', event.message); }
  if (kind === 'TIER_ESCALATED') add('Why', event.message);
  if (kind === 'BLOCKED' && !job) add('Code', event.code);
  const commands: string[] = [];
  if (config.notifications?.teams?.include_commands !== false && key) {
    if (kind === 'READY_FOR_HUMAN') commands.push(`autos show ${key}`, `autos revise ${key} --note "…"`, `autos close ${key} --merged`);
    else if (kind === 'BLOCKED' || kind === 'CANCELLED') commands.push(`autos show ${key}`, ...(jobId ? [`autos retry ${jobId}`] : []));
    else if (kind === 'PAUSED' && jobId) commands.push(`autos status`, `autos jobs cancel ${jobId}`);
    else if (kind === 'PLANNED') commands.push(`autos run ${key}`);
  }
  const body: unknown[] = [
    { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true, color, text: text(title, 200) },
    { type: 'TextBlock', isSubtle: true, spacing: 'None', wrap: true, text: text(`Autos · ${event.at}`) },
    ...(factList.length ? [{ type: 'FactSet', facts: factList }] : []),
    ...(commands.length ? [{ type: 'TextBlock', text: 'Next steps', weight: 'Bolder', spacing: 'Medium' }, ...commands.map((c) => ({ type: 'TextBlock', text: c.replace(/[\u0000-\u001f\u007f]/g, ' '), fontType: 'Monospace', wrap: true, spacing: 'Small' }))] : []),
  ];
  const actions = key ? [{ type: 'Action.OpenUrl', title: `Open ${key} in Jira`, url: new URL(`browse/${key}`, config.jira.site_url).toString() }] : [];
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body, actions } }] };
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;
export interface DeliveryOptions { fetch?: FetchLike; signal?: AbortSignal; attempts?: number; retryDelayMs?: number; timeoutMs?: number }
/**
 * POSTs one payload. Retries network errors, 408, 429 and 5xx with backoff (Retry-After honoured, capped at 60 s); other
 * statuses fail at once. Redirects are refused. The result carries only the HTTP status, never the URL or response body.
 */
export async function postTeamsMessage(url: URL, payload: unknown, options: DeliveryOptions = {}): Promise<{ ok: true; status: number } | { ok: false; status: number | null }> {
  const attempts = Math.max(1, options.attempts ?? 4); const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let status: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new AutosError('CANCELLED', 'Teams delivery cancelled');
    let retryAfterMs: number | undefined;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const response = await doFetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
      status = response.status; await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { ok: true, status };
      if (!(status === 408 || status === 429 || status >= 500)) return { ok: false, status };
      const after = Number(response.headers.get('retry-after')); if (Number.isFinite(after) && after >= 0) retryAfterMs = Math.min(after * 1000, 60_000);
    } catch (error) {
      if (options.signal?.aborted) throw new AutosError('CANCELLED', 'Teams delivery cancelled');
      status = null; void error;
    }
    if (attempt < attempts) await delay(retryAfterMs ?? (options.retryDelayMs ?? 1000) * 2 ** (attempt - 1), options.signal);
  }
  return { ok: false, status };
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
}

/** The relay's resume point (last processed event id), kept as a private 0600 file in the data directory. */
export function cursorPath(dataDir: string): string { return join(dataDir, 'teams-relay.json'); }
export async function readCursor(path: string): Promise<number | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new AutosError('POLICY', 'Teams relay cursor must not be a symlink');
    const value = JSON.parse(await readFile(path, 'utf8')) as { last_event_id?: unknown };
    return Number.isSafeInteger(value.last_event_id) && (value.last_event_id as number) >= 0 ? value.last_event_id as number : null;
  } catch (error) { if (error instanceof AutosError) throw error; return null; }
}
export async function writeCursor(path: string, lastEventId: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`; const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ schema_version: 1, last_event_id: lastEventId })); } finally { await handle.close(); }
  await rename(temp, path);
}
