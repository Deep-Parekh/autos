import { access, open, readFile, stat } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { AutosError, DATASET_OUTCOMES, EFFORT_LEVELS, effortSchema, formatTierStep, parseTierStep, tierPinResultSchema, tierPinSchema, type TierPin, type TierPinResult, type TierStepRef, type DatasetExportOptions, closeIssueResultSchema, ERROR_CODES, issueClosureSchema, jobEventSchema, MAX_TICKET_NOTES, ticketNotesSummarySchema, ticketNoteSchema, type TicketNote, type TicketNotesSummary, jobRecordSchema, operatorNoteRequestSchema, parseConfigYaml, pruneWorkspacesResultSchema, workspaceEntrySchema, type AutosConfig, type CloseIssueResult, type IssueClosure, type JobEvent, type JobRecord, type PruneWorkspacesResult, type WorkspaceEntry } from '@autos/contracts';
import type { OperatorNoteRequest, WorkflowServicePort } from '@autos/contracts';
import type { ControllerOptions, LoopStatus, ProviderDiagnostic, StatusResponse } from '@autos/controller';
import { pollDelayMs, runControllerLoop, waitForSignalOrTimeout, type LoopSleep } from './loop.js';
import { deepChecks, formatChecks, type CheckResult, type DeepDoctorDeps } from './deep-doctor.js';
import { createControllerClient } from './teams-bot/actions.js';
import { createBotAuthenticator } from './teams-bot/auth.js';
import { ConnectorClient } from './teams-bot/connector.js';
import { createBotServer } from './teams-bot/server.js';
import { buildLifecycleMessage, buildTeamsMessage, cursorPath, EntraTokenSource, notificationKind, parseTeamsWebhookUrl, postTeamsMessage, readRelayState, TierTracker, writeRelayState, type FetchLike, type LifecycleFacts } from './teams.js';

export interface CliRuntime extends Omit<ControllerOptions, 'operatorToken' | 'fastifyOptions' | 'bindHost'> {
  testProviders(): Promise<ProviderDiagnostic[]>;
}
export interface CliDependencies {
  runtime?(configPath: string): Promise<CliRuntime>;
  stdout?(text: string): void;
  stderr?(text: string): void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?(path: string): Promise<boolean>;
  /** Test seam: stops `controller start` instead of process signals. */
  signal?: AbortSignal;
  /** Test seam: delay used by the controller poll loop. Must resolve early when the signal aborts. */
  sleep?: LoopSleep;
  /** Test seam: invoked with the bound `host:port` once the controller is listening. */
  onListening?(address: { host: string; port: number }): void;
  /** Test seams for `doctor --deep` (free disk bytes of a directory). */
  deepDoctor?: DeepDoctorDeps;
  /** Test seam: delay between `autos watch` reconnect attempts. */
  reconnectDelayMs?: number;
  /** Test seam: whether stdin is an interactive terminal (default: process.stdin.isTTY). `autos close` only prompts on a TTY. */
  stdinIsTTY?: boolean;
  /** Test seam: ask a question on the terminal and return the typed answer (default: readline on stdin/stderr). */
  prompt?(question: string): Promise<string>;
  /** Test seam: clock for workspace ages. */
  now?(): number;
  /** Test seams for `autos teams`: the webhook HTTP client and the delivery retry base delay. */
  teamsFetch?: FetchLike;
  teamsRetryDelayMs?: number;
  /** Test seam for `autos teams bot`: the controller HTTP client (default global fetch). */
  botControllerFetch?: FetchLike;
  /** How long the controller must stay unreachable before the relay posts an AUTOS_DOWN card (default 15 s). */
  teamsDownAfterMs?: number;
}

export { pollDelayMs };

const outDefault = (text: string) => process.stdout.write(`${text}\n`);
const errDefault = (text: string) => process.stderr.write(`${text}\n`);
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const help = `Autos — local ticket workflow operator

Usage: autos [--config PATH] [--json] <command>

Commands:
  init [--config PATH]            Create a credential-free local config copy
  doctor [--deep]                 Check config references and local prerequisites; --deep also checks the
                                  supervisor, git credentials, Jira filter, Confluence map, base branches and disk
  providers                       List providers with the role chain positions that use them
  providers test --all            Run explicit read-only provider smoke tests
  run ISSUE-123 [--dry-run] [--note TEXT]...  Queue and wait for one issue (non-zero unless READY_FOR_HUMAN/PLANNED);
                                  --note (repeatable, max 5) gives operator guidance to the SWE
  revise JOB_ID|ISSUE-123 --note TEXT [--note-file PATH] [--roles swe,qa,reviewer] [--tier TIER[:EFFORT]]
         [--effort LEVEL] [--wait] [--url URL]
                                  Request changes on a READY_FOR_HUMAN job (or an issue's latest one) via the running
                                  controller; continues from the reviewed commit. SWE starts at the step that finished
                                  the previous attempt unless --tier (this revision only) or a ticket pin says otherwise.
                                  --wait follows the new job (exit 0 only on READY_FOR_HUMAN)
  close ISSUE-123 --merged|--abandoned [--note TEXT] [--dry-run] [--yes] [--url URL]
                                  Finish an issue after manual review (irreversible): records your MERGED/ABANDONED
                                  assertion and removes ALL its workspaces; artifacts are kept. Jira/Bitbucket are not
                                  changed and the merge is not verified. Asks to confirm on a terminal unless --yes
  show ISSUE-123 [--url URL]      Show an issue's closure, attempts, ticket notes and tier pins (needs running controller)
  note ISSUE-123 --note TEXT [--roles swe,qa,reviewer] | --swe TEXT | --qa TEXT | --reviewer TEXT | --all TEXT
                 | --note-file PATH [--hold] [--tier TIER[:EFFORT] [--effort LEVEL]] [--url URL]
                                  Store guidance for an issue key, even before Autos has seen the issue; it applies to
                                  every attempt of that issue until removed. Each flag is a separate note and all are
                                  repeatable (max ${MAX_TICKET_NOTES} notes per issue). --roles applies to the --note/--note-file flags that
                                  follow it (default swe); --all targets swe, qa and reviewer. --hold also holds the issue;
                                  --tier also pins the SWE starting tier (as autos tier; may be used without notes)
  note ISSUE-123 --list | --remove NOTE_ID | --clear | --hold | --release [--url URL]
                                  Manage notes and the hold (a held issue is not queued by automatic discovery)
  notes [ISSUE-123] [--url URL]   List every issue with notes, a hold or tier pins and whether Autos has worked on it;
                                  with a key, show that issue's notes and pins in full
  tier ISSUE-123 TIER[:EFFORT] [--effort LEVEL] [--role swe|qa|reviewer] [--url URL]
                                  Pin a role's starting model tier (default swe) for every later attempt of the issue,
                                  even before Autos has seen it, until cleared; never below the role's floor (min).
                                  --effort (or TIER:EFFORT) overrides the effort of every Claude/Codex entry of the tier.
                                  A tier outside the role's ladder is a fixed step without escalation
  tier ISSUE-123 [--clear [--role ROLE]] [--url URL]
                                  List the issue's tier pins, or clear them (one role or all)
  workspaces [--sizes] [--url URL]  List workspace directories with age, size and the retention decision
  export dataset [--out FILE] [--since ISO] [--issue KEY] [--outcome LIST] [--no-prompts] [--no-transcripts]
                                  Write the per-attempt dataset (JSON lines: tickets, prompts, transcripts, checks, QA/review,
                                  human outcome) from local storage; no controller needed. Default stdout; --out creates a
                                  new 0600 file and never overwrites. LIST: merged,abandoned,revised,awaiting_review,blocked,cancelled
  workspaces prune [--dry-run] [--older-than HOURS] [--sizes] [--url URL]
                                  Remove removable workspaces now (closed, superseded, orphan, expired BLOCKED/CANCELLED)
  jobs show JOB_ID                Show one job (state, branch, commit, push outcome)
  jobs cancel JOB_ID              Cancel a queued or active job
  retry JOB_ID                   Start an explicit new attempt for a blocked job
  retry --all-blocked [--code CODE]  Queue a new attempt for every blocked job without a newer attempt
  queue list [--limit N]          List recent jobs
  status [--url URL]              Show live controller, runner, and job activity (needs running controller)
  watch [--job JOB_ID] [--url URL]  Follow progress events live (Ctrl-C to stop)
  teams relay [--from-start] [--url URL]  Post READY/BLOCKED/PAUSED and Autos up/down cards to Teams (notifications.teams;
                                  needs running controller; resumes after the last posted event; Ctrl-C to stop)
  teams test                      Post one test card to the configured Teams webhook
  teams bot [--url URL]           Serve the two-way Teams bot endpoint on loopback (teams_bot; see docs/teams-bot.md)
  events [--job JOB_ID] [--after N] [--limit N] [--url URL]  List persisted progress events
  controller start                Run the local API and polling loop
  docs validate                   Check generated OpenAPI against docs/openapi.yaml
  docs preview                    Print a local API reference
  --help, --version`;

function resolveConfigPath(args: string[], cwd: string): { args: string[]; path: string; json: boolean } {
  const rest: string[] = [];
  let configPath = 'config/config.yaml';
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--config') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new AutosError('INVALID_INPUT', '--config requires a path');
      configPath = isAbsolute(value) ? value : resolve(cwd, value);
    } else if (arg === '--json') json = true;
    else rest.push(arg);
  }
  return { args: rest, path: configPath, json };
}

async function defaultRuntime(configPath: string): Promise<CliRuntime> {
  const runtime = await import('@autos/controller');
  return (runtime as unknown as { createRuntime(options: { configPath: string }): Promise<CliRuntime> }).createRuntime({ configPath });
}

function report(value: unknown, json: boolean, stdout: (text: string) => void): void {
  if (json) stdout(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) stdout(value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'));
  else stdout(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function readConfig(path: string): Promise<AutosConfig> {
  try { return parseConfigYaml(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_CONFIG', 'Configuration file is unavailable');
  }
}

async function commandInit(path: string, deps: CliDependencies): Promise<Record<string, unknown>> {
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.pathExists ?? (async (candidate) => access(candidate, constants.F_OK).then(() => true, () => false));
  if (await exists(path)) throw new AutosError('CONFLICT', 'Configuration file already exists; init does not overwrite files');
  const candidates = [resolve(cwd, 'config/config.example.yaml'), resolve(applicationRoot, 'config/config.example.yaml')];
  let source: string | undefined;
  for (const candidate of candidates) {
    try { source = await readFile(candidate, 'utf8'); break; } catch { /* try repository-relative fallback */ }
  }
  if (source === undefined) throw new AutosError('NOT_FOUND', 'Canonical example configuration is unavailable');
  parseConfigYaml(source);
  // Exclusive create prevents a concurrent init from replacing user data.
  const { open, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(source, 'utf8'); } finally { await file.close(); }
  } catch {
    throw new AutosError('CONFLICT', 'Configuration file already exists or cannot be created');
  }
  return { path, copied: true, credentials: 'environment-variable references only' };
}

function executableAvailable(binary: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  if (binary.includes('/')) {
    try { accessSync(isAbsolute(binary) ? binary : resolve(cwd, binary), constants.X_OK); return true; } catch { return false; }
  }
  return (env.PATH ?? '').split(delimiter).some((part) => {
    try { requireAccess(resolve(part, binary)); return true; } catch { return false; }
  });
}
function requireAccess(path: string): void {
  // accessSync is intentionally used for the lightweight PATH diagnostic only.
  accessSync(path, constants.X_OK);
}

const SUPERVISED_NOTE = 'checked via supervisor: run providers test --all';
/** Compose/server mode: the runner supervisor, not this process's PATH, owns provider binaries. */
async function supervisedMode(config: AutosConfig, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  if (env.AUTOS_CONTAINER_BIND_HOST) return true;
  const info = await stat(resolve(cwd, config.storage.data_dir, 'runner.sock')).catch(() => null);
  return info?.isSocket() === true;
}

async function doctor(config: AutosConfig, env: NodeJS.ProcessEnv, cwd: string, supervised: boolean): Promise<Record<string, unknown>> {
  const controller = await import('@autos/controller');
  const requiredEnv = [...new Set([
    config.jira.username_env, config.jira.token_env, config.confluence.username_env, config.confluence.token_env, config.api.operator_token_env,
    ...config.bitbucket.allowed_repositories.flatMap(() => config.bitbucket.read_token_env ? [config.bitbucket.read_token_env] : []),
  ])];
  const chains = controller.roleChains(config);
  // Under a supervisor the controller's own PATH says nothing about the worker images, so presence is assumed here.
  const present = new Map((['claude', 'codex', 'cursor'] as const).map((provider) => [provider, supervised || executableAvailable(config.providers[provider].binary, env, cwd)]));
  const providers = (['claude', 'codex', 'cursor'] as const).map((provider) => ({
    provider, binary: config.providers[provider].binary, binary_present: present.get(provider) === true,
    ...(supervised ? { checked: SUPERVISED_NOTE } : {}),
    roles: chains.flatMap(({ role, chain }) => chain.filter((entry) => entry.provider === provider).map((entry) => ({ role, chain_index: entry.chain_index }))),
  }));
  const roles = chains.map(({ role, chain }) => {
    const entries = chain.map((entry) => ({ ...entry, binary_present: present.get(entry.provider) === true }));
    return {
      role,
      chain: entries,
      summary: `${role}: ${entries.map((entry) => `${entry.provider}${entry.provider === 'cursor' ? '(auto)' : ''}${entry.binary_present ? '' : ' [missing]'}`).join(' \u2192 ')}`,
      available: entries.some((entry) => entry.binary_present),
    };
  });
  const warnings = roles.flatMap(({ role, chain }) => chain.filter((entry) => !entry.binary_present && entry.chain_index > 0).map((entry) => `${role}: fallback provider ${entry.provider} (chain position ${entry.chain_index}) binary not found; the fallback will be unavailable`)
    .concat(chain.some((entry) => entry.binary_present) && !chain[0]!.binary_present ? [`${role}: primary provider ${chain[0]!.provider} binary not found; the role starts from a fallback`] : []));
  return {
    config_valid: true,
    env_references: requiredEnv.map((name) => ({ name, present: Boolean(env[name]) })),
    providers,
    roles,
    warnings: supervised ? [`provider binaries ${SUPERVISED_NOTE}`, ...warnings] : warnings,
    provider_checks: supervised ? 'supervisor' : 'host',
    authentication: 'not checked; doctor never invokes providers or authenticates accounts',
    read_only_smoke: 'NOT_RUN',
  };
}

async function jobSummary(job: JobRecord, svc?: CliRuntime): Promise<Record<string, unknown>> {
  const controller = await import('@autos/controller');
  const summary: Record<string, unknown> = { ...controller.safeJob(job) };
  if (svc && ['READY_FOR_HUMAN', 'PLANNED', 'BLOCKED'].includes(job.state)) {
    // Push outcome is recorded in the artifact manifest; a missing manifest is not an error for display.
    const manifest = await svc.artifacts.manifest(job.job_id).catch(() => null);
    if (manifest?.job_id === job.job_id) summary.push_status = manifest.push_status;
  }
  return summary;
}
const successStates = ['READY_FOR_HUMAN', 'PLANNED'];

function schemaOptions(config: AutosConfig): ControllerOptions {
  const unavailable = async (): Promise<never> => { throw new Error('Schema generation does not execute services'); };
  return {
    config, operatorToken: 'schema-generation-placeholder-token', providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
    workflow: { submit: unavailable, retry: unavailable, revise: unavailable, reviseIssue: unavailable, closeIssue: unavailable, addTicketNote: unavailable, removeTicketNotes: unavailable, setTicketHold: unavailable, ticketNotes: unavailable, setTierPin: unavailable, clearTierPins: unavailable, tierPins: unavailable, closure: unavailable, workspaces: unavailable, pruneWorkspaces: unavailable, execute: unavailable, cancel: unavailable, get: async () => null, list: async () => [], poll: async () => undefined, discover: async () => ({ discovered: 0, queued: 0 }), drain: async () => undefined, events: async () => [], subscribe: () => () => undefined, activity: unavailable },
    artifacts: { write: async () => undefined, prepareRole: unavailable, manifest: unavailable },
  };
}

export async function validateOpenApiFile(options: { config: AutosConfig; path: string }): Promise<{ valid: boolean; message: string }> {
  const controller = await import('@autos/controller');
  const actual = await controller.generateOpenApi(schemaOptions(options.config));
  const expectedText = await readFile(options.path, 'utf8');
  const expectedDoc = parseDocument(expectedText, { uniqueKeys: true });
  if (expectedDoc.errors.length) return { valid: false, message: 'OpenAPI document is invalid YAML' };
  const expected = expectedDoc.toJS({ maxAliasCount: 1000 }) as Record<string, unknown>;
  // YAML and JSON key order is not significant; recursive stable serialization is.
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}` : JSON.stringify(value);
  if (stable(expected) !== stable(actual)) return { valid: false, message: 'Generated OpenAPI differs from docs/openapi.yaml' };
  return { valid: true, message: 'OpenAPI contract matches generated route schemas' };
}

async function exampleConfig(cwd: string): Promise<AutosConfig> {
  for (const path of [resolve(cwd, 'config/config.example.yaml'), resolve(applicationRoot, 'config/config.example.yaml')]) {
    try { return parseConfigYaml(await readFile(path, 'utf8')); } catch { /* try repository root fallback */ }
  }
  throw new AutosError('NOT_FOUND', 'Canonical example configuration is unavailable');
}

async function docsSpecPath(cwd: string): Promise<string> {
  const local = resolve(cwd, 'docs/openapi.yaml');
  try { await access(local, constants.R_OK); return local; } catch { return resolve(applicationRoot, 'docs/openapi.yaml'); }
}

// ---- Operator monitoring: thin HTTP clients of the running controller ----

interface MonitorOptions { url?: string; job?: string; after?: number; limit?: number }
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMonitorArgs(command: string, args: string[]): MonitorOptions {
  const allowed: Record<string, string[]> = { status: ['--url'], watch: ['--url', '--job'], events: ['--url', '--job', '--after', '--limit'] };
  const result: MonitorOptions = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const value = args[++index];
    if (!allowed[command]!.includes(flag) || value === undefined || value.startsWith('--')) throw new AutosError('INVALID_INPUT', `Usage: autos ${command} ${allowed[command]!.map((name) => `[${name} VALUE]`).join(' ')}`);
    if (flag === '--url') result.url = value;
    else if (flag === '--job') { if (!UUID.test(value)) throw new AutosError('INVALID_INPUT', '--job must be a job UUID'); result.job = value; }
    else if (flag === '--after') { if (!/^[0-9]{1,15}$/.test(value)) throw new AutosError('INVALID_INPUT', '--after must be a non-negative integer'); result.after = Number(value); }
    else { if (!/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 500) throw new AutosError('INVALID_INPUT', '--limit must be from 1 to 500'); result.limit = Number(value); }
  }
  return result;
}

function controllerBase(config: AutosConfig, override: string | undefined): URL {
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { throw new AutosError('INVALID_INPUT', '--url must be an http(s) URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AutosError('INVALID_INPUT', '--url must be an http(s) URL');
    url.username = ''; url.password = '';
    return url;
  }
  const host: string = config.api.listen_host;
  return new URL(`http://${host.includes(':') ? `[${host}]` : host}:${config.api.port}/`);
}

function endpoint(base: URL, path: string, query: Record<string, string | number | undefined> = {}): URL {
  const url = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base : new URL(`${base.href}/`));
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
  return url;
}

const unreachable = () => new AutosError('UPSTREAM', 'Autos controller is not reachable. Start it with `autos controller start`, or pass --url.', { retryable: true });

function httpFailure(status: number): AutosError {
  if (status === 401 || status === 403) return new AutosError('AUTH', 'Controller rejected the operator token');
  if (status === 404) return new AutosError('NOT_FOUND', 'Controller resource not found');
  if (status === 400) return new AutosError('INVALID_INPUT', 'Controller rejected the request');
  if (status === 409) return new AutosError('CONFLICT', 'Controller rejected the request: the issue is closed, another attempt is active, or the job is not the latest READY_FOR_HUMAN attempt');
  return new AutosError('UPSTREAM', `Controller returned HTTP ${status}`);
}

/**
 * `reason`: on HTTP 400, show the controller's own error message (used where the controller explains the refusal, e.g. an
 * unknown tier or a step below the floor). The message is controller-authored; it is length-capped and stripped of control
 * characters, and any other status still maps to the generic failures.
 */
async function controllerFetch(url: URL, token: string, init: { signal?: AbortSignal; headers?: Record<string, string>; method?: string; body?: string; reason?: boolean } = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { signal: init.signal ?? null, method: init.method ?? 'GET', ...(init.body !== undefined ? { body: init.body } : {}), headers: { authorization: `Bearer ${token}`, ...init.headers } }); }
  catch (error) { if (init.signal?.aborted) throw error; throw unreachable(); }
  if (!response.ok) {
    if (init.reason && response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      const message = isRecord(body) && typeof body.message === 'string' ? body.message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : '';
      if (message) throw new AutosError('INVALID_INPUT', `Controller rejected the request: ${message}`);
    } else await response.body?.cancel().catch(() => undefined);
    throw httpFailure(response.status);
  }
  return response;
}

async function controllerJson(url: URL, token: string, init: Parameters<typeof controllerFetch>[2] = {}): Promise<unknown> {
  const response = await controllerFetch(url, token, init);
  try { return await response.json(); } catch { throw new AutosError('UPSTREAM', 'Controller returned an unreadable response'); }
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** One compact, secret-free line per event, for `autos watch` and `autos events`. */
export function formatEvent(event: JobEvent): string {
  if (event.type === 'provider_fallback') {
    // `provider` is the provider the role moves to; `from_provider` is the one that failed.
    const role = event.role ? (event.role === 'swe' ? 'SWE' : event.role === 'qa' ? 'QA' : 'Reviewer') : 'Role';
    const after = [event.from_provider, event.code].filter(Boolean).join(' ');
    return [event.at.slice(11, 19), event.issue_key ?? 'service', `${role} fallback \u2192 ${event.provider ?? 'next provider'}${after ? ` after ${after}` : ''}`, ...(event.repair_round !== undefined ? [`(round ${event.repair_round})`] : [])].join(' ');
  }
  if (event.type === 'job_paused') {
    const role = event.role ? (event.role === 'swe' ? 'SWE' : event.role === 'qa' ? 'QA' : 'Reviewer') : 'Role';
    return [event.at.slice(11, 19), event.issue_key ?? 'service', `paused: every ${role} provider limited${event.code ? ` (${event.code})` : ''}`, ...(event.resume_at ? [`resumes ${event.resume_at.slice(0, 16).replace('T', ' ')}Z`] : []), ...(event.count !== undefined ? [`pause ${event.count}`] : []), ...(event.repair_round !== undefined ? [`(round ${event.repair_round})`] : [])].join(' ');
  }
  if (event.type === 'job_resumed') {
    return [event.at.slice(11, 19), event.issue_key ?? 'service', `resumed${event.role ? ` ${event.role}` : ''} at its primary provider`, ...(event.code ? [`after ${event.code}`] : []), ...(event.repair_round !== undefined ? [`(round ${event.repair_round})`] : [])].join(' ');
  }
  if (event.type === 'provider_gate_opened' || event.type === 'provider_gate_closed') {
    return [event.at.slice(11, 19), 'service', event.type === 'provider_gate_opened' ? `provider limit gate opened: new tickets wait${event.resume_at ? ` until ${event.resume_at.slice(0, 16).replace('T', ' ')}Z` : ''}` : 'provider limit gate lifted: new tickets may start'].join(' ');
  }
  if (event.type === 'issue_closed') {
    return [event.at.slice(11, 19), event.issue_key ?? 'service', `issue closed${event.outcome ? ` as ${event.outcome.toLowerCase()}` : ''}`, ...(event.count !== undefined ? [`workspaces removed=${event.count}`] : []), ...(event.code ? [`code=${event.code}`] : [])].join(' ');
  }
  if (event.type === 'workspaces_pruned') {
    return [event.at.slice(11, 19), event.issue_key ?? 'service', 'workspaces pruned', ...(event.count !== undefined ? [`removed=${event.count}`] : []), ...(event.outcome ? [`outcome=${event.outcome}`] : []), ...(event.code ? [`code=${event.code}`] : [])].join(' ');
  }
  const parts: string[] = [event.at.slice(11, 19), event.issue_key ?? 'service', event.type];
  if (event.role) parts.push(event.provider ? `${event.role}/${event.provider}` : event.role);
  else if (event.provider) parts.push(event.provider);
  if (event.repair_round !== undefined) parts.push(`round ${event.repair_round}`);
  if (event.stage) parts.push(`stage=${event.stage}`);
  if (event.state) parts.push(`state=${event.state}`);
  if (event.outcome) parts.push(`outcome=${event.outcome}`);
  if (event.code) parts.push(`code=${event.code}`);
  if (event.elapsed_ms !== undefined) parts.push(`elapsed=${formatDuration(event.elapsed_ms / 1000)}`);
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  if (event.message) parts.push(`- ${event.message.replace(/[\r\n]+/g, ' ')}`);
  return parts.join(' ');
}

export function formatStatus(status: StatusResponse, now = Date.now()): string {
  const { controller, runner, activity } = status;
  const lines: string[] = [];
  const loop = controller.poll_loop;
  let loopText = 'poll loop not running';
  if (loop.running) {
    const next = loop.next_poll_at ? Date.parse(loop.next_poll_at) : NaN;
    loopText = loop.auto_poll === false ? 'loop running (drain only)' : `poll loop running, ${Number.isFinite(next) ? `next poll in ${formatDuration((next - now) / 1000)}` : 'polling now'}`;
    if (loop.consecutive_failures > 0) loopText += `, ${loop.consecutive_failures} consecutive failure(s)`;
  }
  const runnerOk = runner.status === 'ready' && runner.docker !== 'unavailable';
  if (!runnerOk) lines.push(`WARN runner not available (${runner.status === 'ready' ? `docker ${runner.docker}` : runner.status}): jobs cannot run until the supervisor and Docker are healthy`);
  lines.push(`Controller ${controller.version}  up ${formatDuration(controller.uptime_s)}  poll every ${controller.poll_interval_s}s  ${loopText}`);
  lines.push(`Runner: ${runner.status === 'ready' ? `ready (docker ${runner.docker})` : `WARN ${runner.status}`}`);
  if (loop.auto_poll === false) lines.push('Auto poll: OFF (only submitted jobs run; Jira is never read)');
  else lines.push(`Auto poll: ON  last discovery ${loop.last_discovery_at ?? 'never'}`);
  const slots = activity.slots;
  if (slots) lines.push(`Slots: ${slots.in_use}/${slots.max_parallel} (checks ${slots.checks_in_use}/${slots.max_concurrent_checks})`);
  const jobs = status.active_jobs?.length ? status.active_jobs : activity.active ? [{ ...activity.active, active_elapsed_s: status.active_elapsed_s, stage_elapsed_s: status.stage_elapsed_s }] : [];
  if (jobs.length) {
    for (const active of jobs) {
      const who = active.role ? ` ${active.role}${active.provider ? `/${active.provider}` : ''}` : '';
      const elapsed = [active.active_elapsed_s !== undefined ? `job ${formatDuration(active.active_elapsed_s)}` : '', active.stage_elapsed_s !== undefined ? `stage ${formatDuration(active.stage_elapsed_s)}` : ''].filter(Boolean).join(', ');
      lines.push(`Active: ${active.issue_key} ${active.state}${active.stage ? ` stage=${active.stage}` : ''}${who} round ${active.repair_round}${active.dry_run ? ' (dry run)' : ''}${elapsed ? `  elapsed ${elapsed}` : ''}`);
    }
  } else lines.push('Active: idle (no job running)');
  const limits = activity.provider_limits;
  if (limits?.providers.length) lines.push(`Provider limits: ${limits.providers.map((l) => `${l.provider} until ${l.until}`).join(', ')}${limits.gate_active ? `; new tickets wait until ${limits.gate_until ?? 'a limit resets'}` : '; new tickets still start (an SWE provider is available)'}`);
  for (const paused of activity.paused_jobs ?? []) {
    const due = paused.resume_at ? Date.parse(paused.resume_at) : NaN;
    lines.push(`Paused: ${paused.issue_key}${paused.role ? ` ${paused.role}` : ''}${paused.code ? ` ${paused.code}` : ''} round ${paused.repair_round} pause ${paused.pause_count}  resumes ${paused.resume_at ?? 'unknown'}${Number.isFinite(due) ? ` (in ${formatDuration((due - now) / 1000)})` : ''}  (no slot held)`);
  }
  const poll = activity.polling;
  lines.push(`Polling: ${poll.in_progress ? 'in progress' : poll.last_outcome ? `last ${poll.last_outcome}${poll.last_error_code ? ` (${poll.last_error_code})` : ''} at ${poll.last_finished_at ?? poll.last_started_at ?? 'unknown'}` : 'no poll yet'}${poll.last_discovered !== null ? `, discovered ${poll.last_discovered}` : ''}`);
  const counts = Object.entries(activity.counts).filter(([, count]) => (count ?? 0) > 0).map(([state, count]) => `${state} ${count}`);
  lines.push(`Jobs: ${counts.length ? counts.join(', ') : 'none'}`);
  lines.push(`Last event id: ${activity.last_event_id}`);
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Incremental text/event-stream parser; yields complete messages. Comments (heartbeats) are ignored. */
export function createSseParser(onMessage: (message: { id?: string; event?: string; data: string }) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      let id: string | undefined; let event: string | undefined; const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = value; else if (field === 'event') event = value; else if (field === 'data') data.push(value);
      }
      if (data.length) onMessage({ ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), data: data.join('\n') });
    }
  };
}

async function watchEvents(base: URL, token: string, options: MonitorOptions, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const external = dependencies.signal;
  if (external) { if (external.aborted) abort.abort(); else external.addEventListener('abort', stop, { once: true }); }
  else { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  let cursor = options.after;
  let attempts = 0; let everConnected = false;
  const delay = dependencies.reconnectDelayMs;
  try {
    while (!abort.signal.aborted) {
      try {
        const response = await controllerFetch(endpoint(base, '/v1/events/stream', { job_id: options.job, after: cursor }), token, { signal: abort.signal, headers: { accept: 'text/event-stream', ...(cursor !== undefined ? { 'last-event-id': String(cursor) } : {}) } });
        if (!response.body) throw unreachable();
        everConnected = true; attempts = 0;
        const parse = createSseParser((message) => {
          let value: unknown; try { value = JSON.parse(message.data); } catch { return; }
          const event = jobEventSchema.safeParse(value);
          if (!event.success) return;
          cursor = event.data.event_id;
          stdout(json ? JSON.stringify(event.data) : formatEvent(event.data));
        });
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) parse(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof AutosError && (error.code !== 'UPSTREAM' || !everConnected)) throw error;
      }
      if (abort.signal.aborted) break;
      attempts++;
      stderr(JSON.stringify({ event: 'watch_reconnecting', attempt: attempts, last_event_id: cursor ?? null }));
      await waitForSignalOrTimeout(abort.signal, delay ?? Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 10_000));
    }
    return 0;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); external?.removeEventListener('abort', stop); }
}

// ---- Teams notifications (phase 1: one-way, outbound only) ----

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AutosError('INVALID_CONFIG', `Environment variable ${name} must be set`);
  return value;
}
const teamsBotUsage = 'Usage: autos teams bot [--url URL]';
/**
 * Two-way Teams (phase 2): serves the bot's messaging endpoint on loopback and turns allowed users' commands into
 * controller API calls. A tunnel or reverse proxy exposes only POST /api/messages (see docs/teams-bot.md).
 */
async function teamsBotCommand(args: string[], config: AutosConfig, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const bot = config.teams_bot;
  if (!bot) throw new AutosError('INVALID_CONFIG', 'teams_bot is not configured (see docs/teams-bot.md)');
  const { values } = parseFlags(args, { bool: [], value: ['--url'] }, teamsBotUsage);
  const env = dependencies.env ?? process.env;
  const token = operatorToken(config, dependencies); const base = controllerBase(config, values.get('--url'));
  const fetchImpl = dependencies.teamsFetch;
  const tokens = new EntraTokenSource({ tenantId: bot.tenant_id, clientId: bot.app_id, clientSecret: requireEnv(env, bot.client_secret_env), cloud: 'public', scope: 'https://api.botframework.com/.default', ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(dependencies.now ? { now: dependencies.now } : {}) });
  const log = (record: Record<string, unknown>) => stderr(JSON.stringify(record));
  // Fail fast on a wrong app ID, tenant or secret instead of silently failing every reply later.
  await tokens.token();
  const { server, idle } = createBotServer({
    tenantId: bot.tenant_id, allowedUsers: bot.allowed_users,
    parse: { allowedProjects: config.jira.allowed_projects, jiraSiteUrl: config.jira.site_url, maxNoteChars: bot.max_note_chars },
    auth: createBotAuthenticator({ appId: bot.app_id, tenantId: bot.tenant_id, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(dependencies.now ? { now: dependencies.now } : {}) }),
    connector: new ConnectorClient({ tokens, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(dependencies.teamsRetryDelayMs !== undefined ? { retryDelayMs: dependencies.teamsRetryDelayMs } : {}) }),
    controller: createControllerClient(base, token, dependencies.botControllerFetch),
    log,
  });
  const abort = new AbortController(); const stop = () => abort.abort(); const external = dependencies.signal;
  if (external) { if (external.aborted) abort.abort(); else external.addEventListener('abort', stop, { once: true }); }
  else { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try {
    await new Promise<void>((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(bot.port, bot.listen_host, () => resolveListen()); });
    const address = server.address(); const port = typeof address === 'object' && address ? address.port : bot.port;
    dependencies.onListening?.({ host: bot.listen_host, port });
    log({ event: 'teams_bot_started', host: bot.listen_host, port, allowed_users: bot.allowed_users.length });
    stdout(`Autos Teams bot listening on ${bot.listen_host}:${port} (POST /api/messages); Ctrl-C to stop`);
    await new Promise<void>((resolveStop) => { if (abort.signal.aborted) resolveStop(); else abort.signal.addEventListener('abort', () => resolveStop(), { once: true }); });
    await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    await idle();
    log({ event: 'teams_bot_stopped' });
    return 0;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); external?.removeEventListener('abort', stop); }
}
const teamsUsage = 'Usage: autos teams relay [--from-start] [--url URL] | autos teams test';
async function teamsCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  if (args[0] === 'bot') return teamsBotCommand(args.slice(1), config, dependencies, stdout, stderr);
  const teams = config.notifications?.teams;
  if (!teams) throw new AutosError('INVALID_CONFIG', 'notifications.teams is not configured (see docs/teams.md)');
  const env = dependencies.env ?? process.env;
  const webhook = parseTeamsWebhookUrl(env[teams.webhook_url_env], teams.webhook_url_env);
  const auth = teams.auth ? new EntraTokenSource({ tenantId: teams.auth.tenant_id, clientId: teams.auth.client_id, clientSecret: requireEnv(env, teams.auth.client_secret_env), cloud: teams.auth.cloud, ...(dependencies.teamsFetch ? { fetch: dependencies.teamsFetch } : {}), ...(dependencies.now ? { now: dependencies.now } : {}) }) : undefined;
  // payload: card sends the Adaptive Card itself instead of the Workflows message envelope.
  const shape = (message: Record<string, unknown>): unknown => teams.payload === 'card' ? (message.attachments as Array<{ content: unknown }>)[0]!.content : message;
  const delivery = { ...(dependencies.teamsFetch ? { fetch: dependencies.teamsFetch } : {}), ...(dependencies.teamsRetryDelayMs !== undefined ? { retryDelayMs: dependencies.teamsRetryDelayMs } : {}), ...(auth ? { auth } : {}) };
  // 401 without sign-in configured: the workflow trigger is restricted to tenant users (see docs/teams.md, "Sign-in").
  const hint = (status: number | null) => status === 401 ? (auth ? ' The token was refused: check that the trigger allows this app (its Enterprise application object ID) and the cloud setting.' : ' The workflow requires sign-in: set notifications.teams.auth (docs/teams.md, "Tenants that require sign-in").') : status === 403 ? ' The app is not allowed to trigger this workflow: add its Enterprise application object ID to the trigger\'s allowed users.' : '';
  if (args[0] === 'test' && args.length === 1) {
    const at = new Date(dependencies.now?.() ?? Date.now()).toISOString();
    const payload = buildTeamsMessage({ event_id: 1, at, type: 'job_finished', job_id: null, issue_key: null, state: 'PLANNED' }, 'PLANNED', {}, config);
    // A test card names no issue: replace the title so it reads as a connectivity check.
    const content = (payload.attachments as Array<{ content: { body: Array<{ text?: string }> } }>)[0]!.content;
    content.body[0]!.text = '🔔 Autos Teams notifications are connected'; content.body.splice(2);
    const result = await postTeamsMessage(webhook, shape(payload), delivery);
    report(json ? { delivered: result.ok, status: result.status } : result.ok ? `Test card delivered (HTTP ${result.status}).` : `Test card was not delivered (${result.status === null ? 'network error' : `HTTP ${result.status}`}).${hint(result.status)}`, json, stdout);
    return result.ok ? 0 : 1;
  }
  if (args[0] !== 'relay') throw new AutosError('INVALID_INPUT', teamsUsage);
  const { flags, values } = parseFlags(args.slice(1), { bool: ['--from-start'], value: ['--url'] }, teamsUsage);
  const token = operatorToken(config, dependencies); const base = controllerBase(config, values.get('--url'));
  const cursorFile = cursorPath(resolve(dependencies.cwd ?? process.cwd(), config.storage.data_dir));
  const saved = await readRelayState(cursorFile);
  // Resume after the last processed event; a first start begins at "now" (no replay of history) unless --from-start.
  let cursor = flags.has('--from-start') ? 0 : saved.lastEventId;
  // Start time of the controller process last announced as up: a relay restart does not announce the same process again.
  let announced = saved.announcedControllerStart;
  const save = () => writeRelayState(cursorFile, { lastEventId: cursor ?? 0, announcedControllerStart: announced });
  if (cursor === null) {
    const status = await controllerJson(endpoint(base, '/v1/status'), token);
    const last = isRecord(status) && isRecord(status.activity) && Number.isSafeInteger(status.activity.last_event_id) ? status.activity.last_event_id as number : 0;
    cursor = last; await save();
  }
  const wanted = new Set(teams.notify); const tiers = new TierTracker();
  const now = () => dependencies.now?.() ?? Date.now(); const iso = (ms: number) => new Date(ms).toISOString();
  const downAfterMs = dependencies.teamsDownAfterMs ?? 15_000;
  let disconnectedAt: number | null = null; let downPosted = false;
  /** Controller facts for an up card; null when status cannot be read (the card then goes out without them). */
  const controllerFacts = async (): Promise<Omit<LifecycleFacts, 'variant'> | null> => {
    try {
      const status = await controllerJson(endpoint(base, '/v1/status'), token, { signal: abort.signal });
      if (!isRecord(status)) return null;
      const controller = isRecord(status.controller) ? status.controller : {}; const activity = isRecord(status.activity) ? status.activity : {};
      const loop = isRecord(controller.poll_loop) ? controller.poll_loop : {}; const counts = isRecord(activity.counts) ? activity.counts : {};
      return {
        controllerStartedAt: typeof controller.started_at === 'string' ? controller.started_at : null,
        autoPoll: typeof loop.auto_poll === 'boolean' ? loop.auto_poll : null,
        activeJobs: Array.isArray(activity.active_jobs) ? activity.active_jobs.length : null,
        pausedJobs: Array.isArray(activity.paused_jobs) ? activity.paused_jobs.length : null,
        queuedJobs: typeof counts.QUEUED === 'number' ? counts.QUEUED : null,
      };
    } catch (error) { if (abort.signal.aborted) throw error; return null; }
  };
  const postLifecycle = async (kind: 'AUTOS_UP' | 'AUTOS_DOWN', facts: LifecycleFacts, options: { signal?: AbortSignal; attempts?: number } = {}) => {
    const result = await postTeamsMessage(webhook, shape(buildLifecycleMessage(iso(now()), facts)), { ...delivery, ...options });
    log(result.ok ? { event: 'teams_notified', kind, variant: facts.variant } : { event: 'teams_delivery_failed', kind, variant: facts.variant, status: result.status, ...(hint(result.status) ? { hint: hint(result.status).trim() } : {}) });
  };
  /** Called on every (re)connection: announces a newly started controller process, or recovery after a DOWN card. */
  const connected = async () => {
    const facts = await controllerFacts(); const startedAt = facts?.controllerStartedAt ?? null;
    const newProcess = startedAt !== null && startedAt !== announced;
    if (wanted.has('AUTOS_UP') && (downPosted || newProcess)) await postLifecycle('AUTOS_UP', { variant: downPosted ? 'back' : 'started', ...(facts ?? {}), ...(downPosted && disconnectedAt !== null ? { downSince: iso(disconnectedAt) } : {}) }, { signal: abort.signal });
    if (startedAt !== null) announced = startedAt;
    disconnectedAt = null; downPosted = false; await save();
  };
  /** Called after a failed (re)connection: posts one DOWN card once the controller has been unreachable for downAfterMs. */
  const markUnreachable = async () => {
    disconnectedAt ??= now();
    if (wanted.has('AUTOS_DOWN') && !downPosted && now() - disconnectedAt >= downAfterMs) {
      downPosted = true;
      await postLifecycle('AUTOS_DOWN', { variant: 'down', downSince: iso(disconnectedAt), controllerStartedAt: announced }, { signal: abort.signal });
    }
  };
  const abort = new AbortController(); const stop = () => abort.abort(); const external = dependencies.signal;
  if (external) { if (external.aborted) abort.abort(); else external.addEventListener('abort', stop, { once: true }); }
  else { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const log = (record: Record<string, unknown>) => stderr(JSON.stringify(record));
  log({ event: 'teams_relay_started', after: cursor, notify: [...wanted] });
  const handle = async (event: JobEvent): Promise<void> => {
    tiers.observe(event);
    const kind = notificationKind(event);
    if (kind && wanted.has(kind)) {
      let job: JobRecord | null = null;
      if (event.job_id && kind !== 'PROVIDER_GATE') {
        try { const parsedJob = jobRecordSchema.safeParse(await controllerJson(endpoint(base, `/v1/jobs/${event.job_id}`), token, { signal: abort.signal })); job = parsedJob.success ? parsedJob.data as JobRecord : null; }
        catch (error) { if (abort.signal.aborted) throw error; job = null; } // the card still goes out with the event's own facts
      }
      const result = await postTeamsMessage(webhook, shape(buildTeamsMessage(event, kind, { job, tier: tiers.get(event.job_id) }, config)), { ...delivery, signal: abort.signal });
      // At-least-once while the relay runs; a card that still fails after retries is logged and skipped so one bad
      // delivery cannot stall every later notification.
      log(result.ok ? { event: 'teams_notified', kind, issue_key: event.issue_key, event_id: event.event_id } : { event: 'teams_delivery_failed', kind, issue_key: event.issue_key, event_id: event.event_id, status: result.status, ...(hint(result.status) ? { hint: hint(result.status).trim() } : {}) });
    }
    if (event.type === 'job_finished') tiers.forget(event.job_id);
    cursor = event.event_id; await save();
  };
  let attempts = 0; let everConnected = false;
  try {
    while (!abort.signal.aborted) {
      try {
        const response = await controllerFetch(endpoint(base, '/v1/events/stream', { after: cursor }), token, { signal: abort.signal, headers: { accept: 'text/event-stream', 'last-event-id': String(cursor) } });
        if (!response.body) throw unreachable();
        everConnected = true; attempts = 0;
        await connected();
        const pending: JobEvent[] = [];
        const parse = createSseParser((message) => {
          let value: unknown; try { value = JSON.parse(message.data); } catch { return; }
          const event = jobEventSchema.safeParse(value); if (event.success && event.data.event_id > (cursor ?? 0)) pending.push(event.data);
        });
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          parse(decoder.decode(chunk, { stream: true }));
          while (pending.length) await handle(pending.shift()!);
        }
        disconnectedAt ??= now(); // the stream ended: the controller stopped or restarted
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof AutosError && (error.code !== 'UPSTREAM' || !everConnected)) throw error;
        await markUnreachable();
      }
      if (abort.signal.aborted) break;
      attempts++;
      log({ event: 'teams_relay_reconnecting', attempt: attempts, last_event_id: cursor });
      await waitForSignalOrTimeout(abort.signal, dependencies.reconnectDelayMs ?? Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 10_000));
    }
    // The relay is exiting (Ctrl-C): say so, once, with a short deadline that the stop itself does not cancel.
    if (everConnected && wanted.has('AUTOS_DOWN')) await postLifecycle('AUTOS_DOWN', { variant: 'relay_stopped' }, { signal: AbortSignal.timeout(5_000), attempts: 1 }).catch(() => undefined);
    return 0;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); external?.removeEventListener('abort', stop); }
}

async function monitorCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const command = args[0]!;
  const options = parseMonitorArgs(command, args.slice(1));
  const token = (dependencies.env ?? process.env)[config.api.operator_token_env] ?? '';
  if (!token) throw new AutosError('INVALID_CONFIG', `Operator token environment variable ${config.api.operator_token_env} must be set to call the controller`);
  const base = controllerBase(config, options.url);
  if (command === 'status') {
    const body = await controllerJson(endpoint(base, '/v1/status'), token);
    if (!isRecord(body) || !isRecord(body.controller) || !isRecord(body.activity)) throw new AutosError('UPSTREAM', 'Controller returned an unexpected status response');
    stdout(json ? JSON.stringify(body, null, 2) : formatStatus(body as unknown as StatusResponse));
    return 0;
  }
  if (command === 'events') {
    const path = options.job ? `/v1/jobs/${options.job}/events` : '/v1/events';
    const body = await controllerJson(endpoint(base, path, { after: options.after, limit: options.limit }), token);
    const events = isRecord(body) && Array.isArray(body.events) ? body.events.map((item) => jobEventSchema.safeParse(item)) : null;
    if (!events || events.some((item) => !item.success)) throw new AutosError('UPSTREAM', 'Controller returned an unexpected events response');
    const parsedEvents = events.map((item) => (item as { data: JobEvent }).data);
    if (json) stdout(JSON.stringify({ events: parsedEvents, next_after: (body as { next_after?: unknown }).next_after }, null, 2));
    else for (const event of parsedEvents) stdout(formatEvent(event));
    return 0;
  }
  return watchEvents(base, token, options, json, dependencies, stdout, stderr);
}

const MAX_NOTE_CHARS = 4000;
const MAX_RUN_NOTES = 5;
const NOTE_ROLES = ['swe', 'qa', 'reviewer'] as const;

function validNote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NOTE_CHARS) throw new AutosError('INVALID_INPUT', `A note must contain 1 to ${MAX_NOTE_CHARS} characters`);
  return trimmed;
}

function parseRoles(value: string): Array<(typeof NOTE_ROLES)[number]> {
  const roles = value.split(',').map((item) => item.trim());
  if (roles.length < 1 || roles.length > 3 || new Set(roles).size !== roles.length || roles.some((role) => !(NOTE_ROLES as readonly string[]).includes(role))) throw new AutosError('INVALID_INPUT', '--roles must be a comma-separated subset of swe,qa,reviewer');
  return roles as Array<(typeof NOTE_ROLES)[number]>;
}

/** Bounded read of a note file (UTF-8 characters never exceed 4 bytes, so the bytes read are capped before decoding). */
async function readNoteFile(value: string, dependencies: CliDependencies): Promise<string> {
  let text: string;
  try {
    const path = isAbsolute(value) ? value : resolve(dependencies.cwd ?? process.cwd(), value);
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(MAX_NOTE_CHARS * 4 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_NOTE_CHARS * 4) throw new AutosError('INVALID_INPUT', `--note-file must contain at most ${MAX_NOTE_CHARS} characters`);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_INPUT', '--note-file could not be read');
  }
  return validNote(text);
}

const reviseUsage = 'Usage: autos revise JOB_ID|ISSUE-123 --note TEXT [--note-file PATH] [--roles swe,qa,reviewer] [--tier TIER[:EFFORT]] [--effort LEVEL] [--wait] [--url URL]';

/** `--tier TIER[:EFFORT]` plus an optional `--effort LEVEL` (syntax only; the controller checks the tier and floor). */
function parseTierFlags(tier: string | undefined, effort: string | undefined, usage: string): TierStepRef | undefined {
  if (tier === undefined) {
    if (effort !== undefined) throw new AutosError('INVALID_INPUT', `--effort requires --tier. ${usage}`);
    return undefined;
  }
  const ref = parseTierStep(tier);
  if (!ref) throw new AutosError('INVALID_INPUT', `Tier must be TIER or TIER:EFFORT (a model_tiers name; the effort overrides every Claude/Codex entry of the tier; one of ${EFFORT_LEVELS.join(', ')}). ${usage}`);
  if (effort === undefined) return ref;
  if (ref.effort !== undefined) throw new AutosError('INVALID_INPUT', `Give the effort either as TIER:EFFORT or with --effort, not both. ${usage}`);
  const level = effortSchema.safeParse(effort);
  if (!level.success) throw new AutosError('INVALID_INPUT', `--effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  return { tier: ref.tier, effort: level.data };
}

async function reviseCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const target = args[0];
  const byIssue = target !== undefined && ISSUE_KEY.test(target);
  if (!target || (!byIssue && !UUID.test(target))) throw new AutosError('INVALID_INPUT', reviseUsage);
  const texts: string[] = []; let roles: string[] | undefined; let wait = false; let url: string | undefined; let tierArg: string | undefined; let effortArg: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--wait') { wait = true; continue; }
    const value = args[++index];
    if (value === undefined) throw new AutosError('INVALID_INPUT', reviseUsage);
    if (flag === '--note') texts.push(validNote(value));
    else if (flag === '--note-file') texts.push(await readNoteFile(value, dependencies));
    else if (flag === '--roles') roles = parseRoles(value);
    else if (flag === '--url') url = value;
    else if (flag === '--tier' && tierArg === undefined) tierArg = value;
    else if (flag === '--effort' && effortArg === undefined) effortArg = value;
    else throw new AutosError('INVALID_INPUT', reviseUsage);
  }
  if (texts.length === 0) throw new AutosError('INVALID_INPUT', reviseUsage);
  const pin = parseTierFlags(tierArg, effortArg, reviseUsage);
  const instructions = validNote(texts.join('\n\n'));
  const body = operatorNoteRequestSchema.safeParse({ instructions, ...(roles ? { roles } : {}) });
  if (!body.success) throw new AutosError('INVALID_INPUT', reviseUsage);
  const payload = { ...body.data, ...(pin ? { tier: pin.tier, ...(pin.effort ? { effort: pin.effort } : {}) } : {}) };
  const token = (dependencies.env ?? process.env)[config.api.operator_token_env] ?? '';
  if (!token) throw new AutosError('INVALID_CONFIG', `Operator token environment variable ${config.api.operator_token_env} must be set to call the controller`);
  const base = controllerBase(config, url);
  const created = await controllerJson(endpoint(base, byIssue ? `/v1/issues/${target}/revisions` : `/v1/jobs/${target}/revisions`), token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), reason: pin !== undefined });
  if (!isRecord(created) || typeof created.job_id !== 'string' || !UUID.test(created.job_id)) throw new AutosError('UPSTREAM', 'Controller returned an unexpected revision response');
  const newId = created.job_id;
  if (!wait) { report(created, json, stdout); return 0; }
  if (!json) stdout(`Revision job ${newId} queued; following progress`);
  const abort = new AbortController();
  const stop = () => abort.abort();
  const external = dependencies.signal;
  if (external) { if (external.aborted) abort.abort(); else external.addEventListener('abort', stop, { once: true }); }
  else { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  let cursor = 0; let finished = false; let attempts = 0;
  try {
    while (!finished && !abort.signal.aborted) {
      try {
        const response = await controllerFetch(endpoint(base, '/v1/events/stream', { job_id: newId, after: cursor }), token, { signal: abort.signal, headers: { accept: 'text/event-stream', 'last-event-id': String(cursor) } });
        if (!response.body) throw unreachable();
        attempts = 0;
        const parse = createSseParser((message) => {
          let value: unknown; try { value = JSON.parse(message.data); } catch { return; }
          const event = jobEventSchema.safeParse(value);
          if (!event.success) return;
          cursor = event.data.event_id;
          if (!json) stdout(formatEvent(event.data));
          if (event.data.type === 'job_finished' && event.data.job_id === newId) finished = true;
        });
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { parse(decoder.decode(chunk, { stream: true })); if (finished) { abort.abort(); break; } }
      } catch (error) {
        if (finished || abort.signal.aborted) break;
        if (error instanceof AutosError && error.code !== 'UPSTREAM') throw error;
      }
      if (finished || abort.signal.aborted) break;
      attempts++;
      stderr(JSON.stringify({ event: 'wait_reconnecting', attempt: attempts, last_event_id: cursor }));
      await waitForSignalOrTimeout(abort.signal, dependencies.reconnectDelayMs ?? Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 10_000));
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); external?.removeEventListener('abort', stop); }
  if (!finished) throw new AutosError('UPSTREAM', 'Stopped waiting before the revision job finished');
  const final = await controllerJson(endpoint(base, `/v1/jobs/${newId}`), token);
  report(final, json, stdout);
  return isRecord(final) && final.state === 'READY_FOR_HUMAN' ? 0 : 1;
}

// ---- Issue closure, issue view and workspace hygiene: thin HTTP clients of the running controller ----

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${SIZE_UNITS[unit]}`;
}
function formatAge(modifiedAt: string, now: number): string {
  const ms = Date.parse(modifiedAt);
  if (!Number.isFinite(ms)) return '-';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  return seconds >= 86_400 ? `${Math.floor(seconds / 86_400)}d${String(Math.floor((seconds % 86_400) / 3600)).padStart(2, '0')}h` : formatDuration(seconds - (seconds % 60));
}
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}
/** State with the issue resolution, e.g. `READY_FOR_HUMAN (merged)`. */
export function stateLabel(state: string | null, closedAs: string | null | undefined): string {
  return `${state ?? '-'}${closedAs ? ` (${closedAs.toLowerCase()})` : ''}`;
}
function decision(entry: WorkspaceEntry): string {
  return entry.removable ? `remove (${entry.removable})` : entry.retained_because ? `keep (${entry.retained_because})` : 'keep';
}
export function formatWorkspaces(entries: WorkspaceEntry[], now = Date.now()): string[] {
  if (entries.length === 0) return ['No workspace directories.'];
  return table(['WORKSPACE', 'ISSUE', 'STATE', 'AGE', 'SIZE', 'DECISION'], entries.map((entry) => [entry.name.slice(0, 8), entry.issue_key ?? '(orphan)', stateLabel(entry.state, entry.closed_as), formatAge(entry.modified_at, now), formatBytes(entry.size_bytes), decision(entry)]));
}
function removedLines(removed: WorkspaceEntry[], failed: Array<{ name: string; code: string }>, dryRun: boolean): string[] {
  const lines = [`Workspaces ${dryRun ? 'that would be removed' : 'removed'}: ${removed.length}${removed.length ? ` (${removed.map((entry) => entry.name.slice(0, 8)).join(', ')})` : ''}`];
  if (failed.length) lines.push(`Workspaces that could not be removed: ${failed.length} (${failed.map((entry) => `${entry.name.slice(0, 8)} ${entry.code}`).join(', ')}); run the command again to retry`);
  return lines;
}
export function formatClosure(closure: IssueClosure): string[] {
  return [
    `${closure.issue_key} closed as ${closure.resolution} at ${closure.closed_at} by ${closure.closed_by}`,
    `Latest job: ${closure.job_id ?? 'none'}  commit: ${closure.commit_sha ?? 'none'}  branch: ${closure.feature_branch ?? 'none'}`,
  ];
}
export function formatClose(result: CloseIssueResult): string {
  const { closure } = result;
  return [
    result.dry_run ? `DRY RUN: nothing changed. Closing ${closure.issue_key} as ${closure.resolution} would:` : `Closed ${closure.issue_key} as ${closure.resolution} (by ${closure.closed_by})`,
    `Latest job: ${closure.job_id ?? 'none'}  commit: ${closure.commit_sha ?? 'none'}  branch: ${closure.feature_branch ?? 'none'}`,
    ...removedLines(result.removed, result.failed, result.dry_run),
    'Artifacts (evidence) are kept. Jira and Bitbucket were not changed; Autos does not verify the merge.',
  ].join('\n');
}
export function formatPrune(result: PruneWorkspacesResult): string {
  return [
    result.dry_run ? 'DRY RUN: nothing removed.' : 'Prune finished.',
    ...removedLines(result.removed, result.failed, result.dry_run),
    ...(result.removed.length ? formatWorkspaces(result.removed) : []),
    `${result.dry_run ? 'Would remain' : 'Remaining'}: ${result.remaining} workspace director${result.remaining === 1 ? 'y' : 'ies'}${result.freed_bytes !== null ? `; ${result.dry_run ? 'would free' : 'freed'} ${formatBytes(result.freed_bytes)}` : ''}`,
  ].join('\n');
}
export function formatIssue(detail: { issue_key: string; closure: IssueClosure | null; ticket_notes?: TicketNotesSummary | undefined; jobs: Array<Pick<JobRecord, 'job_id' | 'state' | 'dry_run' | 'updated_at'> & { revision?: number | undefined; closed_as?: string | undefined; feature_branch?: string | undefined; commit_sha?: string | undefined; resume_at?: string | undefined; pause_code?: string | undefined; paused_role?: string | undefined }> }): string {
  const lines = detail.closure ? formatClosure(detail.closure) : [`${detail.issue_key} is open (not closed)`];
  const ticket = detail.ticket_notes && (detail.ticket_notes.notes.length > 0 || detail.ticket_notes.held || detail.ticket_notes.tier_pins.length > 0) ? ['', ...formatTicketDetail(detail.ticket_notes, 'Ticket notes')] : [];
  if (detail.jobs.length === 0) return [...lines, 'No attempts.', ...ticket].join('\n');
  const paused = detail.jobs.filter((job) => job.state === 'PAUSED').map((job) => `Paused ${job.job_id}: every ${job.paused_role ?? 'role'} provider limited (${job.pause_code ?? 'RATE_LIMIT'}); resumes at ${job.resume_at ?? 'unknown'} with the same workspace and base (cancel with autos jobs cancel)`);
  return [...lines, '', ...table(['JOB', 'STATE', 'REV', 'DRY', 'BRANCH', 'COMMIT', 'UPDATED'], detail.jobs.map((job) => [job.job_id, stateLabel(job.state, job.closed_as), String(job.revision ?? 0), job.dry_run ? 'yes' : 'no', job.feature_branch ?? '-', job.commit_sha?.slice(0, 12) ?? '-', job.updated_at])), ...paused, ...ticket].join('\n');
}

function parseFlags(args: string[], spec: { bool: readonly string[]; value: readonly string[] }, usage: string): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>(); const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (spec.bool.includes(arg) && !flags.has(arg)) flags.add(arg);
    else if (spec.value.includes(arg) && !values.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new AutosError('INVALID_INPUT', usage);
      values.set(arg, value);
    } else throw new AutosError('INVALID_INPUT', usage);
  }
  return { flags, values };
}
function operatorToken(config: AutosConfig, dependencies: CliDependencies): string {
  const token = (dependencies.env ?? process.env)[config.api.operator_token_env] ?? '';
  if (!token) throw new AutosError('INVALID_CONFIG', `Operator token environment variable ${config.api.operator_token_env} must be set to call the controller`);
  return token;
}
function parseResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AutosError('UPSTREAM', `Controller returned an unexpected ${what} response`);
  return parsed.data;
}
async function defaultPrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(question); } finally { rl.close(); }
}

const closeUsage = 'Usage: autos close ISSUE-123 --merged|--abandoned [--note TEXT] [--dry-run] [--yes] [--url URL]';
async function closeCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const issueKey = args[0];
  if (!issueKey || !ISSUE_KEY.test(issueKey)) throw new AutosError('INVALID_INPUT', closeUsage);
  const { flags, values } = parseFlags(args.slice(1), { bool: ['--merged', '--abandoned', '--dry-run', '--yes'], value: ['--note', '--url'] }, closeUsage);
  if (flags.has('--merged') === flags.has('--abandoned')) throw new AutosError('INVALID_INPUT', `Exactly one of --merged or --abandoned is required. ${closeUsage}`);
  const resolution = flags.has('--merged') ? 'MERGED' : 'ABANDONED';
  const note = values.get('--note');
  if (note !== undefined) validCloseNote(note);
  const dryRun = flags.has('--dry-run');
  const interactive = dependencies.stdinIsTTY ?? process.stdin.isTTY === true;
  if (!dryRun && !flags.has('--yes') && !interactive) throw new AutosError('INVALID_INPUT', 'Closing an issue is irreversible and removes its workspaces; pass --yes to confirm when not running on a terminal (or --dry-run to preview)');
  const token = operatorToken(config, dependencies);
  const base = controllerBase(config, values.get('--url'));
  const call = async (dry: boolean): Promise<CloseIssueResult> => parseResponse(closeIssueResultSchema, await controllerJson(endpoint(base, `/v1/issues/${issueKey}/close`), token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution, dry_run: dry, ...(note !== undefined ? { note: note.trim() } : {}) }) }), 'close');
  if (!dryRun && !flags.has('--yes')) {
    const preview = await call(true);
    stdout(formatClose(preview));
    const answer = await (dependencies.prompt ?? defaultPrompt)(`Close ${issueKey} as ${resolution} and remove these workspaces? This cannot be undone. [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) { stdout('Aborted; nothing changed.'); return 1; }
  }
  const result = await call(dryRun);
  report(json ? result : formatClose(result), json, stdout);
  return result.failed.length > 0 ? 1 : 0;
}
function validCloseNote(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) throw new AutosError('INVALID_INPUT', 'A close note must contain 1 to 2000 characters');
}

async function showCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const usage = 'Usage: autos show ISSUE-123 [--url URL]';
  const issueKey = args[0];
  if (!issueKey || !ISSUE_KEY.test(issueKey)) throw new AutosError('INVALID_INPUT', usage);
  const { values } = parseFlags(args.slice(1), { bool: [], value: ['--url'] }, usage);
  const body = await controllerJson(endpoint(controllerBase(config, values.get('--url')), `/v1/issues/${issueKey}`), operatorToken(config, dependencies));
  if (!isRecord(body) || typeof body.issue_key !== 'string') throw new AutosError('UPSTREAM', 'Controller returned an unexpected issue response');
  const detail = { issue_key: body.issue_key, closure: parseResponse(issueClosureSchema.nullable(), body.closure, 'issue'), jobs: parseResponse(jobRecordSchema.array(), body.jobs, 'issue'), ...(body.ticket_notes !== undefined ? { ticket_notes: parseResponse(ticketNotesSummarySchema, body.ticket_notes, 'issue') } : {}) };
  report(json ? detail : formatIssue(detail), json, stdout);
  return 0;
}

// ---- Ticket notes: guidance stored by issue key (before or after Autos sees the issue) and a hold ----

const NOTE_STATUS_LABELS: Record<TicketNotesSummary['status'], string> = {
  not_seen: 'not seen', held: 'held', queued: 'queued', in_progress: 'in progress', planned: 'planned', awaiting_review: 'awaiting review',
  blocked: 'blocked', cancelled: 'cancelled', closed_merged: 'merged', closed_abandoned: 'abandoned',
};
/** Role counts across notes, e.g. `3 (swe:2 qa:1)`; a note for several roles counts once per role. */
function rolesSummary(notes: TicketNote[]): string {
  if (notes.length === 0) return '0';
  const parts = NOTE_ROLES.map((role) => ({ role, count: notes.filter((note) => note.roles.includes(role)).length })).filter((entry) => entry.count > 0).map((entry) => `${entry.role}:${entry.count}`);
  return `${notes.length} (${parts.join(' ')})`;
}
function seenByAutos(entry: TicketNotesSummary): boolean { return entry.attempts + entry.dry_runs > 0; }
function currentNotesUsed(entry: TicketNotesSummary): string {
  return !seenByAutos(entry) || entry.notes.length === 0 ? 'n/a' : entry.attempts_with_current_notes > 0 ? 'yes' : 'no';
}
/** A pin's step label, e.g. `med:xhigh` (`med` when its entries keep their configured effort). */
export function tierPinLabel(pin: Pick<TierPin, 'tier' | 'effort'>): string {
  return formatTierStep({ tier: pin.tier, ...(pin.effort ? { effort: pin.effort } : {}) });
}
/** Pins in one cell, e.g. `swe=med:xhigh qa=lg`; `-` when none. */
function tierPinsSummary(pins: TierPin[]): string {
  return pins.length === 0 ? '-' : pins.map((pin) => `${pin.role}=${tierPinLabel(pin)}`).join(' ');
}
export function formatTierPins(pins: TierPin[]): string[] {
  return pins.map((pin) => `  ${pin.role}: ${tierPinLabel(pin)} by ${pin.author} at ${pin.created_at}`);
}
export function formatTicketNotesTable(entries: TicketNotesSummary[], now = Date.now()): string[] {
  if (entries.length === 0) return ['No issues with ticket notes, a hold or tier pins.'];
  return table(['KEY', 'NOTES', 'HELD', 'TIER', 'STATUS', 'ATTEMPTS', 'LATEST', 'CURRENT NOTES USED'], entries.map((entry) => [
    entry.issue_key, rolesSummary(entry.notes), entry.held ? 'yes' : 'no', tierPinsSummary(entry.tier_pins), NOTE_STATUS_LABELS[entry.status],
    `${entry.attempts}${entry.dry_runs > 0 ? ` (+${entry.dry_runs} dry)` : ''}`,
    entry.latest_state ? `${entry.latest_state}${entry.last_activity_at ? ` ${formatAge(entry.last_activity_at, now)} ago` : ''}` : '-',
    currentNotesUsed(entry),
  ]));
}
/** One issue in detail, including the note texts (shown to the operator only; never logged or put in events). */
export function formatTicketDetail(entry: TicketNotesSummary, title?: string, now = Date.now()): string[] {
  const lines = [`${title ?? entry.issue_key}${title ? ` (${entry.issue_key})` : ''}: ${NOTE_STATUS_LABELS[entry.status]}${entry.held ? ', HELD from automatic discovery' : ''}`];
  lines.push(`Attempts: ${entry.attempts}${entry.dry_runs > 0 ? ` (+${entry.dry_runs} dry run${entry.dry_runs === 1 ? '' : 's'})` : ''}${entry.latest_state ? `  latest: ${entry.latest_state}${entry.latest_job_id ? ` ${entry.latest_job_id}` : ''}${entry.last_activity_at ? ` ${formatAge(entry.last_activity_at, now)} ago` : ''}` : ''}  current notes used: ${currentNotesUsed(entry)}`);
  if (entry.notes.length === 0) lines.push('No ticket notes.');
  else {
    lines.push(`Notes (${entry.notes.length}/${MAX_TICKET_NOTES}), applied to every attempt until removed:`);
    for (const note of entry.notes) {
      lines.push(`  [${note.roles.join(',')}] ${note.note_id} by ${note.author} at ${note.created_at}`);
      for (const line of note.instructions.split(/\r?\n/)) lines.push(`    ${line}`);
    }
  }
  if (entry.tier_pins.length > 0) lines.push('Tier pins (starting step of each later attempt until cleared; never below the floor):', ...formatTierPins(entry.tier_pins));
  return lines;
}

const noteUsage = 'Usage: autos note ISSUE-123 [--roles swe,qa,reviewer] --note TEXT | --swe TEXT | --qa TEXT | --reviewer TEXT | --all TEXT | --note-file PATH (repeatable, --roles before the notes it applies to) [--hold] [--tier TIER[:EFFORT] [--effort LEVEL]] [--url URL] | autos note ISSUE-123 --list | --remove NOTE_ID | --clear | --hold | --release [--url URL]';
const SHORTHAND_ROLES: Record<string, Array<(typeof NOTE_ROLES)[number]>> = { '--swe': ['swe'], '--qa': ['qa'], '--reviewer': ['reviewer'], '--all': ['swe', 'qa', 'reviewer'] };

async function noteCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const issueKey = args[0];
  if (!issueKey || !ISSUE_KEY.test(issueKey)) throw new AutosError('INVALID_INPUT', noteUsage);
  // Notes keep their command-line order. `--roles` sets the roles of the --note/--note-file flags that FOLLOW it (default
  // swe); the shorthands carry their own roles and ignore it.
  const adds: Array<{ instructions: string; roles: Array<(typeof NOTE_ROLES)[number]> }> = [];
  let currentRoles: Array<(typeof NOTE_ROLES)[number]> = ['swe']; let pendingRoles = false;
  let list = false; let clear = false; let hold = false; let release = false; let remove: string | undefined; let url: string | undefined;
  let tierArg: string | undefined; let effortArg: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--list' && !list) list = true;
    else if (flag === '--clear' && !clear) clear = true;
    else if (flag === '--hold' && !hold) hold = true;
    else if (flag === '--release' && !release) release = true;
    else if (['--remove', '--url', '--roles', '--note', '--note-file', '--tier', '--effort', ...Object.keys(SHORTHAND_ROLES)].includes(flag)) {
      const value = args[++index];
      if (value === undefined) throw new AutosError('INVALID_INPUT', noteUsage);
      if (flag === '--remove' && remove === undefined) { if (!UUID.test(value)) throw new AutosError('INVALID_INPUT', '--remove requires a note id (see autos note KEY --list)'); remove = value; }
      else if (flag === '--url' && url === undefined) url = value;
      else if (flag === '--tier' && tierArg === undefined) tierArg = value;
      else if (flag === '--effort' && effortArg === undefined) effortArg = value;
      else if (flag === '--roles') { currentRoles = parseRoles(value); pendingRoles = true; }
      else if (flag === '--note') { adds.push({ instructions: validNote(value), roles: currentRoles }); pendingRoles = false; }
      else if (flag === '--note-file') { adds.push({ instructions: await readNoteFile(value, dependencies), roles: currentRoles }); pendingRoles = false; }
      else if (SHORTHAND_ROLES[flag]) adds.push({ instructions: validNote(value), roles: SHORTHAND_ROLES[flag]! });
      else throw new AutosError('INVALID_INPUT', noteUsage);
    } else throw new AutosError('INVALID_INPUT', noteUsage);
  }
  if (pendingRoles) throw new AutosError('INVALID_INPUT', `--roles applies to the --note or --note-file that follows it; none follows. ${noteUsage}`);
  const pin = parseTierFlags(tierArg, effortArg, noteUsage);
  const manage = [list, clear, release, remove !== undefined].filter(Boolean).length;
  if (manage > 1 || (manage === 1 && (adds.length > 0 || hold || pin))) throw new AutosError('INVALID_INPUT', `--list, --remove, --clear and --release cannot be combined with each other or with adding notes (only --hold and --tier can accompany new notes). ${noteUsage}`);
  if (hold && release) throw new AutosError('INVALID_INPUT', `--hold and --release cannot be combined. ${noteUsage}`);
  if (manage === 0 && !hold && !pin && adds.length === 0) throw new AutosError('INVALID_INPUT', noteUsage);
  if (adds.length > MAX_TICKET_NOTES) throw new AutosError('INVALID_INPUT', `At most ${MAX_TICKET_NOTES} notes can be stored for one issue`);
  const token = operatorToken(config, dependencies);
  const base = controllerBase(config, url);
  const issuePath = `/v1/issues/${issueKey}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  if (list) { const entry = parseResponse(ticketNotesSummarySchema, await controllerJson(endpoint(base, `${issuePath}/notes`), token), 'ticket notes'); report(json ? entry : formatTicketDetail(entry, undefined, dependencies.now?.() ?? Date.now()).join('\n'), json, stdout); return 0; }
  if (remove !== undefined || clear) {
    const body = await controllerJson(endpoint(base, remove !== undefined ? `${issuePath}/notes/${remove}` : `${issuePath}/notes`), token, { method: 'DELETE' });
    if (!isRecord(body) || typeof body.removed !== 'number') throw new AutosError('UPSTREAM', 'Controller returned an unexpected ticket notes response');
    report(json ? body : `Removed ${body.removed} ticket note${body.removed === 1 ? '' : 's'} from ${issueKey}. Attempts created later no longer receive ${body.removed === 1 ? 'it' : 'them'}; attempts that already started keep their copy.`, json, stdout);
    return 0;
  }
  if (release) {
    const body = await controllerJson(endpoint(base, `${issuePath}/hold`), token, { method: 'DELETE' });
    report(json ? body : `${issueKey} released: automatic discovery may queue it again.`, json, stdout);
    return 0;
  }
  const stored: Array<TicketNote & { jira?: unknown }> = []; let jira: string = 'unchecked';
  for (const add of adds) {
    const body = await controllerJson(endpoint(base, `${issuePath}/notes`), token, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(add) });
    const note = parseResponse(ticketNoteSchema.extend({ jira: z.enum(['found', 'not_found', 'unchecked']) }), body, 'ticket note');
    stored.push(note); jira = note.jira;
    if (!json) stdout(`Stored note ${note.note_id} for ${issueKey} (roles: ${note.roles.join(', ')})`);
  }
  let held: boolean | undefined;
  if (hold) {
    const body = await controllerJson(endpoint(base, `${issuePath}/hold`), token, { method: 'PUT' });
    if (!isRecord(body) || typeof body.held !== 'boolean') throw new AutosError('UPSTREAM', 'Controller returned an unexpected hold response');
    held = body.held;
  }
  const tier = pin ? await putTierPin(base, token, issueKey, { role: 'swe', ...pin }) : undefined;
  if (json) { report({ issue_key: issueKey, notes: stored, ...(stored.length ? { jira } : {}), ...(held !== undefined ? { held } : {}), ...(tier ? { tier } : {}) }, true, stdout); return 0; }
  if (stored.length) {
    stdout(jira === 'not_found' ? `WARN ${issueKey} is not in Jira yet \u2014 note kept; check the key for typos. Autos applies the notes when the issue appears.` : jira === 'found' ? `Jira: ${issueKey} found.` : 'Jira: not checked.');
    stdout(`These notes apply to every attempt of ${issueKey} (including retries and revisions) until removed with autos note ${issueKey} --remove NOTE_ID or --clear.`);
  }
  if (held) stdout(`${issueKey} held: automatic discovery will not queue it until \`autos note ${issueKey} --release\`.`);
  if (tier) for (const line of formatTierPinResult(issueKey, tier)) stdout(line);
  return 0;
}

// ---- Model-tier pins: a role's starting step for every later attempt of an issue key ----

async function putTierPin(base: URL, token: string, issueKey: string, pin: { role: (typeof NOTE_ROLES)[number] } & TierStepRef): Promise<TierPinResult> {
  const body = await controllerJson(endpoint(base, `/v1/issues/${issueKey}/tier`), token, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: pin.role, tier: pin.tier, ...(pin.effort ? { effort: pin.effort } : {}) }), reason: true });
  return parseResponse(tierPinResultSchema, body, 'tier pin');
}
export function formatTierPinResult(issueKey: string, result: TierPinResult): string[] {
  return [
    `Pinned ${result.pin.role} of ${issueKey} to ${result.step} (${result.in_ladder ? 'in the ladder; escalation continues to the next tier' : 'fixed step: not in the role\'s ladder, no escalation'})`,
    `Applies when each later attempt of ${issueKey} is picked up (attempts already running keep their step) until \`autos tier ${issueKey} --clear\`; a revision's --tier still wins for that revision.`,
  ];
}

const tierUsage = 'Usage: autos tier ISSUE-123 TIER[:EFFORT] [--effort LEVEL] [--role swe|qa|reviewer] [--url URL] | autos tier ISSUE-123 --clear [--role swe|qa|reviewer] [--url URL] | autos tier ISSUE-123 [--url URL]';
async function tierCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const issueKey = args[0];
  if (!issueKey || !ISSUE_KEY.test(issueKey)) throw new AutosError('INVALID_INPUT', tierUsage);
  const step = args[1] !== undefined && !args[1].startsWith('--') ? args[1] : undefined;
  const { flags, values } = parseFlags(args.slice(step === undefined ? 1 : 2), { bool: ['--clear'], value: ['--effort', '--role', '--url'] }, tierUsage);
  const roleArg = values.get('--role');
  if (roleArg !== undefined && !(NOTE_ROLES as readonly string[]).includes(roleArg)) throw new AutosError('INVALID_INPUT', '--role must be one of swe, qa, reviewer');
  const role = roleArg as (typeof NOTE_ROLES)[number] | undefined;
  const clear = flags.has('--clear');
  if (clear && (step !== undefined || values.has('--effort'))) throw new AutosError('INVALID_INPUT', `--clear takes no tier or --effort. ${tierUsage}`);
  if (!clear && step === undefined && (role !== undefined || values.has('--effort'))) throw new AutosError('INVALID_INPUT', `--role and --effort need a tier (or --clear for --role). ${tierUsage}`);
  const pin = step === undefined ? undefined : parseTierFlags(step, values.get('--effort'), tierUsage);
  const token = operatorToken(config, dependencies);
  const base = controllerBase(config, values.get('--url'));
  const path = `/v1/issues/${issueKey}/tier`;
  if (clear) {
    const body = await controllerJson(endpoint(base, path, { role }), token, { method: 'DELETE' });
    if (!isRecord(body) || typeof body.removed !== 'number') throw new AutosError('UPSTREAM', 'Controller returned an unexpected tier pin response');
    report(json ? body : `Removed ${body.removed} tier pin${body.removed === 1 ? '' : 's'}${role ? ` (${role})` : ''} from ${issueKey}. Later attempts start from the usual step; attempts already picked up keep theirs.`, json, stdout);
    return 0;
  }
  if (pin) {
    const result = await putTierPin(base, token, issueKey, { role: role ?? 'swe', ...pin });
    if (json) report(result, true, stdout);
    else for (const line of formatTierPinResult(issueKey, result)) stdout(line);
    return 0;
  }
  const body = await controllerJson(endpoint(base, path), token);
  const pins = parseResponse(tierPinSchema.array(), isRecord(body) ? body.pins : undefined, 'tier pin');
  if (json) report({ pins }, true, stdout);
  else stdout(pins.length === 0 ? `No tier pins for ${issueKey}.` : [`Tier pins for ${issueKey} (starting step of each later attempt until cleared; never below the floor):`, ...formatTierPins(pins)].join('\n'));
  return 0;
}

const notesUsage = 'Usage: autos notes [ISSUE-123] [--url URL]';
async function notesCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const issueKey = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : undefined;
  if (issueKey !== undefined && !ISSUE_KEY.test(issueKey)) throw new AutosError('INVALID_INPUT', notesUsage);
  const { values } = parseFlags(issueKey === undefined ? args : args.slice(1), { bool: [], value: ['--url'] }, notesUsage);
  const token = operatorToken(config, dependencies);
  const base = controllerBase(config, values.get('--url'));
  const now = dependencies.now?.() ?? Date.now();
  if (issueKey !== undefined) {
    const entry = parseResponse(ticketNotesSummarySchema, await controllerJson(endpoint(base, `/v1/issues/${issueKey}/notes`), token), 'ticket notes');
    report(json ? entry : formatTicketDetail(entry, undefined, now).join('\n'), json, stdout);
    return 0;
  }
  const body = await controllerJson(endpoint(base, '/v1/notes'), token);
  const tickets = parseResponse(ticketNotesSummarySchema.array(), isRecord(body) ? body.tickets : undefined, 'ticket notes');
  if (json) report({ tickets }, true, stdout);
  else for (const line of formatTicketNotesTable(tickets, now)) stdout(line);
  return 0;
}

const workspacesUsage = 'Usage: autos workspaces [--sizes] [--url URL] | autos workspaces prune [--dry-run] [--older-than HOURS] [--sizes] [--url URL]';
async function workspacesCommand(args: string[], config: AutosConfig, json: boolean, dependencies: CliDependencies, stdout: (text: string) => void): Promise<number> {
  const token = () => operatorToken(config, dependencies);
  const now = dependencies.now?.() ?? Date.now();
  if (args[0] === 'prune') {
    const { flags, values } = parseFlags(args.slice(1), { bool: ['--dry-run', '--sizes'], value: ['--older-than', '--url'] }, workspacesUsage);
    const older = values.get('--older-than');
    if (older !== undefined && (!/^[0-9]{1,4}$/.test(older) || Number(older) > 2160)) throw new AutosError('INVALID_INPUT', '--older-than must be a whole number of hours from 0 to 2160');
    const body = { dry_run: flags.has('--dry-run'), sizes: flags.has('--sizes'), ...(older !== undefined ? { older_than_hours: Number(older) } : {}) };
    const result = parseResponse(pruneWorkspacesResultSchema, await controllerJson(endpoint(controllerBase(config, values.get('--url')), '/v1/workspaces/prune'), token(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 'prune');
    report(json ? result : formatPrune(result), json, stdout);
    return result.failed.length > 0 ? 1 : 0;
  }
  const { flags, values } = parseFlags(args, { bool: ['--sizes'], value: ['--url'] }, workspacesUsage);
  const body = await controllerJson(endpoint(controllerBase(config, values.get('--url')), '/v1/workspaces', flags.has('--sizes') ? { sizes: 'true' } : {}), token());
  if (!isRecord(body) || typeof body.retention_hours !== 'number' || typeof body.auto_prune !== 'boolean') throw new AutosError('UPSTREAM', 'Controller returned an unexpected workspaces response');
  const result = { workspaces: parseResponse(workspaceEntrySchema.array(), body.workspaces, 'workspaces'), retention_hours: body.retention_hours, auto_prune: body.auto_prune };
  if (json) report(result, true, stdout);
  else {
    for (const line of formatWorkspaces(result.workspaces, now)) stdout(line);
    stdout(`Retention: ${result.retention_hours}h for BLOCKED/CANCELLED/superseded/orphan workspaces, auto-prune ${result.auto_prune ? 'ON' : 'OFF'}; the latest READY_FOR_HUMAN workspace of an open issue is kept until \`autos close\`.`);
  }
  return 0;
}

const exportUsage = 'Usage: autos export dataset [--out FILE] [--since ISO] [--issue KEY] [--outcome merged,abandoned,revised,awaiting_review,blocked,cancelled] [--no-prompts] [--no-transcripts]';
async function exportCommand(args: string[], config: AutosConfig, dependencies: CliDependencies, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  if (args[0] !== 'dataset') throw new AutosError('INVALID_INPUT', exportUsage);
  const { flags, values } = parseFlags(args.slice(1), { bool: ['--no-prompts', '--no-transcripts'], value: ['--out', '--since', '--issue', '--outcome'] }, exportUsage);
  const options: DatasetExportOptions = { include_prompts: !flags.has('--no-prompts'), include_transcripts: !flags.has('--no-transcripts') };
  const since = values.get('--since');
  if (since !== undefined) {
    const time = Date.parse(since);
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(since) || Number.isNaN(time)) throw new AutosError('INVALID_INPUT', `--since must be an ISO date or time. ${exportUsage}`);
    options.since = new Date(time).toISOString();
  }
  const issue = values.get('--issue');
  if (issue !== undefined) { if (!ISSUE_KEY.test(issue)) throw new AutosError('INVALID_INPUT', `--issue must look like ABC-123. ${exportUsage}`); options.issue_key = issue; }
  const outcomes = values.get('--outcome');
  if (outcomes !== undefined) {
    const list = outcomes.split(',');
    if (list.length === 0 || !list.every((item) => (DATASET_OUTCOMES as readonly string[]).includes(item))) throw new AutosError('INVALID_INPUT', `--outcome must be a comma-separated list of: ${DATASET_OUTCOMES.join(', ')}`);
    options.outcomes = [...new Set(list)] as NonNullable<DatasetExportOptions['outcomes']>;
  }
  const outPath = values.get('--out');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  if (outPath !== undefined) {
    try { file = await open(resolve(dependencies.cwd ?? process.cwd(), outPath), 'wx', 0o600); }
    catch (error) { throw new AutosError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'CONFLICT' : 'INVALID_INPUT', (error as NodeJS.ErrnoException).code === 'EEXIST' ? '--out file already exists; Autos does not overwrite it' : '--out file could not be created'); }
  }
  const { exportDataset } = await import('@autos/workflow');
  const perOutcome = new Map<string, number>(); let records = 0; let calls = 0; let bytes = 0;
  try {
    for await (const record of exportDataset({ config, options })) {
      const line = JSON.stringify(record);
      if (file) await file.write(`${line}\n`); else stdout(line);
      records++; calls += record.calls.length; bytes += Buffer.byteLength(line) + 1;
      perOutcome.set(record.outcome, (perOutcome.get(record.outcome) ?? 0) + 1);
    }
  } finally { await file?.close(); }
  const breakdown = DATASET_OUTCOMES.filter((name) => perOutcome.has(name)).map((name) => `${name}=${perOutcome.get(name)}`).join(' ');
  stderr(`Exported ${records} record${records === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}, ${calls} provider call${calls === 1 ? '' : 's'}, ${bytes} bytes${outPath ? ` to ${outPath}` : ''}. Contains company source code and agent transcripts: store it like the artifacts.`);
  return 0;
}

export async function main(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? outDefault;
  const stderr = dependencies.stderr ?? errDefault;
  const cwd = dependencies.cwd ?? process.cwd();
  let runtime: CliRuntime | undefined;
  const getRuntime = async (configPath: string) => runtime ??= await (dependencies.runtime ?? defaultRuntime)(configPath);
  try {
    const parsed = resolveConfigPath(args, cwd);
    const commandArgs = parsed.args;
    if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') { stdout(help); return 0; }
    if (commandArgs.length === 1 && commandArgs[0] === '--version') { stdout('0.1.0'); return 0; }
    if (commandArgs[0] === 'init') {
      const result = await commandInit(parsed.path, dependencies); report(result, parsed.json, stdout); return 0;
    }
    if (commandArgs[0] === 'docs' && commandArgs[1] === 'validate' && commandArgs.length === 2) {
      const config = await exampleConfig(cwd);
      const result = await validateOpenApiFile({ config, path: await docsSpecPath(cwd) });
      report(result, parsed.json, stdout); return result.valid ? 0 : 1;
    }
    if (commandArgs[0] === 'docs' && commandArgs[1] === 'preview' && commandArgs.length === 2) {
      const config = await exampleConfig(cwd);
      const controller = await import('@autos/controller');
      const app = await controller.createDocsPreview(schemaOptions(config));
      const host = '127.0.0.1';
      const port = config.api.port < 65535 ? config.api.port + 1 : 0;
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        await app.listen({ host, port });
        const address = app.server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        stdout(`Local API reference: http://${host}:${actualPort}/`);
        await new Promise<void>((resolvePromise) => abort.signal.addEventListener('abort', () => resolvePromise(), { once: true }));
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await app.close(); }
      return 0;
    }
    const config = await readConfig(parsed.path);
    if ((commandArgs[0] === 'status' || commandArgs[0] === 'watch' || commandArgs[0] === 'events')) {
      return await monitorCommand(commandArgs, config, parsed.json, dependencies, stdout, stderr);
    }
    if (commandArgs[0] === 'teams') return await teamsCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout, stderr);
    if (commandArgs[0] === 'export') return await exportCommand(commandArgs.slice(1), config, dependencies, stdout, stderr);
    if (commandArgs[0] === 'revise') return await reviseCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout, stderr);
    if (commandArgs[0] === 'close') return await closeCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'note') return await noteCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'tier') return await tierCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'notes') return await notesCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'show') return await showCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'workspaces') return await workspacesCommand(commandArgs.slice(1), config, parsed.json, dependencies, stdout);
    if (commandArgs[0] === 'doctor' && (commandArgs.length === 1 || (commandArgs.length === 2 && commandArgs[1] === '--deep'))) {
      const deep = commandArgs.length === 2;
      const env = dependencies.env ?? process.env;
      const result = await doctor(config, env, cwd, await supervisedMode(config, env, cwd)) as Record<string, unknown> & { env_references: Array<{ present: boolean }>; roles: Array<{ available: boolean }> };
      let checks: CheckResult[] = [];
      if (deep) {
        let svc: CliRuntime | undefined; let runtimeError: string | undefined;
        try { svc = await getRuntime(parsed.path); } catch (error) { runtimeError = error instanceof AutosError ? error.code : 'INTERNAL'; }
        checks = await deepChecks({ config, env, cwd, runtime: svc, ...(runtimeError ? { runtimeError } : {}), ...(dependencies.deepDoctor ? { deps: dependencies.deepDoctor } : {}) });
        result.deep_checks = checks;
      }
      if (parsed.json || !deep) report(result, parsed.json, stdout);
      else { report({ ...result, deep_checks: undefined }, false, stdout); for (const line of formatChecks(checks)) stdout(line); }
      return result.env_references.every((item) => item.present) && result.roles.every((item) => item.available) && checks.every((check) => check.status !== 'FAIL') ? 0 : 1;
    }
    if (commandArgs[0] === 'providers' && commandArgs.length === 1) {
      const controller = await import('@autos/controller');
      const svc = await getRuntime(parsed.path);
      report({ providers: controller.listProviders(config, await svc.providers()) }, parsed.json, stdout);
      return 0;
    }
    if (commandArgs[0] === 'providers' && commandArgs[1] === 'test' && commandArgs[2] === '--all' && commandArgs.length === 3) {
      const results = await (await getRuntime(parsed.path)).testProviders(); report(results, parsed.json, stdout);
      return results.length === 3 && results.every((result) => result.read_only_smoke === 'PASS') ? 0 : 1;
    }
    if (commandArgs[0] === 'run') {
      const issueKey = commandArgs[1];
      const runUsage = 'Usage: autos run ISSUE-123 [--dry-run] [--note TEXT]...';
      if (!issueKey || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(issueKey)) throw new AutosError('INVALID_INPUT', runUsage);
      let dryRun = false; let sawDryRun = false; const notes: OperatorNoteRequest[] = [];
      for (let index = 2; index < commandArgs.length; index++) {
        const arg = commandArgs[index]!;
        if (arg === '--dry-run' && !sawDryRun) { dryRun = true; sawDryRun = true; }
        else if (arg === '--note' && commandArgs[index + 1] !== undefined && notes.length < MAX_RUN_NOTES) notes.push({ instructions: validNote(commandArgs[++index]!) });
        else throw new AutosError('INVALID_INPUT', runUsage);
      }
      const svc = await getRuntime(parsed.path);
      const submitted = notes.length ? await svc.workflow.submit(issueKey, dryRun, notes) : await svc.workflow.submit(issueKey, dryRun);
      const finished = submitted.state === 'QUEUED' ? await svc.workflow.execute(submitted.job_id) : submitted;
      report(await jobSummary(finished, svc), parsed.json, stdout);
      return successStates.includes(finished.state) ? 0 : 1;
    }
    if (commandArgs[0] === 'retry' && commandArgs[1] === '--all-blocked') {
      const usage = 'Usage: autos retry --all-blocked [--code CODE]';
      let code: string | undefined;
      if (commandArgs.length === 4 && commandArgs[2] === '--code') {
        if (!(ERROR_CODES as readonly string[]).includes(commandArgs[3]!)) throw new AutosError('INVALID_INPUT', `--code must be one of: ${ERROR_CODES.join(', ')}`);
        code = commandArgs[3]!;
      } else if (commandArgs.length !== 2) throw new AutosError('INVALID_INPUT', usage);
      const controller = await import('@autos/controller');
      const result = await controller.retryBlockedJobs((await getRuntime(parsed.path)).workflow, code === undefined ? {} : { code });
      report(parsed.json ? result : `Blocked jobs matched ${result.matched}${code ? ` (code ${code})` : ''}: retried ${result.retried}, skipped (newer attempt exists) ${result.skipped_newer_attempt}, failed ${result.failed}. New attempts are queued; the running controller executes them.`, parsed.json, stdout);
      return result.failed > 0 ? 1 : 0;
    }
    if (commandArgs[0] === 'retry' && commandArgs.length === 2) {
      const svc = await getRuntime(parsed.path);
      const queuedJob = await svc.workflow.retry(commandArgs[1]!);
      const finished = queuedJob.state === 'QUEUED' ? await svc.workflow.execute(queuedJob.job_id) : queuedJob;
      report(await jobSummary(finished, svc), parsed.json, stdout);
      return successStates.includes(finished.state) ? 0 : 1;
    }
    if (commandArgs[0] === 'jobs' && (commandArgs[1] === 'show' || commandArgs[1] === 'cancel') && commandArgs.length === 3) {
      const jobId = commandArgs[2]!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new AutosError('INVALID_INPUT', 'Usage: autos jobs show|cancel JOB_ID');
      const svc = await getRuntime(parsed.path);
      const job = commandArgs[1] === 'show' ? await svc.workflow.get(jobId) : await svc.workflow.cancel(jobId);
      if (!job) throw new AutosError('NOT_FOUND', 'Job not found');
      report(await jobSummary(job, svc), parsed.json, stdout);
      return 0;
    }
    if (commandArgs[0] === 'queue' && commandArgs[1] === 'list') {
      let limit = 50;
      if (commandArgs.length > 2) {
        if (commandArgs.length !== 4 || commandArgs[2] !== '--limit' || !/^[0-9]+$/.test(commandArgs[3]!)) throw new AutosError('INVALID_INPUT', 'Usage: autos queue list [--limit 1..100]');
        limit = Number(commandArgs[3]);
      }
      if (limit < 1 || limit > 100) throw new AutosError('INVALID_INPUT', 'Queue limit must be from 1 to 100');
      const jobs = await (await getRuntime(parsed.path)).workflow.list(limit);
      report(await Promise.all(jobs.map((job) => jobSummary(job))), parsed.json, stdout); return 0;
    }
    if (commandArgs[0] === 'controller' && commandArgs[1] === 'start' && commandArgs.length === 2) {
      const svc = await getRuntime(parsed.path);
      const controller = await import('@autos/controller');
      const bindHost = (dependencies.env ?? process.env).AUTOS_CONTAINER_BIND_HOST;
      if (bindHost && !['127.0.0.1', '::1', '0.0.0.0'].includes(bindHost)) throw new AutosError('INVALID_CONFIG', 'AUTOS_CONTAINER_BIND_HOST is not an allowed bind address');
      const operatorToken = (dependencies.env ?? process.env)[config.api.operator_token_env] ?? '';
      if (operatorToken.length < 16) throw new AutosError('INVALID_CONFIG', `Operator token environment variable ${config.api.operator_token_env} must be set to at least 16 characters`);
      const loop: LoopStatus = { running: false, next_poll_at: null, consecutive_failures: 0, auto_poll: config.jira.auto_poll, last_discovery_at: null };
      const app = await controller.createController({ ...svc, ...(bindHost ? { bindHost } : {}), operatorToken, loopStatus: () => ({ ...loop }), logStream: { write: (line) => stderr(line.replace(/\n$/, '')) } });
      const abort = new AbortController();
      const stop = () => abort.abort();
      const external = dependencies.signal;
      if (external) { if (external.aborted) abort.abort(); else external.addEventListener('abort', stop, { once: true }); }
      else { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
      try {
        const listenHost = bindHost ?? config.api.listen_host;
        await app.listen({ host: listenHost, port: config.api.port });
        const address = app.server.address();
        const boundPort = typeof address === 'object' && address ? address.port : config.api.port;
        stdout(`Autos controller listening on ${listenHost}:${boundPort}`);
        dependencies.onListening?.({ host: listenHost, port: boundPort });
        await runControllerLoop({ workflow: svc.workflow, config, signal: abort.signal, state: loop, stdout, stderr, ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}) });
      } finally { loop.running = false; loop.next_poll_at = null; process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); external?.removeEventListener('abort', stop); await app.close(); runtime = undefined; }
      return 0;
    }
    throw new AutosError('INVALID_INPUT', `Unknown command. Run autos --help.`);
  } catch (error) {
    const known = error instanceof AutosError ? error : undefined;
    const result = known ? { error: { code: known.code, message: known.message } } : { error: { code: 'INTERNAL', message: 'Command failed' } };
    stderr(JSON.stringify(result));
    return known?.code === 'INVALID_INPUT' ? 2 : 1;
  } finally { await runtime?.close?.(); }
}

export { parseConfigYaml };
