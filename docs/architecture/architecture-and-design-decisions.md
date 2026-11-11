# Autos: architecture and design decisions

This document explains how Autos is built, which tools it uses, and why each major decision was made over the alternatives. It is written so the design can be explained in depth, for example in a system-design or project deep-dive interview.

Status, stated plainly: every component below is implemented and covered by automated tests that use fake services, fake processes and disposable local Git repositories. A local pilot on macOS has run real tickets end to end with real coding CLIs. The Teams bot lives on a separate branch, and the knowledge gateway (section 11) and live progress (section 10) have not yet been exercised with real containers.

## 1. What Autos does

Autos takes bug tickets from a Jira saved filter and tries to fix each one without a human in the loop until review:

1. Read the ticket and work out which repository and branch it belongs to (a Confluence "branch map" page).
2. Create a feature branch `deep/<TICKET>` in an isolated workspace.
3. A **SWE agent** writes the fix. Deterministic **checks** (the repository's build and tests) run. A fresh **QA agent** and a fresh **reviewer agent** judge the result. Up to two repair rounds follow.
4. If checks, QA and review all pass on the same final code, commit it and (optionally) push the feature branch. The ticket becomes `READY_FOR_HUMAN`. Otherwise it becomes `BLOCKED` with a reason.

Autos never merges, never opens a pull request, never deploys, and never writes to Jira or Confluence. A human reviews every result.

The agents are existing coding CLIs (Claude Code, OpenAI Codex, Cursor) run in headless mode. Autos is the system around them: orchestration, isolation, evidence, recovery and operator tooling.

## 2. System overview

```
                 operator
        ┌───────────┼────────────┐
     autos CLI   Teams cards   HTTP API (loopback, bearer token)
        └───────────┼────────────┘
              ┌─────▼──────────────────────────────┐
              │ Controller (Node.js, Fastify)      │   reads Jira + Confluence (GET only)
              │  • workflow engine + job queue     │──────────────► Atlassian Cloud
              │  • SQLite: jobs, events, leases    │
              │  • artifact store (evidence files) │
              │  • knowledge gateway               │◄─── agent tool calls (per-run token)
              └───┬───────────────────┬────────────┘
                  │ trusted Git       │ HTTP over a unix socket
                  ▼                   ▼
          Bitbucket (ssh)     Runner supervisor  ── the only process that talks to Docker
                                      │ docker run (one container per role run)
                     ┌────────────────┼─────────────────┐
                  SWE container   QA container    reviewer container
                  (source rw)     (source ro)     (source ro)
                  claude / codex / cursor CLI, no Git or Atlassian credentials
```

Three trust zones:

| Zone | What runs there | What it may touch |
| --- | --- | --- |
| **Trusted host code** | Controller, workflow, Git runner, supervisor, knowledge gateway | Atlassian token, Bitbucket ssh key, Docker, SQLite, artifacts |
| **Agent containers** | One coding CLI per role run | The ticket workspace (read-write for SWE only), its own model-provider login, outbound internet |
| **Untrusted input** | Ticket text, repository content, Confluence pages, everything an agent says | Nothing: it is data |

The central rule is that **permissions are enforced by trusted code and the container boundary, never by the prompt**. Prompts explain the rules to the agent; they are not what stops it.

## 3. Technology choices

| Tool | Used for | Why this over the alternatives |
| --- | --- | --- |
| **TypeScript (strict), Node.js 22** | Everything | One language for CLI, API, orchestration and container entrypoints. Strict mode with `exactOptionalPropertyTypes` catches the "undefined vs absent" bugs that matter when every record is also a persisted contract. Python was the alternative; the coding CLIs and their SDKs are Node-first, and sharing types between API, CLI and workflow mattered more than data-science libraries. |
| **npm workspaces monorepo** | `packages/*`, `apps/*` | One lockfile, cross-package refactors in one commit, TypeScript project references for incremental builds. pnpm/Turborepo would be faster on a large repo; at eight packages npm is enough and needs nothing extra installed. |
| **Zod 4** | Every trust boundary: config file, HTTP bodies, upstream API responses, agent output, container results | One definition gives both the runtime validator and the static type, so the two cannot drift. Agent output is parsed, never trusted: a malformed QA verdict is a failed gate, not a crash and not a pass. JSON Schema + ajv would also work but needs separate type generation. |
| **SQLite (`node:sqlite`)** | Jobs, events, leases, notes, tier pins | The workload is one controller process and low write volume, and jobs need transactional claims. SQLite gives ACID transactions with no server to operate, and the built-in module means no native dependency to compile. Postgres would be right for several controller instances; that is not this system's shape. |
| **Fastify + generated OpenAPI 3.1** | Operator HTTP API | Route schemas are the single source: they validate requests and generate `docs/openapi.yaml`. A test fails if the committed spec differs from the generated one, so documentation cannot go stale. Express has no schema-first story. |
| **Docker** | Agent and check isolation | See section 5. |
| **Server-Sent Events** | Live event stream (`autos watch`, Teams relay, bot) | One-way server-to-client stream over plain HTTP with built-in resume (`Last-Event-ID`). WebSockets add a bidirectional protocol nobody needs here. |
| **`node:test` + `tsx`** | Tests | No test-framework dependency; tests run TypeScript directly. About 600 tests run in well under a minute, which keeps the edit-test loop short for both humans and AI workers. |
| **MCP (Model Context Protocol)** | Giving agents Jira/Confluence read tools | The one tool interface all three coding CLIs support. See section 11. |
| **Microsoft Teams (Workflows webhook, Adaptive Cards, Entra ID)** | Notifications | Where the team already works. See section 12. |

## 4. Module layout and why it is split this way

| Package | Responsibility |
| --- | --- |
| `packages/contracts` | Zod schemas, types, port interfaces, state machine, config. No I/O. |
| `packages/atlassian` | Read-only Jira/Confluence/Bitbucket REST client |
| `packages/git-runner` | Trusted Git: clone, branch, inspect candidate, commit, push |
| `packages/cli-adapters` | Turns a role request into a CLI invocation (Claude, Codex, Cursor) and parses the result |
| `packages/runner` | Docker runner and supervisor: container arguments, mounts, limits, auth profiles |
| `packages/workflow` | The job engine: queue, leases, role orchestration, evidence, recovery |
| `apps/controller` | HTTP API, wiring of real implementations, knowledge gateway |
| `apps/cli` | `autos` command, Teams relay |

**Ports and adapters (hexagonal architecture).** The workflow depends only on interfaces from `contracts` (`AtlassianReadPort`, `GitRunnerPort`, `RunnerPort`, `JobStorePort`, …). Real implementations are wired in exactly one file (`apps/controller/src/runtime.ts`).

Why: the workflow is the part with the most logic and the most ways to go wrong, and it must be testable without Jira, Docker, Git remotes or paid model calls. With ports, the entire engine runs in tests against fakes in milliseconds. The alternative, calling Docker and Jira directly from the engine, would have made every test an integration test.

A second benefit turned out to matter as much: clear file ownership per package let several AI coding workers build different packages in parallel without merge conflicts (section 14).

## 5. Isolation: how agents are contained

Each role run is one `docker run` with:

- `--read-only` root filesystem, `--cap-drop ALL`, `no-new-privileges`, a non-root user, memory/CPU/PID limits;
- the workspace mounted read-write for SWE and **read-only for QA and reviewer**;
- `/workspace/.git` mounted **read-only** for everyone, so no agent can commit, rewrite history or change Git config;
- a `tmpfs` home directory, so nothing persists between runs and no configuration leaks in from the host;
- only that provider's login (an env file or a staged Codex auth directory), never the Atlassian token, the ssh key or the Docker socket.

**Why containers instead of the CLIs' own sandboxes or permission prompts?** Each CLI has a different permission model, and they change between versions. A container is one boundary that holds regardless of which CLI runs or how it is configured. The CLI-level allow-lists are still set (defence in depth), but nothing depends on them.

**Why a separate supervisor process?** The controller parses untrusted ticket text and serves an HTTP API. If it could call Docker directly, a bug in it would be a bug with Docker (effectively root) access. The supervisor is a small process with a narrow API (run a role, run checks, stop a job) on a unix socket. It re-validates every request, translates paths, and is the only thing that can start containers. This is privilege separation: the component with the most exposure has the least power.

Alternatives considered: a VM per job (stronger isolation, far slower and heavier for a single-host tool); gVisor/Firecracker (worth it for hostile multi-tenant code, more than this threat model needs); no isolation (unacceptable: an agent with write access to `.git` and the ssh key could push anything).

**Known limit, stated honestly:** agent containers have outbound internet, because the CLIs must reach their model APIs. So a prompt-injected agent could send out what it can read. The mitigation is to limit what it can read (no credentials, one workspace, allow-listed knowledge) and to never let agent output decide anything on its own.

## 6. Trusted Git

Only host code in `git-runner` runs Git commands that change anything. The flow:

1. Fetch the mapped development branch and **pin its SHA**. All later work is relative to that SHA, so a moving branch cannot change what was reviewed.
2. Create `deep/<KEY>` in a fresh workspace. An existing remote feature branch is refused rather than overwritten.
3. After the agent finishes, **inspect the candidate**: compute the diff and a digest of exactly what changed, and apply path policy (allowed paths, forbidden files).
4. Commit only when the digest being committed equals the digest that passed checks, QA and review.
5. Push is off by default, create-only for a first attempt, fast-forward-only afterwards. No force-push, no rebase, no merge.

Why agents do not commit: a commit is the hand-off artefact. If the agent made it, the system could not prove that the committed content is the content that was tested. Having trusted code compute a digest and commit by digest closes that gap.

All processes are started with **argument arrays, never shell strings**, so ticket text or a branch name can never be interpreted as shell syntax.

## 7. The workflow engine

### State machine

`QUEUED → INVESTIGATING → IMPLEMENTING → QA → REVIEW → READY_FOR_HUMAN`, with `REVISING` for repair rounds, `PAUSED` for provider rate limits, `PLANNED` for dry runs, and `BLOCKED` / `CANCELLED` as terminal states. Transitions are a table in `contracts`; an illegal transition throws.

Why an explicit state machine rather than a workflow framework (Temporal, Step Functions) or free-form async code? The states are few, the rules are strict, and the system runs on one host. A table of legal transitions is easy to test exhaustively and to reason about during recovery. Temporal would add a server and a programming model for durability that SQLite already provides at this scale.

### Durable queue with leases

A job is claimed in a SQLite transaction and holds a **lease** renewed by a heartbeat. If the controller dies, the lease expires and the job is recovered on restart: its workspace, pinned base and recorded evidence are re-validated before anything continues. Terminal history is immutable; a retry is a **new attempt** linked to the old one, never an edit of it.

Why leases instead of "mark as running": a crashed process cannot clean up after itself. A lease turns "is it still running?" into a question the database can answer.

### The finalization gate

`READY_FOR_HUMAN` requires all of: deterministic checks passed, QA passed, review passed, **and all three refer to the same candidate digest**. `NOT_RUN`, stale evidence (a PASS for older code), malformed output or a timeout all block.

This is the most important design rule in the project: **an agent's narrative is never evidence.** "I ran the tests and they pass" from the SWE means nothing; the checks are run by trusted code in a network-less container, and their exit codes are the evidence. QA and review are structured verdicts from fresh sessions that did not write the code.

### Fresh sessions and role separation

SWE, QA and reviewer are separate invocations with separate prompts and no shared conversation. QA and reviewer cannot edit source (enforced by the read-only mount).

Why: a model reviewing its own conversation tends to agree with itself. Independent sessions, ideally on a different provider, give a real second opinion. It is the same reasoning as code review by someone who did not write the change.

### Repair rounds, fallbacks, tiers, pauses

- **Repair rounds (max 2):** QA/review findings go back to the SWE; checks, QA and review all run again on the new candidate. A cap prevents endless loops and unbounded cost.
- **Provider fallback chain:** each role has a primary provider and up to two fallbacks. Only provider-side failures (unavailable, rate-limited, tool crash) trigger a fallback; a wrong answer does not.
- **Model tiers:** named size classes (small/medium/large). A role starts at a tier (optionally chosen by a cheap triage call) and **escalates** to a larger model when it fails validation. Operators can pin a tier per ticket. Why: most tickets do not need the most expensive model, and the system can find out by trying cheap first.
- **Rate-limit pause:** if every provider in a chain is rate-limited, the job moves to `PAUSED`, releases its slot, keeps its workspace, and resumes when the limit resets. Without this, a usage limit would turn into a wave of BLOCKED tickets.
- **Blocked attempts keep their work:** optionally, a blocked attempt's code is committed as explicitly unreviewed work and pushed to `deep/<KEY>` so a human can look at it, and a retry continues from it instead of starting over.

## 8. Evidence and auditability

Every attempt writes a versioned evidence packet under `artifacts/<issue>/<job>/`: the ticket snapshot, the branch-map version, the pinned base, check results with exit codes, QA and review verdicts, a summary, and a manifest with hashes. Provider transcripts are private artefacts, never returned by the API.

Events (`job_started`, `role_finished`, `tier_escalated`, …) are appended to SQLite and are the single history that `status`, `watch`, Teams and recovery all read. Events carry sanitized metadata only.

Why so much evidence: the output of the system is a claim ("this fix is ready for review"). The evidence packet is what lets a human check that claim quickly, and what lets the builder debug a wrong outcome after the fact.

## 9. Secrets and error hygiene

- Secrets come from environment variables named in config (`*_env` keys); config files never contain secrets.
- Errors are a typed `AutosError` with a code from a fixed list. Messages are authored by Autos. **Raw upstream response bodies, tokens and credential-bearing URLs never appear in errors or logs.** Tests assert this.
- The API returns a generic conflict message except for an explicit allow-list of safe, useful ones, because error text is a classic leak path.
- Transcripts are redacted against the provider's own credentials before being stored.

## 10. Live progress

While an agent runs, operators see what it is doing: `swe/codex: ran rg -n "assocType"`, `edited src/…/file.js`, `3 files changed (+111 −36)`.

How: all three CLIs can stream JSON events. The worker entrypoint extracts **only tool calls** (the command's program name plus at most two arguments, file paths), scrubs them, throttles them, and writes them to stderr. The supervisor forwards them as NDJSON over the existing socket; the workflow turns them into throttled `role_progress` events. A separate "files changed" counter comes from trusted Git on the host.

Design decisions worth explaining:

- **Actions, not narrative.** What the agent *says* is untrusted and may contain anything; what it *does* (a tool name and a target) can be reduced to a safe, bounded label.
- **stderr for progress, stdout for the result.** The result line on stdout is a contract; putting progress on a different stream meant no change to result parsing.
- **Backward-compatible streaming.** The supervisor streams NDJSON only when the client asks for it (`accept` header), so an old controller with a new supervisor (or the reverse) keeps working.
- **Best effort by rule.** A broken stream, a bad line or a throwing callback can never change a role's outcome. Progress events are excluded from state decisions and dataset exports.
- **Two-stage throttling** (2 s in the container, 5 s in the workflow, capped per run) bounds event volume at the source and at the store.

## 11. Knowledge gateway: read-only Jira and Confluence for agents

**Problem.** Agents only saw the ticket's summary, description and acceptance criteria. Real tickets have comments, attachments and links, and the fastest route to a fix is often an earlier, similar bug or a knowledge-base page.

**Design.** A gateway inside the controller process holds the Atlassian token and exposes seven read-only tools (get issue, comments, attachment; search issues; search pages, get page, list children). Inside each agent container a small stdio **MCP shim** with no credentials lists those tools to the CLI and forwards calls over HTTP with a **per-run token**. The gateway validates input, enforces an **allow-list** of Jira projects, Confluence spaces and page trees from `config.yaml`, applies **budgets**, calls Atlassian with a GET-only client, and writes an **audit record** per call.

| Decision | Chosen | Alternatives and why not |
| --- | --- | --- |
| Who talks to Atlassian | Trusted gateway on the host | *Atlassian's hosted MCP server in the container*: includes write tools, needs the user's OAuth login inside a container that reads untrusted text, has no per-installation allow-list, budget or audit. *API token in the container*: same credential exposure. |
| How read-only is guaranteed | No write tool exists; the client only issues GET and refuses redirects | *CLI-side tool allow-lists*: three different mechanisms that change between versions; a configuration mistake becomes a write. "Cannot" is stronger than "is told not to". |
| Transport to the agent | stdio MCP shim → HTTP to the gateway | *Gateway speaks MCP over HTTP*: remote-MCP support differs across the three CLIs; stdio works everywhere, and the gateway protocol stays a plain JSON POST that is trivial to test. |
| Authorisation | Random per-run bearer token, bound to job, ticket and role, revoked when the role ends | *One shared token*: a leaked token would be valid forever and unattributable. *mTLS*: operational weight with no gain on a single host. This is the capability pattern: the token is the permission, scoped and short-lived. |
| Scope | Allow-list of projects, spaces and page trees; queries composed by trusted code | *Let agents send raw JQL/CQL*: an injected query could reach any space the token can see. Composing the query server-side means the restriction cannot be dropped. |
| Search | Jira and Confluence's own text search | *Embeddings / vector store*: better recall, but adds an index to build, keep fresh and secure. Start with what exists; measure before adding infrastructure. |
| Ticket context vs exploration | Tools for both | *Pre-fetch everything into the prompt*: deterministic, but nobody can pre-fetch "the similar bug from another project". |

**Risks accepted and stated:** content read by agents goes to the model providers, so only approved spaces belong on the allow-list; and agents have outbound internet, so the allow-list, budgets and audit bound the exposure rather than eliminate it.

## 12. Operator interfaces

- **`autos` CLI:** run, retry, revise, cancel, notes per ticket, tier pins, status, watch, doctor. The CLI is a thin client of the same HTTP API, so there is one implementation of every operation.
- **HTTP API:** binds loopback only, bearer token, structured audit log lines (who did what; never bodies or tokens).
- **Teams notifications:** a relay process follows the event stream and posts Adaptive Cards to a Teams Workflows webhook: ready, blocked, paused, Autos up/down. Outbound only; nothing is exposed. The tenant blocked anonymous webhooks, so the relay authenticates with an Entra ID app (client-credentials flow), caching the token until shortly before expiry. The relay stores a cursor so a restart neither loses nor repeats notifications.
- **Teams bot (separate branch):** two-way commands from Teams. Incoming activities are verified as Bot Framework JWTs (issuer, audience, signing keys, service URL claim), users are checked against an allow-list of Entra object IDs, and destructive commands need a confirmation click.

Why a separate relay process instead of posting from the controller: a Teams outage or a slow webhook must never slow or fail a job. The event stream decouples them, and the cursor makes delivery resumable.

## 13. Testing strategy

- **Fakes at every port.** Fake Atlassian (a fetch function), fake runner, fake Git or a disposable local repository, fake provider CLIs (small scripts that print realistic stream output). No test calls a real model, touches a company repository or needs credentials.
- **Property-style assertions on safety rules:** no token in any error, only GET requests, illegal transitions rejected, stale evidence blocks.
- **Contract tests:** the committed OpenAPI file must equal the generated one; every event field must be exposed by the API.
- **Opt-in real-Docker tests** verify the container boundary itself (read-only source for QA, read-only `.git`, no Docker socket, no credential env vars).
- **`autos doctor`** checks a real installation: binaries, images, auth profiles, toolchains, Atlassian access.

Why fakes over mocks-by-library: a fake is a small working implementation of the port, so tests exercise real control flow and stay readable. And paid, non-deterministic model calls make poor regression tests.

## 14. How it was built: orchestrated AI workers

Autos itself was built by a primary AI agent orchestrating parallel worker agents, which is relevant because the same ideas appear in the product:

- **Contracts first.** The primary agent writes the shared types and port interfaces, then hands each worker one package with a written brief. This is what makes parallel work safe.
- **Strict file ownership.** Each worker edits only its files; shared-contract changes go through the primary agent.
- **Workers do not commit.** The primary agent reviews every diff, runs the full check, fixes integration problems, and commits. In practice review found real bugs each round (for example a Git lock race between a progress counter and the commit step, and a JWT claim name that differed from Microsoft's).
- **Model choice by difficulty.** Simpler, well-specified chunks go to smaller models; security-critical and cross-cutting parts stay with the primary agent.

## 15. Trade-offs and what I would do next

| Trade-off made | Cost | When to revisit |
| --- | --- | --- |
| One active job at a time | Throughput | When ticket volume justifies it; the lease model already supports more workers. |
| SQLite, single host | No horizontal scaling | Multiple controllers or a shared deployment → Postgres. |
| Agents have outbound internet | Exfiltration risk bounded, not removed | An egress proxy that allows only the model-provider hosts. |
| Text search for similar bugs | Recall | If agents often miss relevant precedents → embeddings. |
| Classic Atlassian API token | Token can do more than Autos uses | Support scoped tokens through the Atlassian API gateway. |
| Cursor flags unverified | One provider less trustworthy | When a Cursor seat is available for `providers test`. |

## 16. Questions this design should let you answer

- *How do you stop an AI agent from doing something destructive?* Sections 5 and 6: container boundary, read-only mounts, no credentials, trusted Git, commit-by-digest.
- *How do you know the fix works?* Section 7: deterministic checks plus independent QA and review tied to one candidate digest; narrative is never evidence.
- *What happens when the process crashes mid-job?* Section 7: leases, recovery with re-validation, immutable attempts.
- *How do you handle prompt injection?* Sections 2, 5, 11: treat all content as data, give agents nothing worth stealing, enforce scope server-side, never let agent output decide.
- *Why MCP, and why your own server?* Section 11.
- *How do you control cost?* Section 7: tiers with escalation, repair cap, budgets, rate-limit pause.
- *How did you test something that depends on LLMs?* Section 13.
