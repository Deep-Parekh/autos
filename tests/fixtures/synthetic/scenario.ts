/**
 * One-call synthetic end-to-end scenario: fake read-only Atlassian, disposable Git remote, fake provider
 * processes, and a TEST-ONLY local runner. See runner.ts for the isolation caveat. Nothing here contacts a
 * real service, runs a real provider, or authenticates anything.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAtlassianClient, type AtlassianClient } from '@autos/atlassian';
import { parseConfigYaml, type AtlassianReadPort, type AutosConfig, type GitPrepareRequest, type GitRunnerPort, type GitWorkspace, type PrecedentReadPort, type Provider } from '@autos/contracts';
import { GitRunner } from '@autos/git-runner';
import { createFakeAtlassianFetch, defaultAtlassianScenario, type AtlassianScenario, type FakeAtlassian } from './atlassian.js';
import { seedFixtureRemote, type FixtureRemote } from './remote.js';
import { createLocalFixtureRunner, type LocalFixtureRunner } from './runner.js';

const providersDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'providers');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface SyntheticScenarioOptions {
  /** Existing empty directory to use; if omitted a fresh temporary directory is created and removed by cleanup(). */
  root?: string;
  /** Override the default Atlassian content (tickets, filter order, mapping rows). */
  atlassian?: AtlassianScenario;
  /** Enable pushing deep/<KEY> to the disposable bare remote (default false, like the product default). */
  pushFeatureBranch?: boolean;
  /** jobs.max_parallel (default 1) and jobs.max_concurrent_checks. */
  maxParallel?: number;
  maxConcurrentChecks?: number;
  /** Deterministic delays inside the local runner so concurrent jobs overlap measurably. */
  roleDelayMs?: number;
  checkDelayMs?: number;
  /** Per-role provider chains (primary plus ordered fallbacks) written into agents.<role>. */
  roleChains?: Partial<Record<'swe' | 'qa' | 'reviewer', { provider: Provider; fallbacks?: Provider[] }>>;
  /** Providers whose configured binary points at a non-existent path (adapter reports UNAVAILABLE). */
  missingBinaries?: Provider[];
  /** Failure injection for the fake providers: provider -> role -> behaviour. Stored outside the workspace, never in prompts. */
  providerBehavior?: ProviderBehavior;
}

export type ProviderBehavior = Partial<Record<Provider, Partial<Record<'swe' | 'qa' | 'reviewer', 'rate_limit' | 'upstream' | 'auth' | 'malformed' | 'edit_then_upstream' | 'edit_then_auth' | 'partial_then_rate_limit' | 'edit_agents_md'>>>>;

export interface ProviderInvocation {
  provider: string; role: string; issue: string | null; cwd: string; argv: string[]; repair: boolean;
  /** What the fake observed at spawn time (from its own prompt/workspace, logged by the fake process). */
  saw_root_rule?: boolean; saw_nested_rule?: boolean; saw_handoff_section?: boolean; handoff_dir_present?: boolean;
}
export interface SweAction { provider: string; issue: string | null; action: 'full' | 'partial' | 'completed_pending' | 'noop'; handoff_checklist_seen: boolean }

export interface SyntheticScenario {
  root: string;
  configPath: string;
  config: AutosConfig;
  atlassianScenario: AtlassianScenario;
  atlassian: AtlassianClient;
  fakeAtlassian: FakeAtlassian;
  /** Non-GET / foreign-host / unsupported Atlassian requests. Assert it is empty. */
  violations: FakeAtlassian['violations'];
  remote: FixtureRemote;
  git: GitRunnerPort;
  /** job_id -> prepared workspace, captured as the workflow prepares them. */
  workspaces: Map<string, GitWorkspace>;
  runner: LocalFixtureRunner;
  precedents: PrecedentReadPort;
  /** Real fake-provider process spawns, read from the invocation log the fake executables append to. */
  providerInvocations(): Promise<ProviderInvocation[]>;
  /** What each fake SWE spawn actually did (full fix, half fix, only the pending items after a handoff). */
  sweActions(): Promise<SweAction[]>;
  /** Pass directly to createRuntime(...) from @autos/controller. */
  runtimeOptions: { cwd: string; configPath: string; env: NodeJS.ProcessEnv; atlassian: AtlassianReadPort; precedents: PrecedentReadPort; git: GitRunnerPort; runner: LocalFixtureRunner };
  cleanup(): Promise<void>;
}

export async function createSyntheticScenario(options: SyntheticScenarioOptions = {}): Promise<SyntheticScenario> {
  const ownsRoot = options.root === undefined;
  const root = await realpath(options.root ?? await mkdtemp(join(tmpdir(), 'autos-synthetic-')));
  const remote = await seedFixtureRemote(await mkdirReturn(join(root, 'remote')));

  const config = parseConfigYaml(await readFile(join(repositoryRoot, 'config/config.example.yaml'), 'utf8'));
  if (options.maxParallel !== undefined) config.jobs.max_parallel = options.maxParallel;
  if (options.maxConcurrentChecks !== undefined) config.jobs.max_concurrent_checks = options.maxConcurrentChecks;
  if (options.pushFeatureBranch) config.bitbucket.push_feature_branch = true;
  config.jira.allowed_projects = ['SAMPLE', 'LEGACY'];
  config.bitbucket.allowed_repositories[0]!.allowed_paths = ['src/**', 'scripts/**', 'AGENTS.md', 'pom.xml'];
  config.build_profiles['java-example']!.checks = [{ executable: process.execPath, args: ['scripts/check.mjs'], timeout_ms: 60_000, required: true }];
  const fakes = { claude: join(providersDirectory, 'fake-claude.mjs'), codex: join(providersDirectory, 'fake-codex.mjs'), cursor: join(providersDirectory, 'fake-cursor-agent.mjs') } as const;
  for (const path of Object.values(fakes)) await chmod(path, 0o755);
  config.providers.claude.binary = fakes.claude;
  config.providers.codex.binary = fakes.codex;
  config.providers.cursor.binary = fakes.cursor;
  for (const provider of options.missingBinaries ?? []) config.providers[provider].binary = join(root, `missing-${provider}`);
  for (const [role, chain] of Object.entries(options.roleChains ?? {}) as Array<['swe' | 'qa' | 'reviewer', { provider: Provider; fallbacks?: Provider[] }]>) {
    config.agents[role] = { ...config.agents[role], provider: chain.provider, fallbacks: (chain.fallbacks ?? []).map((provider) => ({ provider })) } as typeof config.agents[typeof role];
  }
  const configPath = join(root, 'config.yaml');
  await writeFile(configPath, JSON.stringify(config));

  const atlassianScenario = options.atlassian ?? defaultAtlassianScenario();
  const fakeAtlassian = createFakeAtlassianFetch(atlassianScenario);
  const credentials = { username: 'fixture@example.test', token: 'fixture-token-not-a-secret' };
  const atlassian = createAtlassianClient({ config, credentials: { jira: credentials, confluence: credentials }, fetch: fakeAtlassian.fetch, sleep: async () => undefined });

  const workspaces = new Map<string, GitWorkspace>();
  const actualGit = new GitRunner({ allowedRepositories: config.bitbucket.allowed_repositories, pushEnabled: config.bitbucket.push_feature_branch, testOnlyRemoteOverrides: [{ repository: 'example/sample-app', path: remote.remotePath }] });
  const git: GitRunnerPort = {
    resolveBase: actualGit.resolveBase.bind(actualGit),
    prepare: async (request: GitPrepareRequest, signal?: AbortSignal) => { const workspace = await actualGit.prepare(request, signal); workspaces.set(workspace.job_id, workspace); return workspace; },
    inspectCandidate: actualGit.inspectCandidate.bind(actualGit), commit: actualGit.commit.bind(actualGit), push: actualGit.push.bind(actualGit),
    readInstructionFiles: actualGit.readInstructionFiles.bind(actualGit), takeHandoff: actualGit.takeHandoff.bind(actualGit),
    sealWorkspace: actualGit.sealWorkspace.bind(actualGit), reopen: actualGit.reopen.bind(actualGit),
  };

  const providerHome = join(root, 'provider-home');
  await mkdir(providerHome, { recursive: true, mode: 0o700 });
  await writeFile(join(providerHome, 'fake-provider-behavior.json'), JSON.stringify(options.providerBehavior ?? {}), { mode: 0o600 });
  const runner = createLocalFixtureRunner({ binaries: { claude: config.providers.claude.binary, codex: config.providers.codex.binary, cursor: config.providers.cursor.binary }, providerHome, ...(options.roleDelayMs ? { roleDelayMs: options.roleDelayMs } : {}), ...(options.checkDelayMs ? { checkDelayMs: options.checkDelayMs } : {}) });
  const precedents: PrecedentReadPort = { findPrecedents: async () => ({ outcome: 'NO_MATCH' as const, items: [] }) };

  return {
    root, configPath, config, atlassianScenario, atlassian, fakeAtlassian, violations: fakeAtlassian.violations, remote, git, workspaces, runner, precedents,
    providerInvocations: async () => {
      const text = await readFile(join(providerHome, 'invocations.jsonl'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ProviderInvocation);
    },
    sweActions: async () => {
      const text = await readFile(join(providerHome, 'actions.jsonl'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SweAction);
    },
    runtimeOptions: { cwd: root, configPath, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, atlassian, precedents, git, runner },
    cleanup: async () => { if (ownsRoot) await rm(root, { recursive: true, force: true }); },
  };
}

async function mkdirReturn(path: string): Promise<string> { await mkdir(path, { recursive: true }); return path; }
