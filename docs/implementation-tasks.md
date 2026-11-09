# Autos independent implementation tasks

Six GPT-6 Luna workstreams implement Autos against shared contracts. O0 and Tasks A–F are implemented and integrated; the synthetic first scenario runs with `npm run scenario:synthetic`. Docker boundary tests remain unverified on a Docker-enabled host. Live integration smoke tests await pilot credentials and execution isolation. The original requirements remain in `Autos_MVP_Requirements_and_Starter_Docs/`; proposed reconciliations and delivery gates are in [the implementation plan](implementation-plan.md). See [foundation usage](foundation.md) for the current development commands and boundaries, and [the first wave report](wave-one.md) for verification.

## Foundation owned by the orchestrator

**O0 Establish the workspace and contracts.** Initialize local Git; create npm workspaces, TypeScript configuration, package scripts, test tooling, `.gitignore`, `AGENTS.md`, and the canonical config example. Define the shared schemas and interfaces below before dispatching workers. Select compatible dependency versions at implementation time and own the root lockfile.

| Shared contract | Required contents |
| --- | --- |
| Configuration | Exact repository allowlist, Cloud site/filter/page IDs, three providers and role assignments, build profiles, branch template, concurrency, repair limit, timeouts, read-only invariants, explicit push option |
| Domain | Issue snapshot, filter membership, project mapping with source/version, pinned Git base, job/attempt identity, canonical states and stable errors |
| Provider | `run(request, signal)` with role, provider/model, prompt path, workspace, permission profile, timeout; normalized completion/error and transcript metadata |
| Git and runner | Prepare/read diff/finalize/push operations; launch/stop job and role processes with scoped mounts and credentials |
| Workflow ports | Atlassian reads, repository operations, role execution, check execution, persistence, clock, artifact storage |
| Evidence | Versioned check/QA/review/manifest records, PASS/FAIL/NOT_RUN rules, repair round, candidate identity, redaction |

**Done:** packages type-check against the same exported contracts, configuration rejects inconsistent or prohibited settings, and module ownership is documented. A scaffold is not a working controller.

## Independent workstreams

| Task | Luna worker | Owned implementation paths | Prerequisites | Delivery |
| --- | --- | --- | --- | --- |
| A | Atlassian reads | `packages/atlassian/**`, `tests/atlassian/**` | O0 | Saved-filter intake, issue snapshots, strict Confluence mapping, optional precedent reads |
| B | CLI adapters | `packages/cli-adapters/**`, `tests/cli-adapters/**` | O0 | Claude, Codex, and Cursor execution with normalized results and cancellation |
| C | Git operations | `packages/git-runner/**`, `tests/git-runner/**` | O0 | Isolated checkout from pinned development SHA, safe commit and optional feature push |
| D | Workflow and queue | `packages/workflow/**`, `tests/workflow/**` | O0; A/B/C ports can be faked | SQLite claims, polling, stage execution, repairs, artifacts, recovery |
| E | Operator interfaces | `apps/cli/**`, `apps/controller/**`, `tests/interfaces/**`, API and command docs | O0; workflow service contract can be faked | `autos` commands, authenticated local routes, generated OpenAPI and contract checks |
| F | Fixtures and isolation | `packages/runner/**`, `docker/**`, `docker-compose.yml`, `tests/fixtures/**`, `tests/e2e/**` | O0; B/C integration follows | Synthetic Java/Struts/JS bug, fake services/processes, isolated execution and restart harness |

Each worker may edit only its assigned paths. Task E owns `docs/openapi.yaml`, `docs/cli.md`, and `docs/api-publishing.md`; the orchestrator owns other shared documentation. Root manifests, lockfiles, contracts, CI wiring, and changes to this allocation go through the orchestrator. This avoids concurrent dependency and contract edits.

## Task A Atlassian reads

Implement filter lookup, enhanced JQL pagination, issue/comment snapshots, and one configured Confluence page fetched by ID. Parse the mapping table into normalized fields including Enabled. Validate the exact repository allowlist; reject duplicate, disabled, malformed, or ambiguous mappings. Preserve the source page version.

Add optional historical discovery with at most five candidates and verifiable commit/PR provenance. A resolved issue alone is not a precedent. An explicit no-match is valid; a missing credential or failed request must be distinguishable from no results. No embeddings or write clients.

**Done:** fake-server contracts cover multi-page search, forbidden private filter, 429/backoff, mapping errors, and zero mutation operations. Raw Jira/Confluence data cannot become privileged instructions. Real private-filter smoke testing is recorded separately and requires the pilot configuration.

## Task B CLI adapters

Implement a shared subprocess executor and distinct Claude, Codex, and Cursor adapters. Confirm current headless flags and output formats against official docs and installed CLI help during implementation. Use argument arrays, explicit working directories, bounded output, restricted environments, timeout and process-tree cancellation. Do not use shell interpolation or permissive bypass flags.

Normalize success, authentication, rate limit, timeout, cancellation, malformed output, and tool failure. A zero process exit does not by itself mean the QA/review result is valid. Separate invocation readiness from installed-binary detection. Each role starts a fresh session unless SWE is explicitly continuing its own corrective round.

**Done:** fake executables demonstrate every normalized failure and cancellation path. All three parsers have recorded synthetic fixtures. Read-only installed-provider smoke tests are separate from unit tests; a writer smoke test uses only a disposable fixture. The adapter consumes Task F's runner boundary rather than implementing host/container privileges itself.

## Task C Git operations

Prepare a disposable job repository from the mapped remote development branch, record the fetched SHA, and create exactly `deep/<ISSUE_KEY>`. Validate issue keys, branch/ref names, remote identities, allowed repositories, workspace containment, and local/remote feature-branch collisions. Do not reuse the operator's current checkout.

Expose controlled diff, candidate inspection, commit, and optional push operations. Include newly created files in candidate checks; refuse disallowed paths and unsafe symlink escapes. Disable repository-supplied hooks in trusted Git operations. Stage explicit reviewed paths and verify that the final content matches approved check/review evidence. A push failure preserves the local commit and reports a separate outcome.

**Done:** disposable local bare remotes prove the base SHA, collision refusal, exact changed files, feature-only push, and no overwrite/force-push/rebase/merge. Runtime credentials belong to trusted code, not the coding shell.

## Task D Workflow and durable queue

Implement the state machine, SQLite migrations and transactional claims, filter discovery, one active job, and deduplication. Preserve issue/attempt history, avoid rerunning READY_FOR_HUMAN issues after a new base commit, and let a blocked issue release the queue. Implement cancellation, restart recovery, bounded infrastructure retries, and explicit retry/resume semantics.

Coordinate dry-run planning, SWE, deterministic checks, QA, reviewer, up to two corrective rounds, final candidate verification, commit, and handoff artifacts through injected ports. Require current evidence for every candidate; NOT_RUN or malformed required evidence blocks completion. Maintain effective repository instructions as affected paths become known.

**Done:** deterministic fake ports and a temporary SQLite database prove transitions, repair bounds, double-poll behavior, concurrent claim exclusion, cancellation, restart, one-blocked/one-successful queue behavior, and no false READY_FOR_HUMAN. A dry-run reaches PLANNED without a coding session or Git write. Task D does not implement HTTP handlers or vendor CLI parsing.

## Task E Operator CLI and local API

Implement the `autos` executable with `init`, `doctor`, `providers test --all`, `run <ISSUE_KEY> [--dry-run]`, `queue list`, `docs validate`, and `docs preview`. Add an explicit controller start mode for continued polling and document how Compose starts it. CLI operations and HTTP handlers call the same workflow services. Configuration initialization writes a local example and secret references, never raw credentials.

Implement `/health`, `/v1/providers`, `/v1/projects`, `/v1/queue`, job creation/history/details/artifacts, and cancellation. All operator endpoints require bearer authentication; health stays minimal. Use validated route schemas and stable errors/request IDs. Generate OpenAPI 3.1 from those schemas, including the PLANNED dry-run state, rather than maintaining a second handwritten API definition.

**Done:** CLI smoke tests exercise faked services; route tests validate auth, redaction, schemas, cancellation, errors, and OpenAPI parity. Documentation marks unfinished capabilities accurately. Bind the host interface to loopback; container networking must still allow the host's explicitly loopback-published port. Task E does not implement a dashboard or public hosting.

## Task F Synthetic fixtures and execution isolation

Build a minimal seeded Java/Struts/JS fixture with a reproducible bug and regression test, a read-only fake Jira/Confluence service, fake provider processes, and local Git remotes. Deterministic fakes make controller integration testable without cloud accounts; they do not count as real provider certification.

Implement the trusted runner supervisor and disposable non-root execution profiles. Scope source, generated output, provider auth, process environment, resource/time limits, network access, and cleanup by role. SWE can edit allowed source; QA/reviewer cannot. Agents cannot access controller credentials, Git push credentials, controller API, or Docker control. The supervisor exposes fixed job actions rather than arbitrary privileged shell commands.

Provide controller and runner images plus Compose persistence for SQLite and artifacts. The trusted host supervisor launches jobs without exposing the Docker socket to untrusted containers. Define how required build dependencies/private Maven artifacts will be supplied for the real pilot.

**Done:** boundary tests demonstrate denied source edits for QA/reviewer, absent controller/Git credentials, process-tree cancellation, and persistent state after restart. The fixture's regression fails before the fix and passes afterward. Integrated real-provider execution is a milestone after B/C/D are available; document any missing provider or container prerequisites precisely.

## Dispatch order and integration

1. **O0:** orchestrator establishes and reviews shared contracts.
2. **Wave 1:** Luna A, B, and C implement independent adapters in parallel.
3. **Wave 2:** Luna D, E, and F implement workflow, interfaces, and fixture/isolation harness in parallel. Shared port fakes permit development before every integration is complete.
4. **Integration:** orchestrator reviews each module, wires dependencies and CI, resolves mismatches, and runs the synthetic acceptance sequence. Changes return to the owning worker where appropriate.
5. **Pilot:** configure real inputs, perform a dry-run, then one low-risk bug; finally exercise several queued issues and restart recovery.

This session permits three workers plus the orchestrator at once. Workstream count is independent of runtime ticket concurrency, which stays at one.

## Common worker handoff

Every implementation worker receives a complete task brief with `gpt-6-luna` selected explicitly and the shared plan/contracts included in its context. Report the following on completion:

- Changed paths and implemented public interfaces.
- Commands actually executed and their outcomes; distinguish fakes from real integrations.
- Any missing prerequisite, unresolved failure, or contract change requested.
- Relevant boundary tests and known limitations.

Do not change another worker's files, install or authenticate external accounts, mutate Jira/Confluence, push a repository, or claim an unrun smoke test passed. Ask the orchestrator to resolve cross-module decisions. The orchestrator owns integration commits and delivery review.

## Work the project owner can do independently

- Supply the Jira filter URL/ID and confirm the runtime identity can read it.
- Maintain the Confluence branch-map page with actual repository values and enabled projects.
- Identify one reproducible low-risk bug and its expected behavior.
- Provide repository build/test instructions and required internal artifact/service access.
- Arrange approved CLI accounts, including Cursor availability, and progress the existing on-prem host request.

These inputs can be gathered while local fixture implementation proceeds.
