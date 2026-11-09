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
const roleConfigSchema = z.strictObject({
  provider: providerSchema,
  model: modelSchema.optional(),
  timeout_ms: z.number().int().positive().max(3_600_000).default(600_000),
  /** Ordered providers tried when the previous one fails with a fallback-eligible error (see FALLBACK_ERROR_CODES). */
  fallbacks: z.array(providerChoiceSchema).max(MAX_ROLE_FALLBACKS).default([]),
}).transform((role, ctx) => {
  const primary = normalizeChoice({ provider: role.provider, ...(role.model === undefined ? {} : { model: role.model }) }, ctx, []);
  const fallbacks = role.fallbacks.map((choice, index) => normalizeChoice(choice, ctx, ['fallbacks', index]));
  const chain = [primary.provider, ...fallbacks.map((choice) => choice.provider)];
  if (new Set(chain).size !== chain.length) ctx.addIssue({ code: 'custom', path: ['fallbacks'], message: 'A role\'s provider chain must not repeat a provider' });
  return { ...role, ...primary, fallbacks };
});
const binarySchema = z.strictObject({ binary: z.string().min(1), auth_profile: identifierSchema });

export const configSchema = z.strictObject({
  schema_version: z.literal(1),
  jira: z.strictObject({
    site_url: siteUrlSchema, saved_filter_id: z.string().regex(/^[0-9]+$/),
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
});
export type AutosConfig = z.infer<typeof configSchema>;
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
