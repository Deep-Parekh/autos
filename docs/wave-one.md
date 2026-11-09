# Autos first implementation wave

The shared foundation and Tasks A, B, and C are implemented. Three GPT-6 Luna workers built the independent modules; the primary agent defined the contracts, reviewed their behavior, requested corrections, and integrated them. The current CLI is a foundation preview. Continuous ticket execution requires the remaining workflow, operator-interface, and runner workstreams.

## Delivered modules

| Module | Implemented behavior | Construction interface |
| --- | --- | --- |
| `@autos/contracts` | Strict configuration, domain and evidence schemas; job states; application ports; finalization gates | Exported schemas, types, `parseConfigYaml`, `evaluateFinalization` |
| `@autos/atlassian` | Configured filter reads, paginated key discovery, issue/comment snapshots, explicit acceptance fields, Confluence mapping, historical Jira/Bitbucket evidence | `createAtlassianClient({config, credentials, ...transportOptions})` |
| `@autos/cli-adapters` | Claude/Codex/Cursor invocations, output normalization, scoped environment, bounded prompts/logs, redaction, cancellation and process-group cleanup | `createProviderAdapters(options)` or `new CliProviderAdapter(provider, options)` |
| `@autos/git-runner` | Isolated development-branch checkout, candidate/path policy, metadata checks, exact staging/commit verification, optional feature-only push | `new GitRunner({allowedRepositories, pushEnabled?, trustedCredentials?})` |

The Atlassian client implements `AtlassianReadPort`, exposes `.precedents`, and adds `resolveProjectMapping`. Its injected fetch transport makes reads testable without accounts. The optional `credentials.bitbucketToken` is a controller-only read credential; absent credentials disable historical lookup explicitly. The built-in lookup scans a bounded part of the configured development branch and reports `search_truncated` rather than claiming exhaustive search.

`listIssueKeys` supports discovery before per-ticket validation. The later workflow can enqueue each key, record a rejected ticket as BLOCKED, and continue with the next key. `listIssues` is a convenience for callers that want hydrated snapshots together; it propagates a hydration failure.

CLI authentication is resolved from a named profile into a provider-specific environment. No ambient controller token is inherited. Production callers must supply the runner boundary before invoking a provider; the adapter's process options and role validation do not provide an OS sandbox. Cursor's binary is configurable, including installations using the `agent` alias.

Git workspaces are tracked within the runner instance. Durable restore/resume and lease recovery are not implemented by this module and need explicit integration in Task D. The trusted credential option accepts an askpass executable or SSH agent socket, keeping credentials out of repository URLs and provider environments. Test-only remote overrides are restricted to constructor options and are absent from the production configuration schema.

## Verification

`npm run check` passes strict production/test type checking, 49 automated tests, and canonical configuration validation. Coverage comprises 10 shared-contract tests, 16 Atlassian fake-response tests, 13 fake-CLI tests, 9 disposable-Git tests, and one integration test spanning all three adapters.

The integration test proves that a synthetic Jira filter and Confluence map select the expected development SHA, a fake SWE process edits that disposable checkout, current evidence permits a local feature commit, and evidence from another attempt is rejected. It also inserts a competing remote feature ref between the push precheck and actual push; the ref remains unchanged and the local commit survives.

The check/QA/review records in that integration test are schema fixtures. No Java build, real model review, or company ticket fix is implied. Tests contact no live Jira, Confluence, Bitbucket, or coding provider account.

## Review decisions

- Codex JSONL parsing accepts the documented completion envelope and rejects errors, failed command records, and invalid event ordering.
- Positional prompts use an option delimiter; bounded reads, output limits, and process-group cleanup cover early exit, timeout, and cancellation.
- Jira search and comments pagination fail on incomplete or unsafe continuation data. Key discovery lets the future queue isolate ticket-specific failures.
- Historical precedents require an actual commit diff and safe provenance URLs. An exhausted bounded scan is reported honestly.
- Candidate hashes bind content and modes to repository, base, issue, and attempt. Changed source, staging transformations, or unexpected Git metadata cannot silently reuse earlier evidence.
- Optional push uses an exact absent-ref lease as a create-only comparison. Git names this option `--force-with-lease`, but its expected value is always empty: it cannot update an existing ref. Plain force and leases that permit replacing existing refs are not exposed.

## Remaining delivery

Task D must implement SQLite claims, polling, state persistence, retries, repair orchestration, artifact storage, and recovery. Task E must implement the remaining `autos` commands, authenticated HTTP routes, generated OpenAPI, and operator diagnostics. Task F must provide the real synthetic application/regression fixture, trusted supervisor, containers, role permissions, and deployment persistence.

After those are integrated, configure the actual Jira filter, Confluence page, repositories, build profiles, and approved CLI sessions; run all three provider smoke tests and a real read-only pilot before executing a ticket. No on-prem host or live credential is needed to continue local implementation.
