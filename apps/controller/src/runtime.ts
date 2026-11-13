import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AutosError, CURSOR_MODEL, PROVIDERS, PROVIDER_EFFORTS, parseConfigYaml, parseTierStep,
  type AtlassianReadPort, type AutosConfig, type ClockPort, type FixDocumentDraftPort, type GitRunnerPort,
  type PrecedentIndexPort, type PrecedentReadPort, type Provider, type ResolvedChainEntry, type RunnerPort,
  type SemanticPrecedentPort, type WorkflowServicePort,
} from '@autos/contracts';
import { ConfluenceDraftWriter, createAtlassianClient, fixDocumentTitle, renderFixDocumentStorage } from '@autos/atlassian';
import { GitRunner, LineageGit } from '@autos/git-runner';
import { OllamaEmbedding, createPrecedentService, type JiraIndexSource, type Judge } from '@autos/precedents';
import { DockerRunnerClient } from '@autos/runner';
import { FileArtifactStore, SqliteJobStore, createWorkflowService } from '@autos/workflow';
import type { ControllerServices, ProviderDiagnostic } from './index.js';
import { KnowledgeGateway } from './knowledge-gateway.js';

export interface RuntimeOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injection is a library/test seam, never a configuration-selectable host fallback. */
  runner?: RunnerPort;
  atlassian?: AtlassianReadPort;
  precedents?: PrecedentReadPort;
  /** Semantic precedent service (index + job lookups); replaces the one built from config.precedents. */
  semanticPrecedents?: PrecedentIndexPort & SemanticPrecedentPort;
  /** Confluence fix-document drafts; replaces the writer built from config.confluence.drafts. */
  fixDocuments?: FixDocumentDraftPort;
  git?: GitRunnerPort;
  clock?: ClockPort;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function normalizeStorage(config: AutosConfig, cwd: string): Promise<void> {
  const paths = Object.values(config.storage).map((path) => resolve(cwd, path));
  for (const path of paths) {
    if (path === resolve(cwd) || path.split(sep).some((part) => ['.git', '.aws', '.codex'].includes(part))) {
      throw new AutosError('INVALID_CONFIG', 'Storage must use dedicated directories');
    }
  }
  for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++) {
    if (isWithin(paths[a]!, paths[b]!) || isWithin(paths[b]!, paths[a]!)) throw new AutosError('INVALID_CONFIG', 'Storage directories must not overlap');
  }
  for (const key of Object.keys(config.storage) as Array<keyof AutosConfig['storage']>) {
    const path = resolve(cwd, config.storage[key]);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    if (canonical === resolve(cwd) || canonical.split(sep).some((part) => ['.git', '.aws', '.codex'].includes(part))) throw new AutosError('INVALID_CONFIG', 'Storage aliases must use dedicated directories');
    config.storage[key] = canonical;
  }
  const realPaths = Object.values(config.storage);
  for (let a = 0; a < realPaths.length; a++) for (let b = a + 1; b < realPaths.length; b++) {
    if (isWithin(realPaths[a]!, realPaths[b]!) || isWithin(realPaths[b]!, realPaths[a]!)) throw new AutosError('INVALID_CONFIG', 'Storage directory aliases must not overlap');
  }
}

async function binaryPresent(binary: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!binary || /[\x00\r\n]/.test(binary)) return false;
  const candidates = binary.includes('/') ? [resolve(cwd, binary)] : (env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(directory, binary));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return true; } catch { /* next PATH entry */ }
  }
  return false;
}

/** Build application services without making a network or model request. */
export async function createRuntime(options: RuntimeOptions = {}): Promise<ControllerServices> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  let config: AutosConfig;
  try { config = parseConfigYaml(await readFile(resolve(cwd, options.configPath ?? 'config/config.yaml'), 'utf8')); }
  catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_CONFIG', 'Configuration file is unavailable');
  }
  try { await normalizeStorage(config, cwd); }
  catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_CONFIG', 'Configured storage is unavailable');
  }

  let client: ReturnType<typeof createAtlassianClient> | undefined;
  function getClient(): ReturnType<typeof createAtlassianClient> {
    if (client) return client;
    const required = [config.jira.username_env, config.jira.token_env, config.confluence.username_env, config.confluence.token_env];
    if (required.some((name) => !env[name]?.trim())) throw new AutosError('AUTH', 'Configured Atlassian credential references are unavailable');
    const bitbucketToken = config.bitbucket.read_token_env ? env[config.bitbucket.read_token_env] : undefined;
    client = createAtlassianClient({ config, credentials: {
      jira: { username: env[config.jira.username_env]!, token: env[config.jira.token_env]! },
      confluence: { username: env[config.confluence.username_env]!, token: env[config.confluence.token_env]! },
      ...(bitbucketToken ? { bitbucketToken } : {}),
    } });
    return client;
  }
  const atlassian: AtlassianReadPort = options.atlassian ?? {
    getSavedFilter: (id, signal) => getClient().getSavedFilter(id, signal),
    listIssueKeys: (jql, signal) => getClient().listIssueKeys(jql, signal),
    listIssues: (jql, signal) => getClient().listIssues(jql, signal),
    getIssue: (key, signal) => getClient().getIssue(key, signal),
    getBranchMap: (id, signal) => getClient().getBranchMap(id, signal),
  };
  const precedents = options.precedents ?? { findPrecedents: (...args: Parameters<PrecedentReadPort['findPrecedents']>) => getClient().precedents.findPrecedents(...args) };
  const runner = options.runner ?? new DockerRunnerClient({ socketPath: join(config.storage.data_dir, 'runner.sock') });
  const trustedCredentials = {
    ...(env.AUTOS_GIT_ASKPASS_PATH ? { gitAskPassPath: env.AUTOS_GIT_ASKPASS_PATH } : {}),
    ...(env.SSH_AUTH_SOCK ? { sshAuthSocket: env.SSH_AUTH_SOCK } : {}),
  };
  const git = options.git ?? new GitRunner({ allowedRepositories: config.bitbucket.allowed_repositories, pushEnabled: config.bitbucket.push_feature_branch, pushBlockedEnabled: config.bitbucket.push_blocked_attempts, trustedCredentials });
  const jobs = new SqliteJobStore(join(config.storage.data_dir, 'autos.sqlite'));
  const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  // Read-only Jira/Confluence tools for agents. The gateway keeps the Atlassian credential on the host; it binds its
  // port only when the first role session opens, so short-lived CLI commands never listen.
  const knowledge = config.knowledge?.enabled ? new KnowledgeGateway({
    config,
    reads: {
      getIssueDetail: (...args) => getClient().getIssueDetail(...args), getIssueComments: (...args) => getClient().getIssueComments(...args),
      getIssueAttachment: (...args) => getClient().getIssueAttachment(...args), searchIssues: (...args) => getClient().searchIssues(...args),
      searchPages: (...args) => getClient().searchPages(...args), getPage: (...args) => getClient().getPage(...args), getPageChildren: (...args) => getClient().getPageChildren(...args),
    },
    log: (record) => { try { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`); } catch { /* logging never fails a job */ } },
  }) : undefined;
  // The index runs whenever precedents.enabled (so it can be built and evaluated with `source: legacy`); jobs use it only
  // when source is 'semantic'.
  const semantic = options.semanticPrecedents ?? (config.precedents?.enabled
    ? createSemanticPrecedents(config, env, getClient, () => atlassian.getBranchMap(config.confluence.branch_map_page_id), runner, artifacts, jobs, trustedCredentials)
    : undefined);
  const jobsUseSemantic = semantic !== undefined && config.precedents?.enabled === true && config.precedents.source === 'semantic';
  const fixDocuments = options.fixDocuments ?? (config.confluence.drafts?.enabled ? createFixDocumentDrafts(config, env) : undefined);
  const service = createWorkflowService({ config, atlassian, precedents, git, runner, jobs, artifacts, clock: options.clock ?? { now: () => new Date() },
    ...(knowledge ? { knowledge } : {}), ...(jobsUseSemantic ? { semanticPrecedents: semantic } : {}), ...(fixDocuments ? { fixDocuments } : {}) });
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closed = false;

  function track<T>(operation: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (closed) return Promise.reject(new AutosError('CONFLICT', 'Runtime is closed'));
    const signal = external ? AbortSignal.any([shutdown.signal, external]) : shutdown.signal;
    const promise = operation(signal);
    active.add(promise);
    void promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  }
  const workflow: WorkflowServicePort = {
    submit: (key, dryRun, notes) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.submit(key, dryRun, notes),
    revise: (id, note, author, pin) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.revise(id, note, author, pin),
    reviseIssue: (key, note, author, pin) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.reviseIssue(key, note, author, pin),
    setTierPin: (key, pin, author) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.setTierPin(key, pin, author),
    clearTierPins: (key, role) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.clearTierPins(key, role),
    tierPins: (key) => service.tierPins(key),
    closeIssue: (key, request, author) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.closeIssue(key, request, author),
    closure: (key) => service.closure(key),
    addTicketNote: (key, note, author) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.addTicketNote(key, note, author),
    removeTicketNotes: (key, noteId) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.removeTicketNotes(key, noteId),
    setTicketHold: (key, held, author) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.setTicketHold(key, held, author),
    ticketNotes: (key) => service.ticketNotes(key),
    workspaces: (opts) => service.workspaces(opts),
    pruneWorkspaces: (request) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.pruneWorkspaces(request),
    retry: (id) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : service.retry(id),
    execute: (id, signal) => track((combined) => service.execute(id, combined), signal),
    poll: (signal) => track((combined) => service.poll(combined), signal),
    discover: (signal) => track((combined) => service.discover(combined), signal),
    drain: (signal) => track((combined) => service.drain(combined), signal),
    cancel: (id) => service.cancel(id), get: (id) => service.get(id), list: (limit, offset) => service.list(limit, offset),
    events: (query) => service.events(query), subscribe: (listener) => service.subscribe(listener), activity: () => service.activity(),
    ...(fixDocuments ? { createFixDocumentDraft: (target: string, signal?: AbortSignal) => closed ? Promise.reject(new AutosError('CONFLICT', 'Runtime is closed')) : track((combined) => service.createFixDocumentDraft(target, combined), signal) } : {}),
  };
  const smokeResults = new Map<Provider, ProviderDiagnostic>();
  const providers = async (): Promise<ProviderDiagnostic[]> => Promise.all(PROVIDERS.map(async (provider) => smokeResults.get(provider) ?? {
    provider, binary_present: await binaryPresent(config.providers[provider].binary, cwd, env), authenticated: null,
    read_only_smoke: 'NOT_RUN' as const, message: 'Host binary presence only; runner authentication has not been tested.',
  }));

  const testProviders = async (): Promise<ProviderDiagnostic[]> => {
    for (const provider of PROVIDERS) {
      const jobId = randomUUID();
      const directory = join(config.storage.workspaces_dir, `smoke-${jobId}`);
      try {
        await mkdir(join(directory, '.git'), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, 'README.md'), 'Autos read-only provider smoke fixture.\n', { mode: 0o600 });
        const files = await artifacts.prepareRole(jobId, 'qa', randomUUID(), 'Read README.md. Do not edit source or run commands. Report that this synthetic read-only provider smoke test completed.');
        // Smoke-test with the model a role would actually use: primary or fallback entry; Cursor is always "auto".
        const model = provider === 'cursor' ? CURSOR_MODEL : Object.values(config.agents)
          .flatMap((role) => [{ provider: role.provider, model: role.model }, ...role.fallbacks])
          .find((choice) => choice.provider === provider)?.model;
        const result = await runner.runRole({ job_id: jobId, issue_key: 'SMOKE-1', provider, role: 'qa', ...(model ? { model } : {}),
          cwd: directory, ...files, timeout_ms: 60_000, source_access: 'read', auth_profile: config.providers[provider].auth_profile }, shutdown.signal);
        const passed = result.status === 'SUCCEEDED' && result.exit_code === 0;
        smokeResults.set(provider, { provider, binary_present: passed || await binaryPresent(config.providers[provider].binary, cwd, env), authenticated: passed ? true : result.error_code === 'AUTH' ? false : null,
          read_only_smoke: passed ? 'PASS' : 'FAIL', message: passed ? 'Read-only runner smoke passed.' : `Read-only runner smoke failed (${result.error_code ?? 'TOOL'}).` });
      } catch (error) {
        smokeResults.set(provider, { provider, binary_present: await binaryPresent(config.providers[provider].binary, cwd, env), authenticated: error instanceof AutosError && error.code === 'AUTH' ? false : null,
          read_only_smoke: 'FAIL', message: 'Read-only runner smoke could not complete; verify the supervisor, images, and provider profile.' });
      } finally {
        await runner.stop(jobId).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }
    return providers();
  };
  return {
    config, workflow, artifacts, providers,
    ...(semantic ? { precedentIndex: semantic } : {}),
    // Read-only checks for `autos doctor --deep` (operator-initiated): Jira GETs and a remote branch lookup only.
    diagnostics: {
      jiraFilter: async (signal?: AbortSignal) => {
        const filter = await atlassian.getSavedFilter(config.jira.saved_filter_id, signal);
        return { matching_issues: (await atlassian.listIssueKeys(filter.jql, signal)).length };
      },
      resolveBase: (repository, mapping, signal) => git.resolveBase(repository, mapping, signal),
      // Read-only lookup used when a ticket note is added: NOT_FOUND means "not in Jira (yet)"; anything else propagates as unchecked.
      jiraIssueExists: async (issueKey: string, signal?: AbortSignal) => {
        try { await atlassian.getIssue(issueKey, signal); return true; }
        catch (error) { if (error instanceof AutosError && error.code === 'NOT_FOUND') return false; throw error; }
      },
    },
    runnerHealth: async () => {
      if (!runner.health) return { status: 'unknown' as const };
      try { return await runner.health(); } catch { return { status: 'unreachable' as const }; }
    },
    projects: () => atlassian.getBranchMap(config.confluence.branch_map_page_id),
    testProviders,
    close: async () => {
      if (closed) return;
      closed = true; shutdown.abort();
      await Promise.allSettled([...active]);
      await knowledge?.stop().catch(() => undefined);
      try { semantic?.close(); } catch { /* best effort */ }
      jobs.close();
    },
  };
}

/** Jira read methods of the Atlassian client in the shape the index sync expects (reads only). */
function jiraIndexSource(getClient: () => ReturnType<typeof createAtlassianClient>): JiraIndexSource {
  return {
    searchIssuesForIndex: async ({ projects, updatedSince, windowWeeks, pageToken, signal }) => {
      const page = await getClient().searchIssuesForIndex({ projects, windowWeeks, ...(updatedSince ? { updatedSince: new Date(updatedSince) } : {}), ...(pageToken ? { nextPageToken: pageToken } : {}) }, signal);
      return { issues: page.issues, nextPageToken: page.nextPageToken ?? null, skipped_restricted: page.skipped_restricted, skipped_invalid: page.skipped_invalid };
    },
    getIndexComments: (issueId, startAt, signal) => getClient().getIndexComments(issueId, startAt, signal),
    listIssueIds: async ({ projects, windowWeeks, pageToken, signal }) => {
      const page = await getClient().listIssueIds({ projects, windowWeeks, ...(pageToken ? { nextPageToken: pageToken } : {}) }, signal);
      return { ids: page.ids, nextPageToken: page.nextPageToken ?? null };
    },
  };
}

/**
 * Model entries for the "same defect?" judge: precedents.judge.tier, else the reviewer's lowest ladder tier, else the
 * triage tier, else the reviewer's primary chain. Low effort where the provider supports it (cheapest model, user decision).
 */
export function judgeEntries(config: AutosConfig): ResolvedChainEntry[] {
  const low = (entries: ResolvedChainEntry[]) => entries.map((e) => PROVIDER_EFFORTS[e.provider].includes('low') && !e.effort ? { ...e, effort: 'low' as const } : e);
  const configured = config.precedents?.judge.tier ? parseTierStep(config.precedents.judge.tier) : null;
  if (configured && Object.hasOwn(config.model_tiers, configured.tier)) {
    const entries = config.model_tiers[configured.tier]!;
    const effort = configured.effort;
    return effort ? entries.map((e) => PROVIDER_EFFORTS[e.provider].includes(effort) ? { ...e, effort } : e) : low(entries);
  }
  const lowest = config.agents.reviewer.ladder?.[0]?.chain;
  if (lowest?.length) return low(lowest);
  if (config.triage && Object.hasOwn(config.model_tiers, config.triage.tier)) return low(config.model_tiers[config.triage.tier]!);
  const reviewer = config.agents.reviewer;
  return low([{ provider: reviewer.provider, ...(reviewer.model ? { model: reviewer.model } : {}), tier: null }, ...reviewer.fallbacks.map((f) => ({ ...f, tier: null }))]);
}

/**
 * Judge through the trusted runner: read-only reviewer sandbox in an empty scratch directory (no repository, no tools
 * beyond the provider's own read access to that empty directory), fresh session per call, provider fallback on
 * provider-side failures. Returns the provider's structured result; the caller validates it.
 */
function runnerJudge(config: AutosConfig, runner: RunnerPort, artifacts: FileArtifactStore): Judge {
  const timeout = config.precedents?.judge.timeout_ms ?? 120_000;
  return {
    judge: async (request, signal) => {
      const entries = judgeEntries(config);
      let lastCode = 'TOOL';
      for (const entry of entries) {
        const directory = join(config.storage.workspaces_dir, `judge-${randomUUID()}`);
        try {
          await mkdir(join(directory, '.git'), { recursive: true, mode: 0o700 });
          const paths = await artifacts.prepareRole(request.job_id, 'reviewer', randomUUID(), request.prompt);
          const result = await runner.runRole({ job_id: request.job_id, issue_key: request.issue_key, provider: entry.provider, role: 'reviewer',
            ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}), cwd: directory, ...paths,
            timeout_ms: timeout, source_access: 'read', auth_profile: config.providers[entry.provider].auth_profile }, signal);
          if (result.status === 'SUCCEEDED' && result.exit_code === 0) return result.result;
          lastCode = result.error_code ?? (result.status === 'TIMED_OUT' ? 'TIMEOUT' : 'TOOL');
          if (lastCode === 'CANCELLED') throw new AutosError('CANCELLED', 'Judge cancelled');
          if (!['AUTH', 'UNAVAILABLE', 'RATE_LIMIT', 'TIMEOUT', 'UPSTREAM', 'TOOL'].includes(lastCode)) break;
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      throw new AutosError(lastCode === 'TIMEOUT' ? 'TIMEOUT' : 'UPSTREAM', 'Precedent judge did not return a verdict');
    },
  };
}

function createSemanticPrecedents(config: AutosConfig, env: NodeJS.ProcessEnv, getClient: () => ReturnType<typeof createAtlassianClient>,
  branchMap: () => ReturnType<AtlassianReadPort['getBranchMap']>, runner: RunnerPort, artifacts: FileArtifactStore, jobs: SqliteJobStore,
  trustedCredentials: { gitAskPassPath?: string; sshAuthSocket?: string }): PrecedentIndexPort & SemanticPrecedentPort {
  const p = config.precedents!;
  // The service requires source 'semantic'; with 'legacy' it builds the index for evaluation while jobs keep the legacy lookup.
  const serviceConfig: AutosConfig = p.source === 'semantic' ? config : { ...config, precedents: { ...p, source: 'semantic' } };
  const embedding = p.embedding.provider === 'ollama'
    ? new OllamaEmbedding({ url: p.embedding.url, model: p.embedding.model!, dims: p.embedding.dimensions!, timeoutMs: p.embedding.timeout_ms, batchSize: p.embedding.batch_size })
    : null;
  const lineageGit = p.lineages.length ? new LineageGit({ trustedCredentials }) : null;
  void env;
  const service = createPrecedentService({
    config: serviceConfig, dataDir: config.storage.data_dir, jira: jiraIndexSource(getClient), branchMap: () => branchMap(),
    lineageGit, embedding, judge: p.judge.enabled ? runnerJudge(config, runner, artifacts) : null,
    autosAttempts: () => autosAttempts(config, jobs),
    log: (record) => { try { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'precedents', ...record })}\n`); } catch { /* logging never fails */ } },
  });
  if (p.source === 'semantic') return service;
  return new Proxy(service, {
    get(target, prop) {
      if (prop === 'status') return async () => ({ ...(await target.status()), source: 'legacy' as const });
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Autos' own READY_FOR_HUMAN attempts with their changed paths and human outcome (fix links of source 'autos'). */
async function autosAttempts(config: AutosConfig, jobs: SqliteJobStore): Promise<Array<{ job_id: string; issue_key: string; repository_id: string; commit_sha: string; changed_paths: string[]; outcome: 'merged' | 'abandoned' | 'awaiting_review' }>> {
  const out: Array<{ job_id: string; issue_key: string; repository_id: string; commit_sha: string; changed_paths: string[]; outcome: 'merged' | 'abandoned' | 'awaiting_review' }> = [];
  for (let offset = 0; offset < 100_000; offset += 500) {
    const page = await jobs.list(500, offset);
    for (const job of page) {
      if (job.dry_run || job.state !== 'READY_FOR_HUMAN' || !job.commit_sha || !job.repository_id) continue;
      let patch = '';
      try { patch = await readFile(join(config.storage.artifacts_dir, job.job_id, 'changes.patch'), 'utf8'); } catch { continue; }
      const changed = [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!))].slice(0, 500);
      const closure = jobs.closure(job.issue_key);
      const outcome = closure ? (closure.resolution === 'MERGED' ? 'merged' : 'abandoned') : 'awaiting_review';
      out.push({ job_id: job.job_id, issue_key: job.issue_key, repository_id: job.repository_id, commit_sha: job.commit_sha, changed_paths: changed, outcome });
    }
    if (page.length < 500) break;
  }
  return out;
}

/** Draft-only Confluence writer for fix documents (plan §12). Uses the controller's Confluence credential. */
function createFixDocumentDrafts(config: AutosConfig, env: NodeJS.ProcessEnv): FixDocumentDraftPort {
  const drafts = config.confluence.drafts!;
  let writer: ConfluenceDraftWriter | undefined;
  const get = () => {
    if (writer) return writer;
    const username = env[config.confluence.username_env]; const token = env[config.confluence.token_env];
    if (!username?.trim() || !token?.trim()) throw new AutosError('AUTH', 'Configured Confluence credential references are unavailable');
    writer = new ConfluenceDraftWriter({ siteUrl: config.confluence.site_url, username, token, spaceKey: drafts.space_key, parentPageId: drafts.parent_page_id });
    return writer;
  };
  return {
    createOrUpdate: async (data, previous, signal) => {
      const content = {
        title: fixDocumentTitle(data.issue_key, data.summary),
        storageBody: renderFixDocumentStorage({ issueKey: data.issue_key, issueUrl: data.issue_url, summary: data.summary, repository: data.repository, branch: data.branch,
          commitSha: data.commit_sha, changedFiles: data.changed_files, checks: data.checks, qa: data.qa, review: data.review, fixSummary: data.fix_summary,
          possiblyAffected: data.possibly_affected, precedentsUsed: data.precedents_used, limitations: data.limitations }),
      };
      if (previous) {
        const updated = await get().updateDraft(previous, content, signal);
        if (!('superseded' in updated)) return { draft: updated, superseded_page_id: null };
        return { draft: await get().createDraft(content, signal), superseded_page_id: previous.page_id };
      }
      return { draft: await get().createDraft(content, signal), superseded_page_id: null };
    },
  };
}
