import { access, stat, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AutosError, missingToolchains, resolveToolchain, type AutosConfig, type InstalledToolchains } from '@autos/contracts';
import type { ControllerServices } from '@autos/controller';
import { precedentsDeepChecks } from './precedents-doctor.js';

export interface CheckResult { name: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string }

export interface DeepDoctorDeps {
  /** Free bytes available to unprivileged writers on the filesystem holding `path`. Defaults to fs.statfs. */
  freeBytes?(path: string): Promise<number>;
}

export const LOW_DISK_BYTES = 10 * 1024 ** 3;
const NETWORK_TIMEOUT_MS = 60_000;

const code = (error: unknown): string => error instanceof AutosError ? error.code : 'INTERNAL';
const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

async function defaultFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

export type DeepRuntime = Pick<ControllerServices, 'runnerHealth' | 'projects' | 'diagnostics'> & Partial<Pick<ControllerServices, 'precedentIndex'>>;

/**
 * Read-only deep diagnostics for `autos doctor --deep`. Every check is isolated: one failing check never hides the
 * others. Messages are fixed phrases plus counts and error codes: never tokens, URLs, or upstream response text.
 */
export async function deepChecks(input: { config: AutosConfig; env: NodeJS.ProcessEnv; cwd: string; runtime: DeepRuntime | undefined; runtimeError?: string; deps?: DeepDoctorDeps }): Promise<CheckResult[]> {
  const { config, env, cwd, runtime } = input;
  const results: CheckResult[] = [];
  const add = (name: string, status: CheckResult['status'], message: string): void => { results.push({ name, status, message }); };
  const guard = async (name: string, run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (error) { add(name, 'FAIL', `check failed (${code(error)})`); }
  };

  let installed: InstalledToolchains | undefined;

  // Supervisor socket and runner health.
  const socketPath = join(resolve(cwd, config.storage.data_dir), 'runner.sock');
  await guard('supervisor_socket', async () => {
    const info = await stat(socketPath).catch(() => null);
    if (!info) add('supervisor_socket', 'FAIL', `supervisor socket not found at ${join(config.storage.data_dir, 'runner.sock')}; start the runner supervisor`);
    else if (!info.isSocket()) add('supervisor_socket', 'FAIL', 'runner.sock exists but is not a socket');
    else add('supervisor_socket', 'PASS', 'supervisor socket present');
  });
  await guard('runner_health', async () => {
    if (!runtime?.runnerHealth) { add('runner_health', input.runtimeError ? 'FAIL' : 'WARN', input.runtimeError ? `runtime unavailable (${input.runtimeError})` : 'runner health is not available from this runtime'); return; }
    const health = await runtime.runnerHealth();
    if (health.status === 'ready' && health.docker === 'available') add('runner_health', 'PASS', 'runner ready; docker available');
    else if (health.status === 'ready' && health.docker === 'test-only') add('runner_health', 'WARN', 'runner ready in test-only mode; no real isolation boundary');
    else if (health.status === 'ready') add('runner_health', 'FAIL', 'runner reachable but docker is unavailable');
    else if (health.status === 'unknown') add('runner_health', 'WARN', 'runner health is unknown');
    else add('runner_health', 'FAIL', 'runner is unreachable; check the supervisor socket and service');
  });
  await guard('toolchain_report', async () => {
    const health = runtime?.runnerHealth ? await runtime.runnerHealth() : undefined;
    if (health?.status === 'ready') installed = health.toolchains;
  });
  await guard('provider_auth', async () => {
    const health = runtime?.runnerHealth ? await runtime.runnerHealth() : undefined;
    if (!health || health.status !== 'ready') return;
    if (!health.auth) { add('provider_auth', 'WARN', 'supervisor does not report profile modes; update the supervisor'); return; }
    const used = new Map(Object.entries(config.providers).map(([provider, entry]) => [provider, entry.auth_profile]));
    const modes = health.auth.filter((entry) => used.get(entry.provider) === entry.profile);
    const missing = [...used].filter(([provider, profile]) => !modes.some((entry) => entry.provider === provider && entry.profile === profile)).map(([provider, profile]) => `${provider}:${profile}`);
    const summary = modes.map((entry) => `${entry.provider}=${entry.mode}`).join(', ') || 'none';
    const nonSubscription = modes.filter((entry) => entry.mode !== 'subscription');
    if (missing.length) add('provider_auth', 'WARN', `no profile entry for ${missing.join(', ')}; roles on those providers will fail with AUTH (configured: ${summary})`);
    else if (nonSubscription.length) add('provider_auth', 'WARN', `${summary}; ${nonSubscription.map((entry) => entry.provider).join(', ')} bill per token (require_subscription=${health.require_subscription === true})`);
    else add('provider_auth', 'PASS', `${summary} (require_subscription=${health.require_subscription === true})`);
  });
  add('runner_images', 'WARN', 'image presence is not reported by supervisor health; run `autos providers test --all` to prove the worker and checks images');

  // Trusted Git credentials: askpass helper and the token file beside it (never read or printed).
  await guard('git_credentials', async () => {
    const askpass = env.AUTOS_GIT_ASKPASS_PATH;
    const httpsRemotes = config.bitbucket.allowed_repositories.some((repository) => repository.remote_url.startsWith('https://'));
    if (!askpass) { add('git_credentials', httpsRemotes ? 'WARN' : 'PASS', httpsRemotes ? 'AUTOS_GIT_ASKPASS_PATH is not set but https remotes are configured' : 'AUTOS_GIT_ASKPASS_PATH not set (not needed without https remotes)'); return; }
    const helperOk = await access(askpass, constants.X_OK).then(() => true, () => false);
    if (!helperOk) { add('git_credentials', 'FAIL', 'askpass helper is missing or not executable'); return; }
    const tokenOk = await access(join(dirname(askpass), 'bitbucket-token'), constants.R_OK).then(() => true, () => false);
    add('git_credentials', tokenOk ? 'PASS' : 'FAIL', tokenOk ? 'askpass helper executable; token file readable' : 'token file next to the askpass helper is missing or not readable');
  });

  // Jira saved filter and Confluence branch map: one GET each through the existing runtime.
  await guard('jira_filter', async () => {
    if (!runtime?.diagnostics) { add('jira_filter', input.runtimeError ? 'FAIL' : 'WARN', input.runtimeError ? `runtime unavailable (${input.runtimeError})` : 'this runtime does not expose a read-only Jira diagnostic'); return; }
    const { matching_issues } = await runtime.diagnostics.jiraFilter(AbortSignal.timeout(NETWORK_TIMEOUT_MS));
    add('jira_filter', 'PASS', `saved filter ${config.jira.saved_filter_id} readable; matches ${matching_issues} issue(s)`);
  });
  let projects: Awaited<ReturnType<ControllerServices['projects']>> | undefined;
  await guard('confluence_branch_map', async () => {
    if (!runtime) { add('confluence_branch_map', 'FAIL', `runtime unavailable (${input.runtimeError ?? 'UNKNOWN'})`); return; }
    projects = await runtime.projects();
    const enabled = projects.filter((project) => project.enabled).length;
    add('confluence_branch_map', projects.length === 0 || enabled === 0 ? 'FAIL' : 'PASS', `branch map page ${config.confluence.branch_map_page_id}: ${projects.length} project mapping(s), ${enabled} enabled`);
  });
  await guard('toolchains', async () => {
    if (!projects) { add('toolchains', 'WARN', 'skipped: branch map unavailable'); return; }
    const allowed = new Set(config.jira.allowed_projects);
    const profileOf = (id: string | undefined): { jdk?: string; tomcat?: string } | undefined => {
      const profile = id ? config.build_profiles[id] : undefined;
      return profile ? { ...(profile.jdk ? { jdk: profile.jdk } : {}), ...(profile.tomcat ? { tomcat: profile.tomcat } : {}) } : undefined;
    };
    const hint = 'run scripts/install-toolchains.ts to install it on the supervisor host';
    const selections: string[] = [];
    const failures: string[] = [];
    const missing: string[] = [];
    const noJdk: string[] = [];
    let unreported = false;
    for (const mapping of projects.filter((project) => project.enabled && allowed.has(project.project_key))) {
      const repository = config.bitbucket.allowed_repositories.find((entry) => entry.workspace === mapping.workspace && entry.repository_slug === mapping.repository_slug);
      const resolved = resolveToolchain({ jdk: mapping.jdk ?? null, tomcat: mapping.tomcat ?? null }, profileOf(repository?.build_profile));
      if (!resolved.ok) { failures.push(`${mapping.project_key}: ${resolved.reason}`); continue; }
      const selection = resolved.toolchain;
      if (!selection) { noJdk.push(mapping.project_key); continue; }
      selections.push(`${mapping.project_key}: JDK ${selection.jdk}${selection.tomcat ? ` + Tomcat ${selection.tomcat}` : ''}`);
      if (!installed) { unreported = true; continue; }
      const lacking = missingToolchains(selection, installed);
      if (lacking.length) missing.push(`${mapping.project_key} needs ${lacking.join(' and ')} (not installed)`);
    }
    const have = installed ? ` (installed: JDK ${installed.jdk.join(', ') || 'none'}; Tomcat ${installed.tomcat.join(', ') || 'none'})` : '';
    if (failures.length) add('toolchains', 'FAIL', failures.join('; '));
    else if (missing.length) add('toolchains', 'FAIL', `${missing.join('; ')}${have}; ${hint}`);
    else if (unreported) add('toolchains', 'WARN', `${selections.join('; ')}: supervisor does not report installed toolchains; update the supervisor or set AUTOS_TOOLCHAIN_ROOT`);
    else if (noJdk.length) add('toolchains', 'WARN', `${noJdk.join(', ')}: no JDK configured; agents get no Java and checks use the checks image JDK${selections.length ? `; ${selections.join('; ')}${have}` : ''}`);
    else add('toolchains', 'PASS', `${selections.join('; ') || 'no enabled allowed projects'}${have}`);
  });

  // Development branch heads (read-only ls-remote/fetch inside the git runner) for every mapped project.
  for (const repository of config.bitbucket.allowed_repositories) {
    const id = `${repository.workspace}/${repository.repository_slug}`;
    const name = `base_branch:${id}`;
    await guard(name, async () => {
      if (!runtime?.diagnostics) { add(name, 'WARN', 'skipped: no read-only git diagnostic available'); return; }
      if (!projects) { add(name, 'WARN', 'skipped: branch map unavailable'); return; }
      const mapped = projects.filter((project) => project.enabled && project.workspace === repository.workspace && project.repository_slug === repository.repository_slug);
      if (mapped.length === 0) { add(name, 'WARN', 'no enabled project maps to this repository'); return; }
      for (const mapping of mapped) {
        const label = `${name}:${mapping.project_key}`;
        try {
          const base = await runtime.diagnostics.resolveBase(repository, mapping, AbortSignal.timeout(NETWORK_TIMEOUT_MS));
          add(label, 'PASS', `${mapping.project_key}: ${base.development_branch} at ${base.base_sha.slice(0, 12)}`);
        } catch (error) { add(label, 'FAIL', `${mapping.project_key}: could not resolve development branch (${code(error)})`); }
      }
    });
  }

  // Free disk for the three storage roots.
  const freeBytes = input.deps?.freeBytes ?? defaultFreeBytes;
  for (const [label, path] of [['data', config.storage.data_dir], ['artifacts', config.storage.artifacts_dir], ['workspaces', config.storage.workspaces_dir]] as const) {
    const name = `disk:${label}`;
    try {
      const free = await freeBytes(resolve(cwd, path));
      add(name, free < LOW_DISK_BYTES ? 'WARN' : 'PASS', `${gib(free)} free${free < LOW_DISK_BYTES ? ` (below ${gib(LOW_DISK_BYTES)}; free space before long runs)` : ''}`);
    } catch { add(name, 'WARN', 'directory not accessible; free space unknown'); }
  }
  // Semantic precedents (only when configured): index status and lineage summary through the runtime's index.
  if (config.precedents) results.push(...await precedentsDeepChecks(config, runtime?.precedentIndex, input.runtimeError));
  return results;
}

export function formatChecks(results: CheckResult[]): string[] {
  return results.map((result) => `${result.status.padEnd(4)} ${result.name}: ${result.message}`);
}
