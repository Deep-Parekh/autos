import { z } from 'zod';
import { parseDocument } from 'yaml';
import { AutosError } from './errors.js';
import { branchNameSchema, envNameSchema, identifierSchema, modelSchema, projectKeySchema, providerSchema } from './domain.js';
import { jdkVersionSchema, tomcatVersionSchema } from './toolchain.js';

/** Upper bound for jobs.max_parallel; raising it is a reviewed code change, not just configuration. */
export const MAX_PARALLEL_JOBS = 8;

const siteUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
}, 'Expected a credential-free HTTPS site origin');
export const checkCommandSchema = z.strictObject({
  executable: z.string().min(1).refine((s) => !/[\x00\r\n]/.test(s)),
  args: z.array(z.string().refine((s) => !s.includes('\0'))),
  timeout_ms: z.number().int().positive().max(3_600_000),
  required: z.boolean().default(true),
});
const pathGlobSchema = z.string().min(1).refine((s) => !s.startsWith('/') && !s.includes('..') && !s.includes('\\') && !/[\x00-\x1f]/.test(s), 'Invalid path policy');
export const repositoryConfigSchema = z.strictObject({
  workspace: identifierSchema,
  repository_slug: identifierSchema,
  remote_url: z.string().min(1),
  protected_branches: z.array(branchNameSchema).min(1),
  build_profile: identifierSchema,
  allowed_paths: z.array(pathGlobSchema).min(1),
  prohibited_paths: z.array(pathGlobSchema).default([]),
}).refine((repo) => {
  const path = `${repo.workspace}/${repo.repository_slug}`;
  return repo.remote_url === `https://bitbucket.org/${path}.git` || repo.remote_url === `git@bitbucket.org:${path}.git`;
}, 'Repository remote must match the exact Bitbucket workspace and slug');
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
/** Cursor is used only with its automatic model selection. */
export const CURSOR_MODEL = 'auto';
const providerChoiceShape = { provider: providerSchema, model: modelSchema.optional() };
function normalizeChoice<T extends { provider: z.infer<typeof providerSchema>; model?: string | undefined }>(choice: T, ctx: z.RefinementCtx, path: (string | number)[]): T {
  if (choice.provider !== 'cursor') return choice;
  if (choice.model !== undefined && choice.model !== CURSOR_MODEL) ctx.addIssue({ code: 'custom', path: [...path, 'model'], message: 'Cursor supports only model "auto"' });
  return { ...choice, model: CURSOR_MODEL };
}
export const providerChoiceSchema = z.strictObject(providerChoiceShape);
export type ProviderChoice = { provider: z.infer<typeof providerSchema>; model?: string };
/** Maximum fallback providers per role (primary + 2 = all three CLIs). */
export const MAX_ROLE_FALLBACKS = 2;

// ---- Model tiers (size classes), reasoning effort and per-role ladders (opt-in; provider/model/fallbacks keeps working) ----

/**
 * Reasoning-effort levels each CLI accepts, verified locally without logging in:
 * - claude: `claude --help` lists `--effort <level>` with low, medium, high, xhigh, max.
 * - codex 0.162.1: `-c model_reasoning_effort="<level>"`; the binary's ReasoningEffort enum is none, minimal, low, medium,
 *   high, xhigh, max (which levels a given model honours is model-dependent; an unsupported one fails at the provider).
 * - cursor: no effort control (cursor-agent is only used with model auto).
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortSchema = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof effortSchema>;
export const PROVIDER_EFFORTS: Readonly<Record<z.infer<typeof providerSchema>, readonly Effort[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: [],
};
/** Tier and named-model names are short identifiers without ':' (the effort separator). */
export const tierNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
/** `name` or `name:effort`: a tier with an optional effort override (pins), or a named model with an effort (tier entries). */
export const tierStepLabelSchema = z.string().max(60).regex(/^[a-z0-9][a-z0-9_-]{0,39}(?::[a-z]+)?$/);
export interface TierStepRef { tier: string; effort?: Effort }
/** Parses `name[:effort]` (syntax only). */
export function parseTierStep(label: string): TierStepRef | null {
  if (!tierStepLabelSchema.safeParse(label).success) return null;
  const [tier, effort] = label.split(':') as [string, string | undefined];
  if (effort === undefined) return { tier };
  const parsed = effortSchema.safeParse(effort);
  return parsed.success ? { tier, effort: parsed.data } : null;
}
export const formatTierStep = (ref: TierStepRef): string => ref.effort ? `${ref.tier}:${ref.effort}` : ref.tier;
/** A reusable named model (`models:`), referenced from tier entries as `name` or `name:effort`. */
export const namedModelSchema = z.strictObject({ provider: providerSchema, model: modelSchema.optional() });
const tierEntryInputSchema = z.union([
  tierStepLabelSchema,
  z.strictObject({ provider: providerSchema, model: modelSchema.optional(), effort: effortSchema.optional() }),
]);
/** Entries per tier (tried in order on provider-side failures) and steps per ladder. */
export const MAX_TIER_ENTRIES = 3;
export const MAX_LADDER_STEPS = 8;
/** One resolved tier entry: provider, model, optional effort (absent = CLI default) and the tier it belongs to (null for the plain role form). */
export interface ResolvedChainEntry { provider: z.infer<typeof providerSchema>; model?: string; effort?: Effort; tier: string | null }
/** A ladder step: a tier (label = tier name, or `tier:effort` for a pinned effort override) and its ordered entries. */
export interface ResolvedStep { label: string; tier: string; effort?: Effort; chain: ResolvedChainEntry[] }
export interface RoleConfig {
  /** Primary provider/model/fallbacks. For a ladder role these mirror the lowest tier's entries (diagnostics and older readers). */
  provider: z.infer<typeof providerSchema>;
  model?: string;
  timeout_ms: number;
  fallbacks: ProviderChoice[];
  /** Present only for a ladder role: ordered tiers, cheapest first. */
  ladder?: ResolvedStep[];
  /** Ladder index of the role's floor (`min`); absent when the role has none. */
  min_index?: number;
}

const roleConfigSchema = z.strictObject({
  provider: providerSchema.optional(),
  model: modelSchema.optional(),
  timeout_ms: z.number().int().positive().max(3_600_000).default(600_000),
  /** Ordered providers tried when the previous one fails with a fallback-eligible error (see FALLBACK_ERROR_CODES). */
  fallbacks: z.array(providerChoiceSchema).max(MAX_ROLE_FALLBACKS).optional(),
  /** Ladder form: ordered tier names, cheapest first (requires model_tiers; replaces provider/model/fallbacks). */
  ladder: z.array(tierNameSchema).min(1).max(MAX_LADDER_STEPS).optional(),
  /** Ladder form: floor tier (one of the ladder's tiers); triage, pins and revisions never start below it. */
  min: tierNameSchema.optional(),
}).superRefine((role, ctx) => {
  if ((role.provider === undefined) === (role.ladder === undefined)) ctx.addIssue({ code: 'custom', path: ['provider'], message: 'A role needs exactly one of provider or ladder' });
  if (role.ladder !== undefined && (role.model !== undefined || role.fallbacks !== undefined)) ctx.addIssue({ code: 'custom', path: ['ladder'], message: 'A ladder role takes no model or fallbacks (a tier lists its own entries)' });
  if (role.min !== undefined && role.ladder === undefined) ctx.addIssue({ code: 'custom', path: ['min'], message: 'min requires a ladder' });
});
type RoleInput = z.infer<typeof roleConfigSchema>;
type TierEntryInput = z.infer<typeof tierEntryInputSchema>;

/** Resolves one tier entry (inline object or `model[:effort]` reference to `models`), or adds an issue and returns null. */
function resolveEntry(input: TierEntryInput, tier: string, models: Record<string, { provider: z.infer<typeof providerSchema>; model?: string | undefined }>, ctx: z.RefinementCtx, path: (string | number)[]): ResolvedChainEntry | null {
  let provider: z.infer<typeof providerSchema>; let model: string | undefined; let effort: Effort | undefined;
  if (typeof input === 'string') {
    const ref = parseTierStep(input);
    if (!ref) { ctx.addIssue({ code: 'custom', path, message: `Invalid reasoning effort in ${input}` }); return null; }
    const named = Object.hasOwn(models, ref.tier) ? models[ref.tier] : undefined;
    if (!named) { ctx.addIssue({ code: 'custom', path, message: `Unknown model ${ref.tier} (define it under models)` }); return null; }
    provider = named.provider; model = named.model; effort = ref.effort;
  } else { provider = input.provider; model = input.model; effort = input.effort; }
  if (provider === 'cursor') {
    if (model !== undefined && model !== CURSOR_MODEL) { ctx.addIssue({ code: 'custom', path, message: 'Cursor supports only model "auto"' }); return null; }
    model = CURSOR_MODEL;
  }
  if (model === undefined) { ctx.addIssue({ code: 'custom', path, message: 'A tier entry must name a model' }); return null; }
  if (effort !== undefined && !PROVIDER_EFFORTS[provider].includes(effort)) {
    ctx.addIssue({ code: 'custom', path, message: provider === 'cursor' ? 'Cursor has no reasoning effort' : `${provider} does not accept effort ${effort}` }); return null;
  }
  return { provider, model, tier, ...(effort ? { effort } : {}) };
}

function resolveRole(role: RoleInput, tiers: Record<string, ResolvedChainEntry[]>, ctx: z.RefinementCtx, path: (string | number)[]): RoleConfig {
  if (role.ladder === undefined) {
    const primary = normalizeChoice({ provider: role.provider!, ...(role.model === undefined ? {} : { model: role.model }) }, ctx, path);
    const fallbacks: ProviderChoice[] = (role.fallbacks ?? []).map((choice, index) => normalizeChoice(choice, ctx, [...path, 'fallbacks', index])).map((c) => ({ provider: c.provider, ...(c.model === undefined ? {} : { model: c.model }) }));
    const chain = [primary.provider, ...fallbacks.map((choice) => choice.provider)];
    if (new Set(chain).size !== chain.length) ctx.addIssue({ code: 'custom', path: [...path, 'fallbacks'], message: 'A role\'s provider chain must not repeat a provider' });
    return { provider: primary.provider, ...(primary.model === undefined ? {} : { model: primary.model }), timeout_ms: role.timeout_ms, fallbacks };
  }
  const steps: ResolvedStep[] = [];
  role.ladder.forEach((name, index) => {
    const entries = Object.hasOwn(tiers, name) ? tiers[name] : undefined;
    if (!entries) { ctx.addIssue({ code: 'custom', path: [...path, 'ladder', index], message: `Unknown model tier ${name}` }); return; }
    if (steps.some((s) => s.label === name)) { ctx.addIssue({ code: 'custom', path: [...path, 'ladder', index], message: `Duplicate ladder tier ${name}` }); return; }
    steps.push({ label: name, tier: name, chain: entries });
  });
  let minIndex = 0;
  if (role.min !== undefined) {
    minIndex = steps.findIndex((s) => s.label === role.min);
    if (minIndex < 0) { ctx.addIssue({ code: 'custom', path: [...path, 'min'], message: 'min must be one of the role\'s ladder tiers' }); minIndex = 0; }
  }
  const lowest = steps[0]?.chain ?? [{ provider: 'claude' as const, tier: null }];
  return {
    provider: lowest[0]!.provider, ...(lowest[0]!.model ? { model: lowest[0]!.model } : {}), timeout_ms: role.timeout_ms,
    fallbacks: lowest.slice(1).map((c) => ({ provider: c.provider, ...(c.model ? { model: c.model } : {}) })), ladder: steps, ...(role.min !== undefined ? { min_index: minIndex } : {}),
  };
}

const binarySchema = z.strictObject({ binary: z.string().min(1), auth_profile: identifierSchema });

export const configSchema = z.strictObject({
  schema_version: z.literal(1),
  jira: z.strictObject({
    site_url: siteUrlSchema, saved_filter_id: z.union([z.string().regex(/^[0-9]+$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform((id) => String(id))]), // YAML may give 12345 or '12345'
    allowed_projects: z.array(projectKeySchema).min(1), /** Optional extra restriction on issue type. Absent: every issue in the saved filter is eligible (the filter decides). */
    intake_types: z.array(z.string().min(1)).min(1).optional(),
    acceptance_criteria_fields: z.array(z.string().regex(/^customfield_[0-9]+$/)).default([]),
    read_only: z.literal(true), poll_seconds: z.number().int().min(10).default(300),
    /**
     * When false, `controller start` serves the API and runs submitted jobs (autos run / POST /v1/jobs) but never reads
     * the filter on its own. Keep false for first tests so a backlog is not processed before a supervised run.
     */
    auto_poll: z.boolean().default(true),
    /** Upper bound on new jobs one poll may queue (a large backlog is admitted gradually). */
    max_new_per_poll: z.number().int().min(1).max(100).default(10),
    username_env: envNameSchema, token_env: envNameSchema,
  }),
  confluence: z.strictObject({ site_url: siteUrlSchema, branch_map_page_id: z.string().regex(/^[0-9]+$/), read_only: z.literal(true), username_env: envNameSchema, token_env: envNameSchema }),
  bitbucket: z.strictObject({ allowed_repositories: z.array(repositoryConfigSchema).min(1), push_feature_branch: z.boolean().default(false), create_pull_request: z.literal(false), read_token_env: envNameSchema.optional() }),
  git: z.strictObject({ branch_template: z.literal('deep/{issueKey}'), no_rebase: z.literal(true), no_force_push: z.literal(true), refuse_existing_feature_branch: z.literal(true) }),
  providers: z.strictObject({ claude: binarySchema, codex: binarySchema, cursor: binarySchema }),
  /** Optional reusable named models (provider + model), referenced from tier entries as `name` or `name:effort`. */
  models: z.record(tierNameSchema, namedModelSchema).default({}),
  /**
   * Named model tiers (size classes, e.g. sm/med/lg): each an ordered list of 1-3 entries {provider, model, effort?} (or
   * `model[:effort]` references to `models`). Entries are tried in order on provider-side failures; roles escalate between tiers.
   */
  model_tiers: z.record(tierNameSchema, z.array(tierEntryInputSchema).min(1).max(MAX_TIER_ENTRIES)).default({}),
  /**
   * Optional cheap read-only call that picks each ladder role's starting tier for a new ticket (clamped by trusted code to
   * the ladder and floor). Runs the named tier's entries in order on provider failures. Absent or disabled: roles start at
   * their lowest tier (or floor). Pins and revisions/retries (previous tier) skip it.
   */
  triage: z.strictObject({ enabled: z.boolean().default(true), tier: tierNameSchema, timeout_ms: z.number().int().positive().max(3_600_000).default(180_000) }).optional(),
  agents: z.strictObject({ swe: roleConfigSchema, qa: roleConfigSchema, reviewer: roleConfigSchema }),
  jobs: z.strictObject({
    /** Concurrent ticket jobs (slots). Keep 1 for the pilot; raise on a larger host. At most one active job per issue. */
    max_parallel: z.number().int().min(1).max(MAX_PARALLEL_JOBS).default(1),
    /** Concurrent deterministic check runs across all jobs (builds are the heaviest step). Must not exceed max_parallel. */
    max_concurrent_checks: z.number().int().min(1).max(MAX_PARALLEL_JOBS).optional(),
    max_repair_rounds: z.number().int().min(0).max(2),
    /**
     * Hours a BLOCKED/CANCELLED attempt's workspace, a superseded revision parent, or an orphan directory is kept before
     * pruning. The latest READY_FOR_HUMAN workspace of an open issue is never pruned (revisions continue from it);
     * `autos close` removes an issue's workspaces immediately.
     */
    workspace_retention_hours: z.number().int().min(1).max(2160).default(72),
    /** Apply the retention policy automatically (at most hourly, between jobs). Manual `autos workspaces prune` always works. */
    auto_prune_workspaces: z.boolean().default(true),
    similar_tickets: z.strictObject({ enabled: z.boolean(), max_candidates: z.number().int().min(1).max(5) }),
    /**
     * When every provider of a role's chain is rate limited, the attempt pauses (no slot) and resumes at the earliest
     * provider-reported reset time, otherwise after initial_minutes doubling per consecutive pause up to max_minutes.
     * After max_total_hours of one pause streak the attempt is BLOCKED (RATE_LIMIT).
     */
    rate_limit_pause: z.strictObject({
      initial_minutes: z.number().int().min(1).max(1440).default(15),
      max_minutes: z.number().int().min(1).max(1440).default(240),
      max_total_hours: z.number().int().min(1).max(168).default(24),
    }).refine((p) => p.initial_minutes <= p.max_minutes, { message: 'initial_minutes must not exceed max_minutes', path: ['initial_minutes'] })
      .default({ initial_minutes: 15, max_minutes: 240, max_total_hours: 24 }),
  }).refine((jobs) => (jobs.max_concurrent_checks ?? 1) <= jobs.max_parallel, { message: 'max_concurrent_checks must not exceed max_parallel', path: ['max_concurrent_checks'] }),
  build_profiles: z.record(identifierSchema, z.strictObject({ jdk: jdkVersionSchema.optional(), tomcat: tomcatVersionSchema.optional(), checks: z.array(checkCommandSchema).min(1) })),
  security: z.strictObject({ allow_jira_write: z.literal(false), allow_confluence_write: z.literal(false), allow_merge: z.literal(false), allow_deploy: z.literal(false), allow_prod_db: z.literal(false) }),
  storage: z.strictObject({ data_dir: z.string().min(1), artifacts_dir: z.string().min(1), workspaces_dir: z.string().min(1) }),
  api: z.strictObject({ listen_host: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1024).max(65535), operator_token_env: envNameSchema }),
}).superRefine((config, ctx) => {
  const repositories = new Set<string>();
  config.bitbucket.allowed_repositories.forEach((repo, i) => {
    const id = `${repo.workspace}/${repo.repository_slug}`;
    if (repositories.has(id)) ctx.addIssue({ code: 'custom', path: ['bitbucket', 'allowed_repositories', i], message: 'Duplicate repository' });
    repositories.add(id);
    if (!config.build_profiles[repo.build_profile]) ctx.addIssue({ code: 'custom', path: ['bitbucket', 'allowed_repositories', i, 'build_profile'], message: 'Unknown build profile' });
  });
  if (new Set(config.jira.allowed_projects).size !== config.jira.allowed_projects.length) ctx.addIssue({ code: 'custom', path: ['jira', 'allowed_projects'], message: 'Duplicate project' });
  const dirs = Object.values(config.storage).map((dir) => dir.replace(/\/+$/, ''));
  if (new Set(dirs).size !== dirs.length) ctx.addIssue({ code: 'custom', path: ['storage'], message: 'Storage directories must be distinct' });
}).transform((config, ctx) => {
  const tiers: Record<string, ResolvedChainEntry[]> = {};
  for (const [name, entries] of Object.entries(config.model_tiers)) {
    const resolved = entries.map((entry, i) => resolveEntry(entry, name, config.models, ctx, ['model_tiers', name, i]));
    if (resolved.some((e) => e === null)) continue;
    const keys = (resolved as ResolvedChainEntry[]).map((e) => `${e.provider}/${e.model}/${e.effort ?? ''}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['model_tiers', name], message: 'A tier must not repeat an entry' });
    tiers[name] = resolved as ResolvedChainEntry[];
  }
  const agents = {
    swe: resolveRole(config.agents.swe, tiers, ctx, ['agents', 'swe']),
    qa: resolveRole(config.agents.qa, tiers, ctx, ['agents', 'qa']),
    reviewer: resolveRole(config.agents.reviewer, tiers, ctx, ['agents', 'reviewer']),
  };
  if (config.triage && !Object.hasOwn(config.model_tiers, config.triage.tier)) ctx.addIssue({ code: 'custom', path: ['triage', 'tier'], message: 'Unknown model tier' });
  return { ...config, model_tiers: tiers, agents };
});
export type AutosConfig = z.infer<typeof configSchema>;
export type AgentsConfig = AutosConfig['agents'];
export type CheckCommand = z.infer<typeof checkCommandSchema>;

export function parseConfig(value: unknown): AutosConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '<root>');
    throw new AutosError('INVALID_CONFIG', `Invalid configuration fields: ${[...new Set(paths)].join(', ')}`);
  }
  return parsed.data;
}

export function parseConfigYaml(text: string): AutosConfig {
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new AutosError('INVALID_CONFIG', 'Invalid YAML configuration');
    return parseConfig(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_CONFIG', 'Invalid YAML configuration');
  }
}
