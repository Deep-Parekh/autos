# Autos — AI SWE Agent MVP build checklist (v3.0)

**Target:** a Dockerized personal prototype that pulls a bug from a **private Jira saved filter**, optionally studies a comparable historical fix, reads a **read-only Confluence project-to-branch mapping**, follows repository `AGENTS.md` instructions, runs developer / QA / reviewer CLI agents, and commits a validated fix on `deep/<FULL_JIRA_KEY>` (for example `deep/WTS-1234`). Optionally push that **feature branch only** to Bitbucket for manual review and rebase.

**No MVP writes:** no Jira mutations; no Confluence writes or draft creation; no Bitbucket PR creation, merge, approval, force-push, or automated rebase. An implementation summary is saved locally among run artifacts.

**Must support from the start:** The `autos` CLI name, Claude Code CLI, Codex CLI, Cursor Agent CLI, Jira, Confluence, Bitbucket, and OpenAPI 3.1 documentation for the controller API. CLI accounts are installed and authenticated only where vendor terms and company policy permit.

## Today — smallest vertical slice

- [ ] **M0.1 | Repo skeleton.** Create `apps/controller`, `packages/cli-adapters`, `packages/atlassian`, `packages/git-runner`, `packages/workflow`, `config`, `tests/fixtures`, `docker` and a single Compose file. **Done:** a controller container starts with persistent `data/` and `artifacts/` directories.
- [ ] **M0.2 | Typed configuration.** Define `config.yaml` validation for Jira filter ID, Confluence page ID, repository allowlist, CLI providers, output branch template and manual-approval boundaries. **Done:** invalid/missing projects and secrets cause a clear preflight error.
- [ ] **M0.3 | CLI provider contracts, all three.** Implement non-interactive subprocess adapters for `claude -p`, `codex exec`, and `cursor-agent -p` (or the installed `agent` alias). Normalize exit status, logs, output JSON, timeout, workdir and role. **Done:** each can run a read-only smoke test; writer test occurs only in an isolated fixture repo.
- [ ] **M0.4 | Jira read integration.** Read a private saved filter, resolve JQL, call the current enhanced Jira issue search endpoint with next-page-token pagination, and fetch selected issue details. **Done:** dry-run ingests a bug; no Jira POST/PUT/DELETE calls.
- [ ] **M0.5 | Confluence branch mapping.** Fetch exactly one configured page by ID and parse a strict table: `project_key`, `bitbucket_workspace`, `repository_slug`, `dev_branch`, `sbx_branch`. **Done:** WTS resolves `wakanda`, UWE resolves `h1_phase2_dev`; missing or ambiguous rows fail closed.
- [ ] **M0.6 | Git checkout.** In a disposable job directory, fetch the allowed repo and `origin/<mapped-dev-branch>`, pin base SHA and create `deep/<ISSUE_KEY>` from that SHA. **Done:** no branch is created off whichever branch happened to be checked out locally.
- [ ] **M0.7 | First implementation pass.** Supply bug, acceptance criteria, base SHA, repo rules and optional precedents to a chosen SWE CLI. **Done:** fixture bug has a test and fix in the job's working branch.
- [ ] **M0.8 | Test/QA/reviewer loop.** Run Maven/test commands, a separate QA CLI session, and a fresh-context reviewer CLI session. SWE applies feedback; cap the loop at two corrective rounds. **Done:** failed tests block READY_FOR_HUMAN.
- [ ] **M0.9 | Final commit and handoff.** Stage only reviewed paths, commit to `deep/<ISSUE_KEY>`, save `summary.md`, `qa.json`, `review.json`, `checks.json`, `manifest.json`; optionally push the same feature branch. **Done:** a human can view diff from pinned base and rebase/merge manually.

- [ ] **M0.10 | autos CLI and OpenAPI docs.** Expose the planned executable as `autos`, with `autos init`, `autos doctor`, `autos providers test --all`, `autos run <ISSUE_KEY> --dry-run`, `autos run <ISSUE_KEY>` and `autos docs validate`. Commit `docs/openapi.yaml` (OpenAPI 3.1) with documented local controller endpoints, typed schemas, errors, authentication, response examples and contract tests. **Done:** OpenAPI lints, documented operations match controller routes, and a local API reference preview renders. This MUST be part of the first prototype, not a commercialization afterthought.

## MVP hardening (still doable without on-prem host)

- [ ] **M1.1 | Historical-fix discovery.** Optional per-ticket search: linked/resolved Jira bugs, text/keyword search, related Bitbucket PRs/commits and diffs. Cite provenance in `precedents.md`; no match is an acceptable result. Start without embeddings.
- [ ] **M1.2 | AGENTS.md loading.** Load root and relevant nested `AGENTS.md` instructions and pass an explicit effective-rules bundle to all three CLIs. Preserve native `CLAUDE.md` / Cursor rules when present; document precedence and conflicts. Test that code changes remain within allowed paths.
- [ ] **M1.3 | Workflow durability.** SQLite persistent volume; dedupe by `(issue_key, repo, base_sha)`; explicit `QUEUED > RESOLVED > IMPLEMENTING > QA > REVIEW > REVISING > READY_FOR_HUMAN / BLOCKED`; resume vs new-branch behavior; cancellation.
- [ ] **M1.4 | Repo policies.** Configurable Maven JDK versions, build/test commands, JavaScript test commands, permitted paths and prohibited changes. Default to safe rules for Struts, Spring, Hibernate, JSP/FTL and JavaScript.
- [ ] **M1.5 | Artifact trust.** Structured test output, exit codes, timeouts and final diff checks. A model statement of success is never accepted as proof of a successful build/test.
- [ ] **M1.6 | Secret safety.** Controller-owned Jira/Confluence tokens; Git credential isolated from agent shell; CLI authentication mounted only to the relevant provider subprocess; no secret values in logs, prompts or repo files.
- [ ] **M1.7 | Negative testing.** Test unknown Jira project; missing dev branch; unavailable Confluence mapping; existing `deep/KEY` branch; failed tests; rate limit; lost subprocess; prompt-injection ticket; disallowed path; accidental Jira/Confluence write and unwanted git push.
- [ ] **M1.8 | End-to-end smoke test.** Use a synthetic Jira bug and a seeded Java/Struts/JS fixture repository, then run a controlled real Jira issue with dry-run mode before writes are enabled.
- [ ] **M1.9 | Basic installer.** `autos init` creates a validated configuration, `autos doctor` checks providers/credentials/repo mapping, `autos run WTS-1234 --dry-run` performs read-only planning, and `autos run WTS-1234` executes a job. `autos docs preview` serves the local OpenAPI reference. Commands are **to build**, not existing commands.

## OpenAPI documentation rules (required for MVP)

- [ ] Maintain a versioned OpenAPI 3.1 file at `docs/openapi.yaml`; document local-only `GET /health`, `GET /v1/providers`, `GET /v1/projects`, `GET /v1/queue`, `POST /v1/jobs`, `GET /v1/jobs/{jobId}`, `GET /v1/jobs/{jobId}/artifacts`, `POST /v1/jobs/{jobId}/cancel`.
- [ ] Treat route schemas as source of truth and export OpenAPI with `@fastify/swagger` (or use spec-first with CI drift checks). Choose one source of truth; do not let implementation and spec diverge.
- [ ] Include auth, validation, query/path/body schemas, examples, stable operation IDs, error format, API version, sensitive-field redaction and request IDs. `docs/openapi.yaml` describes the PLANNED API until implemented.
- [ ] Add `autos docs validate` and `autos docs preview` (local API reference), then a CI spec/contract check. Keep the HTTP listener bound to `127.0.0.1` / VPN; public hosting is future scope.
- [ ] Maintain `README.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/security.md`, `docs/api-publishing.md`, examples and CHANGELOG. Before public publication, scrub internal URLs, names, Jira keys and any confidential code/data.

## Minimal configuration contract

- `jira.site_url`, `jira.saved_filter_id`, `jira.read_only: true`
- `confluence.branch_map_page_id`, `confluence.read_only: true`
- `bitbucket.allowed_repositories`, `bitbucket.push_feature_branch: true|false`, `bitbucket.open_pr: false`
- `git.branch_template: deep/{issueKey}`; `git.no_rebase: true`; `git.no_force_push: true`
- `agents.swe`, `agents.qa`, `agents.reviewer` each choose `claude|codex|cursor`; all three adapters installed and smoke-tested
- `jobs.similar_tickets.enabled`, `jobs.max_repair_rounds: 2`, `jobs.max_parallel: 1`
- `security.allow_jira_write: false`, `security.allow_confluence_write: false`, `security.allow_merge: false`

## Acceptance criteria (first live Jira bug)

1. The ticket is selected through your saved filter without changing any Jira issue.
2. The Confluence page determines the correct repository and **development** base branch; sandbox branch is recorded but not used automatically.
3. `git merge-base`/pinned base commit prove `deep/WTS-1234` started from current `origin/wakanda` (or UWE from `origin/h1_phase2_dev`).
4. SWE loads `AGENTS.md`; optional historical matches show evidence (ticket + commit/PR diff) or explicitly show none found.
5. Deterministic build/test checks run and QA/reviewer get independent context.
6. SWE repairs reported issues within a capped number of rounds; failing jobs remain BLOCKED, not READY.
7. Exactly the intended files are committed in a feature branch; optional push never targets a protected base branch.
8. A human receives the branch name, base SHA, diff, test results, review findings, and local documentation; no PR is created and no rebase/merge is performed.
9. All three CLI adapters and Jira/Confluence/Bitbucket integrations have passing smoke/contract tests.
10. The `autos` executable is usable, `autos docs validate` passes, and the local controller API is documented with versioned OpenAPI 3.1 schemas and examples.

## Defer to future upgrades

- [ ] Autonomous Confluence *draft* creation and eventual approved publishing workflow.
- [ ] Bitbucket PR creation, notifications, CI pipelines and reviewer assignment.
- [ ] Model API billing (OpenAI/Anthropic), OpenRouter, Ollama, automatic failover, usage analytics and budget controls.
- [ ] Embedding-based semantic historical-ticket search and reusable fix-indexing.
- [ ] Dashboard, multiple users, role-based approval, team queues and priority scheduling.
- [ ] Multiple concurrent workers, Postgres/durable queue and remote/container scheduling.
- [ ] More extensive integration/browser test environments, automated dependency caching, vulnerability scanning and observability.
- [ ] Public API documentation hosting, commercial installer, multi-tenant security model, packaging/licensing and external distribution review.

## Server handoff after code works locally

- [ ] Provision 8 vCPU / 32 GB RAM / 500 GB encrypted SSD; Ubuntu LTS; Docker + Compose; outbound to Atlassian, provider CLIs and approved build repositories; VPN-only admin access.
- [ ] Run `autos doctor`; authenticate approved provider CLIs securely; supply scoped Atlassian credentials and read-only Confluence mapping page ID.
- [ ] Run a real bug in `dry-run`, then execute on a low-risk repository change; verify isolated workspace, manual handoff, restart recovery and no-write invariants.

**Reference documentation:** https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filters/ ; https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/ ; https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page ; https://developers.openai.com/codex/non-interactive ; https://cursor.com/docs/cli/overview ; https://code.claude.com/docs/en/headless

**OpenAPI reference:** https://spec.openapis.org/oas/v3.1 ; Fastify generation: https://github.com/fastify/fastify-swagger
