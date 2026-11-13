import { z } from 'zod';
import { configSchema } from '@autos/contracts';

/**
 * JSON Schema of `config/config.yaml`, generated from the Zod schema that validates it (so types, allowed values, ranges,
 * patterns and defaults cannot drift), with a description for every setting. Published in the OpenAPI document as
 * `components.schemas.AutosConfig` for reference; no endpoint accepts or returns the configuration.
 *
 * Keys: dotted setting paths. `<role>` stands for swe|qa|reviewer, `<provider>` for claude|codex|cursor, `*` for a
 * user-chosen map key, `[]` for an array element. A test requires a description for every setting.
 */
export const CONFIG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '': 'Autos configuration file (`config/config.yaml`, YAML). Validated at startup; unknown keys are rejected. Secrets are never stored here: every `*_env` setting names an environment variable that holds the value. Cross-field rules (for example storage directories must be distinct, lineage repositories must be allowlisted, a role needs exactly one of provider or ladder) are enforced at load time and not expressible in this schema.',
  schema_version: 'Configuration format version. Must be 1.',

  jira: 'Jira Cloud intake. Autos only reads Jira (enforced by `read_only: true`).',
  'jira.site_url': 'Jira Cloud site root, https with no path (for example https://example.atlassian.net).',
  'jira.saved_filter_id': 'Numeric ID of the private saved filter whose tickets Autos works on.',
  'jira.allowed_projects': 'Jira project keys Autos may work on; tickets in other projects are ignored or refused.',
  'jira.intake_types': 'Optional extra restriction on issue type names. Absent: every issue the saved filter returns is eligible.',
  'jira.acceptance_criteria_fields': 'Custom fields (customfield_NNNNN) read as acceptance criteria and given to every role.',
  'jira.read_only': 'Must be true. Autos never writes to Jira.',
  'jira.poll_seconds': 'Seconds between filter polls (and the drain loop\'s maximum idle time). Minimum 10.',
  'jira.auto_poll': 'When false, `controller start` serves the API and runs submitted jobs but never reads the filter on its own. Keep false for first tests.',
  'jira.max_new_per_poll': 'Upper bound on new jobs one poll may queue, so a backlog is admitted gradually.',
  'jira.username_env': 'Environment variable holding the Jira account e-mail.',
  'jira.token_env': 'Environment variable holding the Jira API token (classic, unscoped).',

  confluence: 'Confluence Cloud: the branch-map page that routes projects to repositories, and optional fix-document drafts.',
  'confluence.site_url': 'Confluence Cloud site root, https with no path.',
  'confluence.branch_map_page_id': 'Numeric page ID of the branch map (project → workspace, repository, development branch, sandbox branch, optional JDK/Tomcat).',
  'confluence.read_only': 'Must be true. Autos reads Confluence; the only write is the optional draft feature below.',
  'confluence.username_env': 'Environment variable holding the Confluence account e-mail.',
  'confluence.token_env': 'Environment variable holding the Confluence API token. Drafts are created as this account and are visible only to it.',
  'confluence.drafts': 'Optional fix-document drafts (docs/semantic-precedents-plan.md §12). Autos creates unpublished drafts only; a person reviews and publishes them in Confluence. Autos never publishes, deletes or edits a published page.',
  'confluence.drafts.enabled': 'Turn the draft feature on (`autos confluence draft`, POST /v1/confluence-drafts).',
  'confluence.drafts.space_key': 'Space key the drafts are created in.',
  'confluence.drafts.parent_page_id': 'Numeric ID of the parent page the drafts are created under.',
  'confluence.drafts.auto': 'Create the draft automatically when an attempt reaches READY_FOR_HUMAN; false = only on request.',

  bitbucket: 'Bitbucket Cloud repositories Autos may work in, and push behaviour.',
  'bitbucket.allowed_repositories': 'Repositories Autos may clone and commit to. A branch-map row pointing elsewhere is refused.',
  'bitbucket.allowed_repositories[].workspace': 'Bitbucket workspace ID.',
  'bitbucket.allowed_repositories[].repository_slug': 'Repository slug.',
  'bitbucket.allowed_repositories[].remote_url': 'Clone URL; must be exactly https://bitbucket.org/<workspace>/<slug>.git or git@bitbucket.org:<workspace>/<slug>.git.',
  'bitbucket.allowed_repositories[].protected_branches': 'Branches Autos must never use as its feature branch (for example main, develop).',
  'bitbucket.allowed_repositories[].build_profile': 'Name of the `build_profiles` entry whose checks, JDK and Tomcat this repository uses.',
  'bitbucket.allowed_repositories[].allowed_paths': 'Path globs (repository-relative) the SWE may change. A candidate touching anything else is refused.',
  'bitbucket.allowed_repositories[].prohibited_paths': 'Path globs the SWE may never change, even inside allowed_paths.',
  'bitbucket.push_feature_branch': 'Push READY_FOR_HUMAN commits to `deep/<KEY>`: create-only the first time, fast-forward afterwards, never forced. Off by default.',
  'bitbucket.push_blocked_attempts': 'Commit and push the unreviewed work of a BLOCKED attempt (after its agents ran) to the feature branch, clearly labelled, so humans can inspect it; a retry continues from it.',
  'bitbucket.create_pull_request': 'Must be false. Autos never opens pull requests.',
  'bitbucket.read_token_env': 'Optional environment variable with a Bitbucket read token, used only by the legacy similar-ticket lookup.',

  git: 'Fixed Git safety rules (all literal values).',
  'git.branch_template': 'Feature branch name. Must be `deep/{issueKey}`.',
  'git.no_rebase': 'Must be true. Autos never rebases.',
  'git.no_force_push': 'Must be true. Autos never force-pushes.',
  'git.refuse_existing_feature_branch': 'Must be true. An existing remote feature branch for a new attempt is refused, never overwritten.',

  providers: 'Coding CLIs available to the roles.',
  'providers.<provider>': 'One provider CLI (claude = Claude Code, codex = OpenAI Codex, cursor = Cursor agent).',
  'providers.<provider>.binary': 'Executable name or path of the CLI (inside the worker image in server mode).',
  'providers.<provider>.auth_profile': 'Name of the supervisor auth profile holding this provider\'s login (subscription token, auth directory or API key).',

  models: 'Optional reusable named models, referenced from tier entries as `name` or `name:effort`.',
  'models.*': 'A named model.',
  'models.*.provider': 'Provider of the model: claude, codex or cursor.',
  'models.*.model': 'Model passed to the CLI. Cursor accepts only `auto`. Omitted: the CLI default.',

  model_tiers: 'Named model tiers (size classes such as sm, med, lg). Each tier is an ordered list of 1 to 3 entries tried in order on provider-side failures; roles with a ladder escalate between tiers.',
  'model_tiers.*': 'One tier: an ordered list of entries, each a `models` reference (`name` or `name:effort`) or an inline {provider, model, effort}.',
  'model_tiers.*[].provider': 'Provider of the entry: claude, codex or cursor.',
  'model_tiers.*[].model': 'Model passed to the CLI. Cursor accepts only `auto`.',
  'model_tiers.*[].effort': 'Reasoning effort for this entry. Claude: low|medium|high|xhigh|max. Codex: none|minimal|low|medium|high|xhigh|max. Cursor: none allowed.',

  triage: 'Optional cheap read-only call that picks each ladder role\'s starting tier for a new ticket (clamped to the ladder and floor by trusted code).',
  'triage.enabled': 'Run triage for new tickets. False or absent: roles start at their lowest tier (or floor).',
  'triage.tier': 'Tier (from model_tiers) the triage call runs on.',
  'triage.timeout_ms': 'Timeout of the triage call in milliseconds.',

  agents: 'The three roles. Each uses either a provider chain (provider, model, fallbacks) or a ladder of tiers (ladder, min), not both.',
  'agents.<role>': 'One role: swe writes the fix (source read-write); qa judges it against acceptance criteria and checks; reviewer looks for defects (both source read-only).',
  'agents.<role>.provider': 'Primary provider (chain form): claude, codex or cursor.',
  'agents.<role>.model': 'Model for the primary provider (chain form). Cursor accepts only `auto`.',
  'agents.<role>.timeout_ms': 'Timeout of one role invocation in milliseconds.',
  'agents.<role>.fallbacks': 'Up to two fallback providers (chain form), used only after provider-side failures (AUTH, RATE_LIMIT, UPSTREAM, UNAVAILABLE, TIMEOUT, INVALID_OUTPUT, CONTEXT). A chain never repeats a provider.',
  'agents.<role>.fallbacks[].provider': 'Fallback provider.',
  'agents.<role>.fallbacks[].model': 'Model for the fallback provider.',
  'agents.<role>.ladder': 'Ladder form: tier names from model_tiers, cheapest first. The role starts low and escalates when its work fails.',
  'agents.<role>.min': 'Ladder form: floor tier (one of the ladder\'s tiers). Triage, pins and revisions never start the role below it.',

  jobs: 'Job execution limits and policies.',
  'jobs.max_parallel': 'Concurrent ticket jobs (slots). Keep 1 for the pilot. Never more than one active job per issue.',
  'jobs.max_concurrent_checks': 'Concurrent check runs across all jobs. Must not exceed max_parallel. Absent: 1.',
  'jobs.max_repair_rounds': 'Repair rounds after failed checks, QA or review (0 to 2). Tier escalations do not count.',
  'jobs.workspace_retention_hours': 'Hours a BLOCKED/CANCELLED, superseded or orphan workspace is kept before pruning. The latest READY_FOR_HUMAN workspace of an open issue is never pruned.',
  'jobs.auto_prune_workspaces': 'Apply the retention policy automatically (at most hourly, between jobs).',
  'jobs.similar_tickets': 'Legacy similar-ticket lookup (linked issues, same component, summary keywords, commit scan). Used when `precedents` is absent or its source is legacy.',
  'jobs.similar_tickets.enabled': 'Run the legacy lookup.',
  'jobs.similar_tickets.max_candidates': 'Maximum precedents the legacy lookup returns (1 to 5).',
  'jobs.rate_limit_pause': 'When every provider of a role is rate limited, the attempt pauses (keeping its workspace) instead of blocking.',
  'jobs.rate_limit_pause.initial_minutes': 'First backoff when providers report no reset time.',
  'jobs.rate_limit_pause.max_minutes': 'Maximum backoff between resumes.',
  'jobs.rate_limit_pause.max_total_hours': 'A pause streak longer than this blocks the attempt with RATE_LIMIT.',

  build_profiles: 'Named build profiles referenced by repositories: the deterministic checks and toolchain.',
  'build_profiles.*': 'One build profile.',
  'build_profiles.*.jdk': 'JDK major version for agents and checks (from the installed toolchains). The branch map may override it per project.',
  'build_profiles.*.tomcat': 'Tomcat version (requires a JDK). The branch map may override it per project.',
  'build_profiles.*.checks': 'Check commands run by trusted code in a network-less container; their exit codes are the evidence.',
  'build_profiles.*.checks[].executable': 'Program to run (argument array, never a shell string).',
  'build_profiles.*.checks[].args': 'Arguments, one string each.',
  'build_profiles.*.checks[].timeout_ms': 'Timeout of the command in milliseconds.',
  'build_profiles.*.checks[].required': 'A failing required check blocks READY_FOR_HUMAN; an optional one is reported only.',

  precedents: 'Semantic precedent search across all branch-map Jira projects and code lineages (docs/semantic-precedents-plan.md). Absent: the legacy jobs.similar_tickets lookup.',
  'precedents.enabled': 'Build and maintain the index. Jobs use it only when source is semantic.',
  'precedents.source': 'legacy = jobs keep the legacy lookup (the index can still be built and searched for evaluation); semantic = jobs use semantic precedents.',
  'precedents.lineages': 'Code lineages: one base repository and the project branches cut from it. Lineages never share evidence.',
  'precedents.lineages[].id': 'Short lineage name.',
  'precedents.lineages[].repository': 'The lineage\'s repository; must be in bitbucket.allowed_repositories.',
  'precedents.lineages[].repository.workspace': 'Bitbucket workspace ID.',
  'precedents.lineages[].repository.repository_slug': 'Repository slug.',
  'precedents.lineages[].root_branch': 'The base branch every project branch was cut from (fork points are computed against it).',
  'precedents.lineages[].scan_branches': 'Branch globs scanned for fix commits (`**` matches names containing /). Dev and sandbox branches are included.',
  'precedents.lineages[].ignore_branches': 'Branch globs excluded from the fix scan.',
  'precedents.lineages[].branch_codes': 'Jira project key → branch code, for projects whose `<code>_dev` / `<code>_sbx` branches cannot be matched by name or ancestry.',
  'precedents.lineages[].branch_codes.*': 'Branch code of the project (the prefix of its _dev and _sbx branches).',
  'precedents.max_results': 'Fix precedents shown per job in precedents.md and prompts (1 to 5).',
  'precedents.index': 'The local index (`<storage.data_dir>/<db_file>`) and its Jira sync.',
  'precedents.index.db_file': 'Index file name inside storage.data_dir (mode 0600).',
  'precedents.index.mirrors_dir': 'Directory inside storage.data_dir for read-only bare repository mirrors.',
  'precedents.index.window_weeks': 'Index tickets updated within this many weeks (104 ≈ 2 years); older ones are purged on reconcile.',
  'precedents.index.exclude_projects': 'Jira projects never indexed.',
  'precedents.index.include_comments': 'Index non-bot comments (used for ranking only; comments never reach prompts).',
  'precedents.index.auto_sync': 'Run the background index loop in `controller start`. False: only `autos index sync`.',
  'precedents.index.sync_interval_minutes': 'Minutes between incremental Jira syncs.',
  'precedents.index.reconcile_interval_hours': 'Hours between reconciles that remove deleted, moved, restricted or out-of-window issues.',
  'precedents.index.overlap_minutes': 'Re-read window for incremental sync. Jira reads JQL dates in the API user\'s time zone, so keep it at least a day unless that user is on UTC.',
  'precedents.index.max_requests_per_run': 'Jira request budget per sync run; a longer sync resumes on the next run.',
  'precedents.index.min_request_interval_ms': 'Minimum spacing between Jira requests.',
  'precedents.embedding': 'Embedding model for semantic similarity. Runs locally; ticket text never leaves the host.',
  'precedents.embedding.provider': 'none = keyword and error-signature search only; ollama = local Ollama server.',
  'precedents.embedding.url': 'Ollama base URL: http on loopback or a single-label Compose service name only.',
  'precedents.embedding.model': 'Ollama embedding model (required for ollama), for example qwen3-embedding:0.6b or bge-m3.',
  'precedents.embedding.dimensions': 'Vector size of the model (required for ollama); checked against every response and the stored index.',
  'precedents.embedding.batch_size': 'Texts per embedding request.',
  'precedents.embedding.timeout_ms': 'Timeout of one embedding request.',
  'precedents.gate': 'Evidence-gate thresholds. Absent: calibrated defaults; recalibrate with real data.',
  'precedents.gate.semantic_threshold': 'Minimum semantic similarity (0 to 1) for the semantic signal to count.',
  'precedents.gate.strict_threshold': 'Score (0 to 1) a candidate needs when the judge did not run.',
  'precedents.judge': '"Same defect?" check on the shortlisted candidates through the trusted runner (read-only sandbox, no repository). It can only drop candidates.',
  'precedents.judge.enabled': 'Run the judge. False: no ticket text goes to a provider for precedents; the stricter threshold applies.',
  'precedents.judge.tier': 'Tier (or tier:effort) from model_tiers for the judge. Absent: the reviewer\'s lowest ladder tier, else the triage tier, else the reviewer\'s chain, at low effort.',
  'precedents.judge.max_candidates': 'Candidates sent to the judge (1 to 10).',
  'precedents.judge.timeout_ms': 'Timeout of the judge call.',
  'precedents.prompt': 'Reference block of fix precedents in role prompts (untrusted, delimited, truncated first).',
  'precedents.prompt.roles': 'Roles that receive the block: swe (fix precedents with diff excerpts), reviewer (keys, summaries, files). Empty until accuracy has been measured. QA never receives it.',
  'precedents.prompt.max_bytes': 'Maximum size of the block.',
  'precedents.prompt.per_precedent_diff_bytes': 'Maximum diff excerpt per precedent.',
  'precedents.possibly_affected': 'After READY_FOR_HUMAN, list open tickets and other project branches that may have the same bug ("May also affect").',

  security: 'Fixed safety switches. Every value must be false.',
  'security.allow_jira_write': 'Must be false.',
  'security.allow_confluence_write': 'Must be false (fix-document drafts are governed separately by confluence.drafts).',
  'security.allow_merge': 'Must be false. Autos never merges.',
  'security.allow_deploy': 'Must be false. Autos never deploys.',
  'security.allow_prod_db': 'Must be false. Autos never touches production databases.',

  storage: 'Local directories (dedicated, distinct and non-overlapping; created with mode 0700).',
  'storage.data_dir': 'SQLite databases, supervisor socket, precedent index and mirrors.',
  'storage.artifacts_dir': 'Evidence per attempt (never pruned automatically).',
  'storage.workspaces_dir': 'Git workspaces per attempt (pruned by the retention policy).',

  api: 'Operator HTTP API.',
  'api.listen_host': 'Loopback address to bind: 127.0.0.1 or ::1. Only the container override AUTOS_CONTAINER_BIND_HOST may widen it.',
  'api.port': 'TCP port (1024 to 65535).',
  'api.operator_token_env': 'Environment variable holding the bearer token (at least 16 characters).',

  notifications: 'Optional notifications.',
  'notifications.teams': 'Microsoft Teams cards through a Workflows webhook, posted by `autos teams relay`. Cards carry only facts Autos authored, never ticket text, notes, diffs or provider output.',
  'notifications.teams.webhook_url_env': 'Environment variable holding the webhook URL (it carries a signature, so it is a secret).',
  'notifications.teams.notify': 'Card kinds to post: READY_FOR_HUMAN, BLOCKED, CANCELLED, PLANNED, PAUSED, TIER_ESCALATED, PROVIDER_GATE, AUTOS_UP, AUTOS_DOWN, AGENT_PROGRESS (opt-in, rate limited).',
  'notifications.teams.include_commands': 'Add copyable `autos …` follow-up commands to each card.',
  'notifications.teams.payload': 'message = wrap the card in a message with attachments (Microsoft\'s "Send webhook alerts" template); card = send the Adaptive Card itself.',
  'notifications.teams.auth': 'Sign posts with a Microsoft Entra ID app token (client credentials) for tenants that do not allow anonymous webhooks.',
  'notifications.teams.auth.tenant_id': 'Entra tenant ID (GUID).',
  'notifications.teams.auth.client_id': 'Entra application (client) ID (GUID).',
  'notifications.teams.auth.client_secret_env': 'Environment variable holding the client secret.',
  'notifications.teams.auth.cloud': 'Microsoft cloud: public, gcc, gcch, dod or china.',

  knowledge: 'Optional read-only Jira/Confluence tools for agents through the host knowledge gateway (MCP shim in each container, per-run token).',
  'knowledge.enabled': 'Turn the tools on.',
  'knowledge.roles': 'Roles that get the tools.',
  'knowledge.gateway': 'Gateway network settings.',
  'knowledge.gateway.listen_host': 'Address the gateway binds. Loopback works with Docker Desktop; on Linux bind the Docker bridge gateway address.',
  'knowledge.gateway.port': 'Gateway port.',
  'knowledge.gateway.advertise_url': 'URL agent containers use to reach the gateway (plain http is fine; it never leaves the host).',
  'knowledge.jira': 'Jira scope for agent tools.',
  'knowledge.jira.projects': 'Readable Jira projects. Absent: jira.allowed_projects.',
  'knowledge.confluence': 'Confluence scope for agent tools.',
  'knowledge.confluence.spaces': 'Readable Confluence space keys.',
  'knowledge.confluence.pages': 'Readable page trees: each page ID and all of its descendants.',
  'knowledge.limits': 'Budgets per role run.',
  'knowledge.limits.max_calls_per_run': 'Tool calls per role run.',
  'knowledge.limits.max_result_chars': 'Characters returned by one call.',
  'knowledge.limits.max_total_chars_per_run': 'Characters returned across one role run.',
  'knowledge.limits.max_attachment_bytes': 'Largest attachment an agent may read.',
  'knowledge.limits.search_results': 'Results per search call.',
};

type JsonNode = Record<string, unknown>;

/** Normalizes a concrete setting path to its description key (`agents.qa.model` → `agents.<role>.model`). */
export function descriptionKey(path: string): string {
  return path.replace(/^agents\.(swe|qa|reviewer)(?=\.|$)/, 'agents.<role>').replace(/^providers\.(claude|codex|cursor)(?=\.|$)/, 'providers.<provider>');
}

/** Every setting path in a JSON schema (same notation as CONFIG_DESCRIPTIONS keys before normalization). */
export function settingPaths(schema: JsonNode): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as JsonNode;
    for (const branch of [...((n.anyOf as unknown[]) ?? []), ...((n.oneOf as unknown[]) ?? []), ...((n.allOf as unknown[]) ?? [])]) walk(branch, path);
    if (n.properties && typeof n.properties === 'object') for (const [key, child] of Object.entries(n.properties as JsonNode)) { const p = path ? `${path}.${key}` : key; out.add(p); walk(child, p); }
    if (n.additionalProperties && typeof n.additionalProperties === 'object') { out.add(`${path}.*`); walk(n.additionalProperties, `${path}.*`); }
    if (n.items && typeof n.items === 'object') walk(n.items, `${path}[]`);
  };
  walk(schema, '');
  return [...out];
}

let cached: JsonNode | undefined;
/** The AutosConfig JSON Schema (input form: defaults shown, optional keys optional) with descriptions applied. */
export function configJsonSchema(): JsonNode {
  if (cached) return structuredClone(cached);
  const schema = z.toJSONSchema(configSchema as never, { io: 'input', unrepresentable: 'any' }) as JsonNode;
  delete schema.$schema;
  const describe = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as JsonNode;
    const text = CONFIG_DESCRIPTIONS[descriptionKey(path)];
    if (text && n.description === undefined) n.description = text;
    for (const branch of [...((n.anyOf as unknown[]) ?? []), ...((n.oneOf as unknown[]) ?? [])]) describe(branch, path);
    if (n.properties && typeof n.properties === 'object') for (const [key, child] of Object.entries(n.properties as JsonNode)) describe(child, path ? `${path}.${key}` : key);
    if (n.additionalProperties && typeof n.additionalProperties === 'object') describe(n.additionalProperties, `${path}.*`);
    if (n.items && typeof n.items === 'object') describe(n.items, `${path}[]`);
  };
  describe(schema, '');
  cached = schema;
  return structuredClone(schema);
}
