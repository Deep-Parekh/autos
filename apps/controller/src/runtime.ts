import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AutosError, CURSOR_MODEL, PROVIDERS, parseConfigYaml,
  type AtlassianReadPort, type AutosConfig, type ClockPort, type GitRunnerPort,
  type PrecedentReadPort, type Provider, type RunnerPort, type WorkflowServicePort,
} from '@autos/contracts';
import { createAtlassianClient } from '@autos/atlassian';
import { GitRunner } from '@autos/git-runner';
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
  const service = createWorkflowService({ config, atlassian, precedents, git, runner, jobs, artifacts, clock: options.clock ?? { now: () => new Date() }, ...(knowledge ? { knowledge } : {}) });
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
      jobs.close();
    },
  };
}
