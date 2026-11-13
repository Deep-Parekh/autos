# Autos: feature and option inventory

A complete list of what Autos does and every option an operator can set, written as source material for an engineering blog post. For the reasoning behind each design choice see [architecture-and-design-decisions.md](architecture/architecture-and-design-decisions.md); for exact command syntax see [cli.md](cli.md).

**Verification status, stated plainly.** Everything below is implemented and covered by automated tests that use fake services, fake provider processes and disposable local Git repositories (about 814 tests). A local pilot on macOS has run real tickets end to end with real coding CLIs. Not yet exercised with real systems: the knowledge gateway and live progress in real containers, the Teams bot (separate branch), and everything in section 12 (semantic precedent search and Confluence drafts), which has only run against fakes.

---

## 1. What Autos is

Autos takes bug tickets from a Jira saved filter and tries to fix each one without a human until review:

1. Read the ticket and find its repository and development branch from a Confluence "branch map" page.
2. Create `deep/<TICKET>` in an isolated workspace pinned to the development branch's current SHA.
3. A **SWE agent** writes the fix; the repository's own **checks** (build and tests) run; a fresh **QA agent** and a fresh **reviewer agent** judge it; up to two repair rounds follow.
4. If checks, QA and review all pass **on the same final code**, trusted code commits it (and optionally pushes). The ticket becomes `READY_FOR_HUMAN`; otherwise `BLOCKED` with a reason.

Agents are existing coding CLIs (Claude Code, OpenAI Codex, Cursor) in headless mode, on team subscriptions. Autos is the system around them: orchestration, isolation, evidence, recovery and operator tooling.

**Hard limits, enforced in code and config (literal `false` values that cannot be switched on):** no Jira writes, no Confluence writes except fix-document drafts (section 12.9), no merge, no pull request creation, no deployment, no production database access, no rebase, no force-push, the branch name template is fixed, and an existing remote feature branch is never overwritten.

---

## 2. Architecture

- **Three trust zones:** trusted host code (controller, workflow, Git runner, supervisor, gateways); agent containers (one CLI per role run); untrusted input (ticket text, repo content, Confluence pages, everything an agent says).
- **Central rule:** permissions are enforced by trusted code and the container boundary, never by the prompt.
- **Components:** Controller (Node.js 22, Fastify, SQLite) · runner supervisor (the only process that talks to Docker, over a unix socket) · agent and check containers · operator CLI · Teams relay.
- **Monorepo packages:** `contracts` (Zod schemas, ports, state machine, config; no I/O), `atlassian`, `git-runner`, `cli-adapters`, `runner`, `workflow`, `precedents`, plus `apps/controller` and `apps/cli`.
- **Ports and adapters:** the workflow depends only on interfaces; real implementations are wired in one file (`apps/controller/src/runtime.ts`), so the entire engine runs against fakes in tests.
- **Technology:** TypeScript strict (`exactOptionalPropertyTypes`), npm workspaces, Zod 4 at every trust boundary, `node:sqlite`, Fastify with generated OpenAPI 3.1, Docker, Server-Sent Events, `node:test` + `tsx`, MCP, Microsoft Teams (Workflows webhook, Adaptive Cards, Entra ID).
- **Deployment shapes:** local pilot on macOS (Docker Desktop) and a single Ubuntu server (controller in Docker Compose, supervisor under systemd).

---

## 3. Intake: which tickets get worked on

- **Saved Jira filter** is the source of tickets (`jira.saved_filter_id`).
- **Project allow-list** (`jira.allowed_projects`); optional **issue-type restriction** (`jira.intake_types`).
- **Acceptance criteria** read from configurable custom fields (`jira.acceptance_criteria_fields`).
- **Repository routing** from a Confluence branch-map page (project → Bitbucket workspace/repo, development branch, sandbox branch, optional JDK and Tomcat columns); the page version is recorded as evidence.
- **Auto-poll** on/off (`jira.auto_poll`), interval (`jira.poll_seconds`, min 10 s), and **backlog throttle** (`jira.max_new_per_poll`, 1–100). With auto-poll off, only explicitly submitted tickets run.
- **Poll backoff:** consecutive failures double the delay up to max(4× interval, 5 min); logged as `poll_failed` with a code only.
- **Hold:** `autos note KEY --hold` keeps discovery away from a ticket until `--release` (an explicit `autos run` still works).

---

## 4. Agents, roles and models

### 4.1 Roles
- **SWE** (writes code; source read-write), **QA** (judges against acceptance criteria and check results; source read-only), **reviewer** (finds defects; source read-only).
- **Fresh session per invocation**; no shared conversation between roles.
- QA and reviewer return **structured JSON verdicts** tied to an exact candidate digest; malformed output is a failed gate, never a pass.

### 4.2 Providers
- **Claude Code, Codex, Cursor**, each with a configured binary and auth profile (`providers.<name>.binary|auth_profile`).
- **Cursor is auto-only** (`model: auto`; any other model is rejected).
- **Subscription auth** (team logins staged per provider), with an optional supervisor mode that refuses anything but subscription profiles (`AUTOS_REQUIRE_SUBSCRIPTION`).
- **Reasoning effort** per entry: Claude `low|medium|high|xhigh|max`, Codex `none|minimal|low|medium|high|xhigh|max`, Cursor none; validated per provider.

### 4.3 Provider fallback chains
- Each role: a primary plus up to two `fallbacks`; a chain never repeats a provider.
- Fallback only on provider-side failures: `AUTH`, `RATE_LIMIT`, `UPSTREAM`, `UNAVAILABLE`, `TIMEOUT`, `INVALID_OUTPUT`, `CONTEXT`. A FAIL verdict is a result, never a fallback trigger.
- SWE falls back only if the failed provider left the workspace unchanged; otherwise it hands off (4.6) or blocks.
- Repair rounds restart at the primary.

### 4.4 Model tiers and ladders (cost control)
- **Named models** (`models:`) and **tiers** (`model_tiers:`), each tier an ordered list of 1–3 `{provider, model, effort}` entries tried in order on provider failures.
- **Per-role ladder** of tiers, cheapest first, with an optional **floor** (`min`).
- **Escalation** to the next tier when checks/QA/review fail (the repair runs one tier up) or when a whole tier fails with `CONTEXT`/`INVALID_OUTPUT`. Escalations do not consume repair rounds.
- **Triage:** one cheap, read-only call per new ticket picks each role's starting tier; trusted code clamps it to the ladder and floor (`triage.enabled|tier|timeout_ms`).
- **Start-tier precedence:** revision pin > ticket pin > previous attempt's finishing tier > triage > lowest tier/floor.
- **Tier pins** per issue and role (`autos tier KEY TIER[:EFFORT] [--role]`), set before or after Autos has seen a ticket, with effort overrides.
- **Evidence:** `tiers.json`, tier/model/effort on every call record and event, `tier_selected`/`tier_escalated` events.

### 4.5 Timeouts
- Per-role `timeout_ms`; triage and judge have their own.

### 4.6 SWE continuity
- **Handoff:** an interrupted SWE (fallback, rate limit, context exhaustion) passes its checklist, last tool uses (names and paths only, marked untrusted) and the current diff to the next provider, within a reserved 42 KiB of prompt budget.
- **Persistent per-job SWE scratch** (`/scratch`, warm Maven state) shared by every SWE invocation of the job; QA/reviewer get their own empty scratch. Deleted when the job ends.

---

## 5. Isolation and trusted Git

### 5.1 Containers (one `docker run` per role run)
- Read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, non-root user, memory/CPU/PID limits.
- Workspace read-write for SWE, **read-only for QA and reviewer**; `/workspace/.git` read-only for everyone.
- `tmpfs` home; only that provider's login; never the Atlassian token, SSH key or Docker socket.
- **Check containers have no network.**
- **Separate supervisor** process with a narrow, re-validated API (run role, run checks, stop job, health) on a unix socket — privilege separation.
- **Egress firewall script** (server) blocks cloud metadata and private/VPN ranges from agent containers.

### 5.2 Toolchains
- Per-project **JDK and Tomcat** selection from the branch map (or the build profile), installed under `AUTOS_TOOLCHAIN_ROOT` with an installer script that sanitizes Tomcat copies; reported by `autos doctor --deep` and `/v1/status`.
- **Offline build dependencies** (pre-seeded Maven state) for network-less checks.

### 5.3 Trusted Git
- Only host code runs mutating Git commands; all processes use **argument arrays, never shell strings**.
- **Pinned base SHA** per attempt; a moving branch cannot change what was reviewed.
- **Candidate inspection:** diff + digest of exactly what changed; **path policy** per repository (`allowed_paths`, `prohibited_paths`); instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, …) cannot be modified by agents.
- **Commit by digest:** commit only the digest that passed checks, QA and review.
- **Push** off by default (`bitbucket.push_feature_branch`); create-only first time, fast-forward afterwards; never force.
- **Blocked attempts keep their work** (`bitbucket.push_blocked_attempts`): unreviewed work is committed (clearly labelled) and pushed so humans can inspect it; a retry continues from it.
- **Remote URL must match** the configured Bitbucket workspace/slug exactly.
- **Repository instruction files** (AGENTS.md, CLAUDE.md, GEMINI.md, Copilot and Cursor rules) are read from the checked-out commit and given to every role as binding conventions (they cannot override platform policy).

---

## 6. The workflow engine

- **State machine:** `QUEUED → INVESTIGATING → IMPLEMENTING → QA → REVIEW → READY_FOR_HUMAN`, plus `REVISING`, `PAUSED`, `PLANNED` (dry run), `BLOCKED`, `CANCELLED`. Illegal transitions throw.
- **Durable queue with leases** in SQLite: claim in a transaction, heartbeat-renewed lease, crash recovery that re-validates workspace, base and evidence before continuing. Terminal history is immutable; a retry is a new linked attempt.
- **Finalization gate:** checks PASS + QA PASS + review PASS, all on the same candidate digest. `NOT_RUN`, stale evidence, malformed output or timeout block.
- **Baseline checks** run before the SWE, so pre-existing failures are known.
- **Repair rounds** (`jobs.max_repair_rounds`, 0–2).
- **Prompt budget** (180 KiB) with a defined truncation order and a sanitized event recording what was truncated.
- **Prompt-injection hardening:** ticket text marked untrusted; operator notes delimited by a fresh per-invocation nonce; look-alike markers neutralized.
- **Dry run:** reads ticket, mapping, base and precedents; writes a plan; no workspace, agent, commit or push; ends `PLANNED`.
- **Concurrency:** `jobs.max_parallel` (1–8) ticket slots, `jobs.max_concurrent_checks`, never more than one active job per issue.
- **Rate-limit pause:** when every provider of a role is limited, the attempt is `PAUSED` (keeps workspace, base, branch, round), the workspace is sealed and verified on resume, resume time comes from the providers' structured reset times or backoff (`jobs.rate_limit_pause.initial_minutes|max_minutes|max_total_hours`). Paused jobs hold no slot and resume first.
- **Provider limit gate:** while every SWE-chain provider is limited, no new ticket starts (avoids creating workspaces that would immediately pause).
- **Automatic infrastructure retries** before any agent starts (1, 2, 4, 8, 16 minutes) for `UPSTREAM`, `RATE_LIMIT`, `UNAVAILABLE`, `TIMEOUT`.
- **Revisions after review:** `autos revise` continues from the reviewed commit on the same branch and base with operator notes, reruns everything, adds a commit, fast-forwards only.
- **Retries:** `autos retry JOB_ID` or `--all-blocked [--code CODE]`.
- **Cancel** at any time.

---

## 7. Operator guidance

- **Operator notes** on a run or revision (`--note`, `--note-file`, `--roles`), stored as evidence, never logged.
- **Ticket notes** stored by issue key before or after Autos sees the ticket, per role (`--swe`, `--qa`, `--reviewer`, `--all`), up to 5 per issue, carried into every new attempt.
- **Holds**, **tier pins** (4.4).
- **Close an issue** (`autos close KEY --merged|--abandoned`): records the human outcome, removes its workspaces, keeps evidence; dry-run preview and confirmation.

---

## 8. Evidence, privacy and hygiene

- **Per-attempt evidence packet:** `issue.json`, `branch-map.json`, `base.json`, `precedents.md`/`precedents.json`, `implementation.md`, `baseline-checks.json`, `checks.json`, `qa.json`, `review.json`, `rounds.json`, `tiers.json`, `effective-instructions.md`, `operator-notes.json`, `parent.json`, `toolchain.json`, `changes.patch`, `closure.json`, `summary.md`, `possibly-affected.json`, `fix-report.md`, `confluence-draft.json`, plus a hashed **manifest**.
- **Private artefacts:** prompts, transcripts and per-call metadata (`call.json`) are never returned by the API.
- **Events** in SQLite are the single history for status, watch, Teams and recovery; sanitized metadata only.
- **Secrets** only via environment variables named in config (`*_env`); typed `AutosError` with a fixed code list; no tokens, credential URLs or raw upstream bodies in errors or logs (tested); transcripts redacted against provider credentials.
- **Workspace retention:** `jobs.workspace_retention_hours` (default 72), `jobs.auto_prune_workspaces`, `autos workspaces [--sizes]`, `autos workspaces prune [--dry-run] [--older-than]`. The latest ready workspace of an open issue is kept for revisions. Artifacts are never deleted automatically.
- **Dataset export** (`autos export dataset`): one JSONL record per attempt with metadata, human outcome (`merged`, `abandoned`, `revised`, `awaiting_review`, `blocked`, `cancelled`), operator feedback, parsed evidence, final diff, every provider call with prompt and transcript, progress timeline, tiers, and the precedents shown. Filters `--since`, `--issue`, `--outcome`; `--no-prompts`, `--no-transcripts`; reads SQLite read-only, no controller needed.

---

## 9. Live progress

- Agents' tool calls (program plus at most two arguments, file paths) are extracted from the CLIs' JSON streams in the container, scrubbed and throttled (2 s), forwarded as NDJSON by the supervisor, and turned into `role_progress` events (5 s throttle, capped per run).
- A "files changed (+/−)" counter from trusted Git.
- Actions, never narrative; best effort (a broken stream cannot change an outcome); backward compatible between controller and supervisor versions.
- Shown in `autos watch`, `autos status` (latest action and age) and Teams.

---

## 10. Knowledge gateway (read-only Jira/Confluence tools for agents)

- Seven read-only tools: get issue, issue comments, attachment, search issues, search pages, get page, list page children.
- A host gateway holds the token; a credential-less **stdio MCP shim** in each container forwards calls with a **per-run bearer token** bound to job, ticket and role and revoked when the run ends.
- **Allow-list** of Jira projects, Confluence spaces and page trees; queries composed server-side (no raw JQL/CQL from agents); GET-only client, redirects refused.
- **Budgets:** `max_calls_per_run` (80), `max_result_chars` (40k), `max_total_chars_per_run` (600k), `max_attachment_bytes` (5 MiB).
- **Audit record** per call (`knowledge-audit.json`: tool, target, outcome, sizes, timing; never content).
- Options: `knowledge.enabled`, `roles`, `gateway.listen_host|port|advertise_url`, `jira.projects`, `confluence.spaces|pages`, `limits.*`.

---

## 11. Operator interfaces

### 11.1 CLI (`autos`)
`init`, `doctor [--deep]`, `providers`, `providers test --all`, `run [--dry-run] [--note]`, `revise`, `close`, `show`, `note`, `notes`, `tier`, `workspaces`, `workspaces prune`, `retry`, `retry --all-blocked`, `jobs show|cancel`, `queue list`, `controller start`, `status`, `watch [--quiet-progress]`, `events`, `teams relay|test`, `export dataset`, `docs validate|preview`, and (section 12) `index status|sync|rebuild|purge`, `lineage show`, `precedents search|show`, `confluence draft`. Most remote commands take `--url`, `--json`, `--config`.

### 11.2 HTTP API
- Loopback only (`api.listen_host` `127.0.0.1`/`::1`, `api.port`), bearer token (`api.operator_token_env`, ≥ 16 chars), optional `X-Autos-Operator` actor label.
- Jobs, revisions, retries, cancel, issues, closures, notes, holds, tier pins, workspaces, status, events and an **SSE stream** with `Last-Event-ID` resume, index/lineage/precedents/drafts endpoints.
- **Generated OpenAPI 3.1** (`docs/openapi.yaml`); a test fails if it drifts; `autos docs preview` serves the reference locally.
- **Structured logs:** one line per request; `audit` lines for every mutating operation (ids, counts, codes; never bodies, tokens or note text).

### 11.3 `autos doctor`
- Offline: config, env references, provider binaries per role chain, warnings, precedents and drafts config.
- `--deep`: supervisor socket and health, images, toolchains per project, Git credentials, Jira filter count, branch map, base-branch resolution per project, free disk space, index status and lineage.

### 11.4 Teams
- **Relay** follows the event stream and posts **Adaptive Cards** for ready, blocked, paused, Autos up and Autos down (`notifications.teams.notify`), with job facts, tier start→finish, reasons, resume times, copyable next-step commands (`include_commands`) and an "Open in Jira" button.
- Webhook URL is a secret (env var); `payload: message|card`; optional **Entra ID client-credentials auth** (`tenant_id`, `client_id`, `client_secret_env`, `cloud`).
- Durable cursor (`data/teams-relay.json`), retries with backoff honouring `Retry-After`, failures skipped and logged.
- Cards never contain ticket text, notes, diffs or provider output.
- **Teams bot** (separate branch): two-way commands, Bot Framework JWT verification, Entra object-ID allow-list, confirmation for destructive commands.

---

## 12. Semantic precedent search and fix documents (built in this phase)

Replaces the earlier keyword/component "similar tickets" lookup. All off by default; without the new config the system behaves exactly as before (verified by a byte-identity test).

### 12.1 Problem it solves
- Many project branches were cut from a small number of base repositories over the years, and each project has its own Jira project. A bug introduced before a branch point exists in every project cut from that base and gets reported in different words in different Jira projects.
- Issue types are unreliable (bugs filed as stories, tasks, epics), so search ignores type.
- Many tickets have no true match, and shared domain keywords produce confident false positives, so the system must **abstain** without real evidence.

### 12.2 Code lineage model
- A **lineage** = one base repository and the branches cut from it (`precedents.lineages[]`: `id`, `repository`, `root_branch`, `scan_branches` (default `**`), `ignore_branches`, `branch_codes`). Lineages never share evidence.
- **Nodes** = development branches from the branch map, each with its **fork point** (`merge-base` with the root) and date.
- **Dev/sandbox branches** `<code>_dev` / `<code>_sbx` attach to their project by name, then by Git ancestry, then by an explicit override; unattached branches are reported.
- **Read-only bare mirrors** per lineage (trusted credentials, mode 0700), refreshed in the background.

### 12.3 Indexing
- **Read-only Jira sync** across every branch-map project (any issue type, any status), **2-year window** (`index.window_weeks`, default 104).
- Full sync (resumable cursor), incremental sync with a configurable re-read overlap (`index.overlap_minutes`, default 24 h, because Jira JQL dates use the API user's time zone), request pacing (`min_request_interval_ms`) and per-run budget (`max_requests_per_run`).
- **Reconcile** (`reconcile_interval_hours`): deleted, moved, out-of-window or no-longer-visible issues are hard-deleted; moved issues keep old keys as aliases.
- Issues with a Jira security level and comments with visibility restrictions are never stored; bot comments are skipped; `exclude_projects`; `include_comments`.
- **Text processing built against false positives:** per-project template/boilerplate stripping, a corpus stoplist for very common terms, a compact **defect statement** (observed, expected, where, error evidence), **error signatures** (exception classes, error codes, HTTP status + endpoint, normalized top stack frames, log templates) as exact-match keys, **code identifiers** resolved to real files on the project's branch, and secret redaction.
- **Fix linking from Git history:** issue keys in commit messages, branch names and Bitbucket merge messages across all refs; `git patch-id --stable` per fix so **ported fixes are matched by content, not by key** (fixes use the local project's key); revert detection; files and line counts; branch containment; Autos' own attempts and their human outcome.
- **Storage:** one SQLite file (`data/precedents.sqlite`, 0600) with FTS5 keyword search and float32 vectors; content-hash idempotent upserts so only changed text is re-embedded; model/dimension mismatch requires a rebuild.

### 12.4 Embeddings
- **Local only by default:** Ollama adapter (`embedding.provider: ollama`, `url`, `model`, `dimensions`, `batch_size`, `timeout_ms`), loopback or Compose-service URLs only, no auth headers, redirects refused. `provider: none` runs keyword and error-signature search without a model.
- The whole ticket corpus never leaves the host.

### 12.5 Retrieval pipeline
1. **Candidates** from vector search on defect statements, BM25 keyword search with the stoplist, exact error-signature matches, code-reference overlap, and the ticket's own Jira links.
2. **Fusion** with Reciprocal Rank Fusion and a transparent feature score (semantic, error signature, code overlap, same lineage, inherited-before-fork, not yet fixed here, Autos merged outcome, mild recency), with an explain record per candidate.
3. **Evidence gate:** at least two independent signals; keyword overlap alone never counts; a near-duplicate report can pass alone.
4. **"Same defect?" judge:** the survivors (≤ 10) go to the **cheapest configured model tier** at low effort (`judge.tier` override) through the trusted runner in a read-only sandbox with no repository. It can only drop candidates, never add; failure means `NOT_RUN` and a stricter local threshold.
5. **Classification and abstention:** `FIXED_IN_RELATIVE` (with `applies_cleanly` from a `git apply --check` against a temporary index and `inherited` from blame ancestry), `ALREADY_PRESENT_HERE` (same patch-id already on this branch), `ALSO_REPORTED` (same bug open elsewhere), `RELATED_FIX` (CLI only), or `NO_MATCH`.
- Options: `max_results` (1–5, default 3), `gate.semantic_threshold|strict_threshold`, `judge.enabled|tier|max_candidates|timeout_ms`.

### 12.6 What humans and agents see
- **`precedents.md`** per job: shown precedents with signals, judge verdict, fix commit and branch, inheritance and applicability; "Same bug may be open in other projects"; **rejected candidates with the reason** (makes false positives visible).
- **`precedents.json`** (validated result) and dataset fields `precedent_keys`, `precedent_kinds`.
- **Reference block in prompts** only for roles in `prompt.roles` (empty by default until accuracy is measured): SWE gets fix precedents with bounded diff excerpts; reviewer gets keys, summaries and files only; QA never. Nonce-delimited, neutralized, marked untrusted, never comments; it is the first thing truncated (`prompt.max_bytes`, `per_precedent_diff_bytes`).
- **Same-bug-open-elsewhere tickets are never given to agents and never queued automatically**; an agent works on one only when someone queues it.

### 12.7 "May also affect" after a fix
- When an attempt is ready, Autos rechecks using the actual fix: open tickets in other projects that still match, and **other project branches in the same lineage that still contain the code the fix changed** (inherited before their fork, or the patch applies cleanly / needs adaptation) and do not already have the fix.
- Written to `possibly-affected.json`, appended to `summary.md`, included in `fix-report.md` and the Confluence draft; worded as "may be a similar issue and should be checked/fixed". Option `possibly_affected`.

### 12.8 Index operations
- Background loop in the controller (first tick after ~5 s, then every minute; single-flight; never blocks jobs) when `index.auto_sync`; `sync_interval_minutes`.
- `autos index status|sync [--full] [--reconcile]|rebuild|purge --project`, `autos lineage show`, `autos precedents search (--issue|--text) [--no-judge] [--include-unresolved] [--explain]`, `autos precedents show KEY`, matching `/v1/index/*`, `/v1/lineage`, `/v1/precedents/*` endpoints; doctor checks.
- The index can be built and evaluated with `source: legacy` before jobs use it (`source: semantic`).

### 12.9 Confluence fix-document drafts
- `autos confluence draft JOB_ID|ISSUE-KEY` (or `confluence.drafts.auto: true`) creates an **unpublished Confluence draft** of the fix document in a configured space and parent page (`space_key`, `parent_page_id`): ticket, repo/branch/commit, changed files, checks, QA, review, fix summary, "May also affect", precedents used, limitations.
- Visible only to the account whose token Autos uses; **the human reviews and publishes it in Confluence**.
- A separate, tiny writer: hard-coded `status: draft`, no publish or delete code path, only the configured space and parent, updates only a draft Autos created that is still an untouched draft (otherwise it creates a new one and records which page it supersedes). All text escaped into Confluence storage format; secrets redacted; never exposed to agents. Recorded in `confluence-draft.json`.

---

## 13. Configuration reference (top-level keys)

| Key | What it controls |
| --- | --- |
| `schema_version` | Config format version (1) |
| `jira` | Site, saved filter, allowed projects, intake types, acceptance-criteria fields, poll interval, auto-poll, max new per poll, credentials env names (read-only enforced) |
| `confluence` | Site, branch-map page, credentials env names (read-only enforced), optional `drafts` |
| `bitbucket` | Allowed repositories (remote, protected branches, build profile, allowed/prohibited paths), push of ready and blocked work, optional read token (legacy precedents); PR creation fixed off |
| `git` | Fixed branch template `deep/{issueKey}`, no rebase, no force push, refuse existing feature branch (all literal) |
| `providers` | Binary and auth profile for claude, codex, cursor |
| `models`, `model_tiers`, `triage` | Named models, tiers with effort, triage call |
| `agents` | Per role: provider/model/fallbacks or ladder/min, timeout |
| `jobs` | Parallel slots, concurrent checks, repair rounds, workspace retention and auto-prune, rate-limit pause, legacy `similar_tickets` |
| `build_profiles` | Check commands (argument arrays, timeouts, required), JDK, Tomcat |
| `precedents` | Section 12: enabled, source, lineages, max results, index, embedding, gate, judge, prompt, possibly-affected |
| `security` | `allow_jira_write`, `allow_confluence_write`, `allow_merge`, `allow_deploy`, `allow_prod_db` — all literal `false` |
| `storage` | Data, artifacts and workspaces directories (must be distinct, non-overlapping, dedicated) |
| `api` | Loopback host, port, operator token env |
| `notifications` | Teams webhook, kinds, commands, payload shape, Entra auth |
| `knowledge` | Section 10 gateway |

---

## 14. Testing and quality

- Fakes at every port (Atlassian fetch, runner, Git or disposable repos, provider CLI scripts printing realistic streams); no test calls a real model or company system.
- Safety assertions: no secrets in errors, GET-only Atlassian reads, illegal transitions rejected, stale evidence blocks, draft writer never publishes or deletes, prompt-injection markers neutralized.
- Contract tests: OpenAPI parity, event fields exposed by the API, byte-identical legacy behaviour when new features are off.
- Opt-in real-Docker tests for the container boundary.
- A synthetic end-to-end scenario (`npm run scenario:synthetic`) runs the real controller, real Atlassian client against fakes, real adapters with fake CLIs and real `javac`/`java` checks.
- `npm run check`: typecheck, all tests, config validation, OpenAPI validation and lint.

---

## 15. How it was built

- A primary AI agent wrote shared contracts first, then delegated packages to parallel worker agents with written briefs and **strict file ownership**; workers never commit; the primary reviews, integrates, runs the full check and commits.
- The same pattern built the semantic precedent feature: three workers for the foundations (Jira/Confluence, Git lineage, search core), then three for integration (search service, workflow, CLI/controller), with the primary wiring the runtime.

---

## 16. Known limits and what is next

- Agents have outbound internet (needed for model APIs); exposure is bounded by giving them nothing worth stealing, not eliminated. Next: an egress proxy allowing only provider hosts.
- Single host, SQLite: no horizontal scaling (Postgres if that changes).
- Classic Atlassian API token can do more than Autos uses.
- Semantic precedents: needs live validation (Ollama model, Confluence draft visibility, Git ≥ 2.37 on the server), threshold calibration on real data, an `autos precedents eval` command, sqlite-vec instead of brute-force vectors, and the Compose embedding service.
