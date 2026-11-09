# Autos shared foundation

The foundation defines configuration, domain records, evidence gates, and interfaces for the implemented Atlassian, CLI, and Git adapters. It does not start a controller, process Jira tickets, enforce container isolation, or authenticate providers. All original proposal files remain in `Autos_MVP_Requirements_and_Starter_Docs/`.

## Development commands

Use Node 22.20 or newer and npm. Run commands from the project root:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test -- tests/contracts/config.test.ts
node apps/cli/bin/autos.mjs --help
```

`build` emits each workspace's JavaScript and declarations to its ignored `dist/` directory. `typecheck` checks both production code and tests. `check` runs type checking, all discovered tests, and validation of the synthetic configuration. Tests run source through tsx with the `development` export condition; normal built imports use `dist/`.

The current `autos` executable is a foundation preview supporting help and version only. Ticket execution and the remaining CLI commands belong to later workstreams. Workspace package exports are private development interfaces; an externally distributable package is future work.

## Configuration

`config/config.example.yaml` is the canonical schema 1 configuration. Its synthetic IDs and repository are not real pilot settings. Copy it to ignored `config/config.yaml` when configuring a pilot. `npm run config:validate` validates the example; a specific file can be checked with:

```sh
node --conditions=development --import tsx scripts/validate-config.ts config/config.yaml
```

Validation checks shape and policy, not network access or credential presence. Environment-variable names are references, not values. No model API key is required by this foundation: the product uses CLI adapters, and no live coding provider is invoked by its tests.

If Jira stores acceptance criteria in custom fields, list their actual IDs in `jira.acceptance_criteria_fields`. The default is an empty list; criteria are not guessed from unrelated fields.

The schema rejects legacy configuration names, unknown fields, embedded Atlassian credential fields, credential-bearing Git remotes, duplicate repositories, unknown build profiles, public API listen addresses, multiple active jobs, more than two repair rounds, and prohibited mutation capabilities. The trusted runner must still validate and isolate real filesystem locations, credentials, and processes before execution.

## Shared module

Import schemas, types, and interfaces from `@autos/contracts`:

| Export group | Purpose |
| --- | --- |
| `configSchema`, `parseConfig`, `parseConfigYaml` | Strict runtime validation and safe configuration errors |
| Issue, filter, mapping, precedent schemas | Normalize read-only integration output and preserve provenance |
| `providerRequestSchema`, `providerResultSchema` | Validate role access requests and normalized invocation outcomes |
| `checksSchema`, `qaSchema`, `reviewSchema` | Validate structured evidence |
| `evaluateFinalization` | Require matching candidate hashes and passing required checks, QA, and review |
| `canTransition`, `isTerminalState` | Define allowed job lifecycle changes; retries use new attempts |
| `AtlassianReadPort`, `PrecedentReadPort` | Read adapters used by the workflow |
| `GitRunnerPort`, `ProviderAdapterPort`, `RunnerPort` | Separate trusted Git, provider subprocesses, and execution isolation |
| Workflow, job-store, artifact-store, clock ports | Boundaries for later durable workflow implementation |

Git object IDs use the SHA-1 format for the first MVP; candidate/artifact content digests use SHA-256. Relative source paths exclude traversal and Git metadata. Shared schemas do not replace filesystem containment and Git policy checks in the runner.

Candidate identity includes repository, pinned base, issue, job attempt, file paths, content, and modes. Evidence for identical edited files in another job or on another base must be regenerated. Jira key discovery is separate from snapshot hydration so a rejected ticket can be handled independently by the future workflow. Historical lookup reports disabled reasons and whether its bounded history scan was truncated.

## Evidence and execution boundaries

A successful provider invocation means its process and output envelope were valid. It does not establish a passing build or successful fix. Required deterministic checks need real zero exit codes without timeout; QA and review need matching candidate digests and PASS outcomes. Missing, malformed, NOT_RUN, stale, or blocking evidence cannot pass finalization.

The provider adapter executes within an already supplied boundary. Passing `source_access: read` or a native CLI sandbox flag does not itself establish production isolation. Task F must supply that boundary before a controller can launch real ticket jobs. Git credentials and controller credentials remain outside provider environments.

## Integration ownership

The orchestrator owns this module, root manifests and lockfile, shared configuration, and integration tests. Task A owns Atlassian reads, B owns provider adapters, and C owns Git operations. Each worker imports shared contracts and returns test evidence; cross-module changes go through the orchestrator.

Tasks D, E, and F remain separate: durable workflow and queue, operator CLI/API, and synthetic execution/container isolation. Completing A/B/C alone does not produce an unattended Jira-fixing service.
