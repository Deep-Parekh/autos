# Autos CLI

The CLI and local API use the same workflow service. Build with `npm run build`, then run `node apps/cli/bin/autos.mjs --help` from the repository. Unless `--config PATH` is given, Autos reads `config/config.yaml`. Set `--json` to print machine-readable results where supported.

## Commands

```text
autos init [--config PATH]
autos doctor [--deep] [--config PATH]
autos providers [--json] [--config PATH]
autos providers test --all [--config PATH]
autos run ISSUE-123 [--dry-run] [--note TEXT]... [--config PATH]
autos revise JOB_ID|ISSUE-123 --note TEXT [--note-file PATH] [--roles swe,qa,reviewer] [--tier TIER[:EFFORT]] [--effort LEVEL] [--wait] [--url URL] [--config PATH]
autos close ISSUE-123 --merged|--abandoned [--note TEXT] [--dry-run] [--yes] [--url URL] [--json] [--config PATH]
autos show ISSUE-123 [--url URL] [--json] [--config PATH]
autos note ISSUE-123 [--swe|--qa|--reviewer|--all|--note TEXT]... [--hold] [--tier TIER[:EFFORT] [--effort LEVEL]] [--url URL] [--json] [--config PATH]
autos notes [ISSUE-123] [--url URL] [--json] [--config PATH]
autos tier ISSUE-123 TIER[:EFFORT] [--effort LEVEL] [--role swe|qa|reviewer] [--url URL] [--json] [--config PATH]
autos tier ISSUE-123 [--clear [--role swe|qa|reviewer]] [--url URL] [--json] [--config PATH]
autos workspaces [--sizes] [--url URL] [--json] [--config PATH]
autos workspaces prune [--dry-run] [--older-than HOURS] [--sizes] [--url URL] [--json] [--config PATH]
autos retry JOB_ID [--config PATH]
autos retry --all-blocked [--code CODE] [--json] [--config PATH]
autos jobs show JOB_ID [--config PATH]
autos jobs cancel JOB_ID [--config PATH]
autos queue list [--limit 1..100] [--config PATH]
autos controller start [--config PATH]
autos index status [--url URL] [--json] [--config PATH]
autos index sync [--full] [--reconcile] [--url URL] [--json] [--config PATH]
autos index rebuild [--yes] [--url URL] [--json] [--config PATH]
autos index purge --project KEY [--yes] [--url URL] [--json] [--config PATH]
autos lineage show [--url URL] [--json] [--config PATH]
autos precedents search (--issue KEY | --text "...") [--limit 1..20] [--include-unresolved] [--no-judge] [--explain] [--url URL] [--json] [--config PATH]
autos precedents show KEY [--url URL] [--config PATH]
autos confluence draft JOB_ID|ISSUE-KEY [--url URL] [--json] [--config PATH]
autos status [--url URL] [--json] [--config PATH]
autos watch [--job JOB_ID] [--quiet-progress] [--url URL] [--json] [--config PATH]
autos teams relay [--from-start] [--url URL] [--config PATH]
autos teams test [--config PATH]
autos events [--job JOB_ID] [--after N] [--limit 1..500] [--url URL] [--json] [--config PATH]
autos export dataset [--out FILE] [--since ISO] [--issue KEY] [--outcome LIST] [--no-prompts] [--no-transcripts] [--config PATH]
autos docs validate [--config PATH]
autos docs preview [--config PATH]
```

`init` creates a private local copy of `config/config.example.yaml` at `config/config.yaml` by default and refuses to replace an existing file. The example contains environment-variable names only. Set the referenced values in the environment or a protected secret manager; do not put credentials in the YAML file.

`doctor` validates the config, checks whether referenced environment variables are present, and checks provider executable presence on `PATH` for every provider that appears in any role chain (primary or fallback). Besides the existing `env_references` and `providers` (now with `roles: [{role, chain_index}]`), it prints `roles` (per role: `chain` with each provider, model, `chain_index` and `binary_present`; a one-line `summary` such as `swe: claude → codex → cursor(auto)`; `available`) and `warnings`. Doctor exits non-zero if an environment reference is missing or a role has no present provider at all; a missing fallback binary (or a missing primary with a present fallback) is only a warning. It does not print secret values, invoke providers, or authenticate accounts. `autos providers` lists each provider with where it is used (`roles`, `chain_index` 0 = primary) and `model: auto` for Cursor, without invoking anything. `providers test --all` is an explicit read-only smoke test and may invoke the configured provider CLIs.

`run ISSUE-123` queues one job and waits for its execution outcome (a local run that pauses returns `PAUSED` and exits 1; a running controller resumes it when due). `--dry-run` records a plan and must not launch a coding session or create Git changes. `queue list` shows recent job metadata. `controller start` requires the operator token environment variable (at least 16 characters), binds the configured loopback address (`api.listen_host`, `127.0.0.1` or `::1`; only the container override `AUTOS_CONTAINER_BIND_HOST` may widen it) and runs until SIGINT/SIGTERM. It runs two independent loops, so a long job never stops intake:

- Discovery (only when `jira.auto_poll` is true, the default): `discover()` reads the Jira filter every `jira.poll_seconds` and queues at most `jira.max_new_per_poll` new tickets. After consecutive failures (for example Jira unavailable) the delay doubles per failure up to max(4x the interval, 5 minutes) and resets after a success; failures are logged as `poll_failed` events with an error code only.
- Drain: `drain()` runs queued jobs (up to `jobs.max_parallel`, including jobs submitted through `POST /v1/jobs` and requeued automatic retries). It runs whenever discovery queued work, a job was queued or finished, and at least every `poll_seconds`; failures are logged as `drain_failed` (code only) and retried with the same backoff.

With `jira.auto_poll: false` the controller logs one line, `auto_poll disabled: only submitted jobs run`, never calls Jira on its own, and only drains submitted work. On shutdown the active job is aborted (it ends CANCELLED, not BLOCKED; use `autos retry JOB_ID` to start a new attempt) and the runtime is closed. HTTP job submission returns after queueing; the controller continues execution in the background. Structured request and audit logging is described under "Logging" below.

`run` prints one concise JSON-style object per job: `job_id`, `issue_key`, `state`, `dry_run`, `repository_id`, `base_sha` (the pinned base commit), `repair_round`, `feature_branch`, `commit_sha`, `blocked_code`, `blocked_reason`, and `push_status` (`DISABLED`, `NOT_ATTEMPTED`, `PUSHED`, or `FAILED`, read from the artifact manifest). It exits 0 only for `READY_FOR_HUMAN` or a dry-run `PLANNED`; `BLOCKED`, `CANCELLED`, and any other outcome exit 1. `blocked_reason` is truncated and scrubbed of URLs, filesystem paths, and token-like strings; prompts, transcripts, and source are never printed. `jobs show` and `jobs cancel` call the same workflow service methods as `GET /v1/jobs/{id}` and `POST /v1/jobs/{id}/cancel`. `base_branch` is included when the workflow recorded it.

`retry JOB_ID` creates a new attempt only for a blocked or cancelled job and waits for that attempt's outcome. A `PAUSED` attempt is not retried: it resumes on its own (see "Rate-limit pauses"); cancel it first if you want a fresh attempt.

`retry --all-blocked [--code CODE]` queues a new attempt (via `workflow.retry`) for every blocked job, optionally only those with `blocked_code` CODE (any error code, for example `UPSTREAM` after a Jira outage). A job is skipped when its issue already has a newer attempt, so only the newest blocked attempt per issue is retried. It prints counts (`matched`, `retried`, `skipped (newer attempt exists)`, `failed`; `--json` adds the job id pairs), does not execute anything locally (the running controller drains the new attempts) and exits 1 only when a retry failed. The API equivalent is `POST /v1/jobs/retry-blocked`.

`docs validate` compares the checked-in OpenAPI document with the document generated from route schemas. `docs preview` serves the API reference on loopback at the configured port plus one; stop it with Ctrl-C. The reference and its JavaScript/CSS assets are served locally, with request submission controls disabled. Neither command calls an external service.

An exit code of zero means the command completed successfully; an unsuccessful job outcome, failed provider smoke test, or contract drift returns nonzero. Text output is concise metadata. JSON output contains no prompts, source files, transcripts, or credential-bearing URLs.

## First run with `auto_poll: false`

The config templates start with `jira.auto_poll: false`, so the controller never works through the Jira filter on its own. Recommended first-run flow:

1. `autos doctor --deep` and fix every FAIL (see below), then `autos providers test --all`.
2. `autos run KEY --dry-run` for one ticket: investigates and records a plan, no coding session, no Git changes.
3. `autos run KEY` for the same ticket and review the result (`autos jobs show JOB_ID`, the artifacts and the `deep/KEY` branch).
4. When the result looks right, set `jira.auto_poll: true` in the config and restart the controller. Each poll then admits at most `jira.max_new_per_poll` new tickets, so an existing backlog is worked through gradually. `autos status` shows `Auto poll: ON/OFF` and the last discovery time.

## `autos doctor --deep`

Plain `autos doctor` is local and offline. In Compose/server mode (`AUTOS_CONTAINER_BIND_HOST` is set, or the supervisor socket `data/runner.sock` exists) provider binaries live in the supervisor's worker images, not on the controller's `PATH`, so a missing binary is not an error there: providers report `checked via supervisor: run providers test --all` and `provider_checks` is `supervisor`.

`autos doctor --deep` additionally runs these read-only checks, only when you run it, each reported as PASS, WARN or FAIL with a safe message (counts and error codes only, never tokens, URLs or upstream text):

- `supervisor_socket`: `data/runner.sock` exists and is a socket. `runner_health`: the supervisor answers and Docker is available. `runner_images`: always WARN, because the supervisor health call does not report image presence; `autos providers test --all` is the proof.
- `toolchains`: for each enabled branch-map project in `jira.allowed_projects`, resolves its JDK and Tomcat. The branch map may carry optional `JDK` (for example `21`) and `Tomcat` (for example `11.0.24`) columns; a blank cell falls back to `build_profiles.<id>.jdk|tomcat` of the project's repository. FAIL when a value is invalid, a Tomcat has no JDK, or the supervisor reports the selected toolchain as not installed (install with `scripts/install-toolchains.ts`); WARN when the supervisor does not report toolchains (`AUTOS_TOOLCHAIN_ROOT`) or a project has no JDK (agents get no Java; checks use the checks image JDK). PASS prints a summary such as `WTS: JDK 25 + Tomcat 11.0.24 (installed: JDK 17, 21, 25; Tomcat 9.0.50, 11.0.24)`; no paths are printed. `GET /v1/status` includes the installed `toolchains` list under `runner`.
- `git_credentials`: `AUTOS_GIT_ASKPASS_PATH` exists and is executable and the `bitbucket-token` file next to it is readable (its content is never read or printed). Unset is a WARN when https remotes are configured.
- `jira_filter`: reads the configured saved filter once (GET) and reports how many issues it matches. `confluence_branch_map`: reads the branch map once and reports mapping counts (FAIL when no mapping is enabled).
- `base_branch:WORKSPACE/SLUG:PROJECT`: for each allowed repository and each enabled mapped project, resolves the development branch head with the git runner (read-only ls-remote/fetch) and reports the branch and the first 12 characters of the SHA.
- `disk:data`, `disk:artifacts`, `disk:workspaces`: free space, WARN below 10 GiB.

Exit code is non-zero when any check is FAIL or the base checks fail. Text mode prints one `STATUS name: message` line per check; `--json` adds `deep_checks`.

## Logging

`controller start` writes structured JSON log lines to stderr: one line per request (`request_id`, `method`, route pattern, `status`, `duration_ms`), `auth_rejected` for a rejected token (the presented token is never logged), and `audit` lines for job submit, revise, cancel, retry, issue close, workspace prune, tier pin set/clear, index sync/rebuild/purge and Confluence drafts (ids, counts, resolution, role, tier, effort, project key and page id only) with job id, issue key and the actor label (`X-Autos-Operator`, default `operator`). Headers, bodies, tokens, query strings and operator note text are never logged; neither are precedent search text, search results or draft content and links. The precedent index loop adds `index_tick` and `index_operation` lines with counts, durations and codes. See [api-publishing.md](api-publishing.md).

`autos watch` prints live agent actions from `role_progress` events, for example `19:46:02 CMS2-1495 swe/codex: ran rg -n assocType (12 commands so far)`. Use `--quiet-progress` to hide these frequent action lines while keeping stage and job events. `autos status` adds the latest action and its age under each active job when one has been recorded.

## Provider fallbacks

Each role (`swe`, `qa`, `reviewer`) has a provider chain: the primary plus up to two `fallbacks`. A chain never repeats a provider.

```yaml
agents:
  swe: {provider: claude, fallbacks: [{provider: codex}, {provider: cursor}]}
  qa: {provider: codex, fallbacks: [{provider: claude}]}
```

- Fallback happens only after these failures of the current provider: `AUTH`, `RATE_LIMIT`, `UPSTREAM`, `UNAVAILABLE`, `TIMEOUT`, `INVALID_OUTPUT`, `CONTEXT`. Anything else (cancellation, policy, tool errors, internal errors) stops the chain.
- A QA or reviewer FAIL verdict is a result, not a provider failure: it never falls back.
- SWE: no fallback after the failed provider changed the workspace; the job blocks rather than letting a second provider build on partial edits. Fallback is allowed only when the candidate is unchanged.
- Repair rounds restart at the role's primary provider.
- Cursor is auto-only: it is always `model: auto`, and any other Cursor model is rejected by config validation.
- Evidence: every attempt (provider, chain index, status, error code, elapsed time, whether it fell back) is recorded in `rounds.json` and summarized in `summary.md`. No transcript content is recorded.
- When every provider of a role's chain is limited, the attempt pauses instead of blocking; see "Rate-limit pauses" below.
- Live: `autos watch` prints a line per switch, for example `12:01:03 SAMPLE-123 QA fallback → claude after codex RATE_LIMIT`. `autos events` shows the same persisted `provider_fallback` events.
- Check the setup with `autos doctor` (chains and binary presence) and `autos providers`.

## Rate-limit pauses

Team subscriptions hit session and usage limits. A single limited provider is handled by the fallback chain above (an interrupted SWE hands its partial work to the next provider in the same workspace). When **every** provider of a role's chain fails with a capacity code, the attempt is `PAUSED` instead of `BLOCKED`, and it continues on its own later:

- Pause condition: every provider in the chain failed (after its same-provider retries) with `RATE_LIMIT` or `UPSTREAM`, and at least one with `RATE_LIMIT`. `UPSTREAM` alone (a vendor outage with no limit signal) still blocks, as do `AUTH`, `TIMEOUT`, `CONTEXT`, `INVALID_OUTPUT` and `UNAVAILABLE` (a missing CLI or broken image does not fix itself by waiting). Dry runs never pause.
- What is kept: the same job, workspace, pinned base SHA, feature branch, repair round and role. Nothing is fetched, merged or rebased on pause, on resume or on fallback; newer development-branch commits are never pulled in (resolve them when you merge). Trusted Git seals the workspace at pause time (directory, branch, start commit, remote, Git config and metadata digests) and refuses to resume a workspace that changed (`CONFLICT`). A ticket whose content changed while paused is blocked (`CONFLICT`) rather than resumed.
- Resume time: the earliest limit reset the providers reported in their structured CLI output (never parsed from narrative text; when some provider in the chain reported no reset, the backoff below caps it); otherwise a backoff of `initial_minutes` doubling per consecutive pause up to `max_minutes`. Never sooner than one minute. The controller's drain loop starts due attempts, so a resume can be up to `jira.poll_seconds` late.
- Limit: a pause streak (consecutive pauses without a successful role run in between) ends after `max_total_hours`: the last resume happens at that deadline and, if still limited, the attempt is `BLOCKED` with `RATE_LIMIT` and a clear reason (`autos retry` starts a new attempt).
- On resume the attempt re-validates intake (filter membership, eligibility, mapping), re-adopts the workspace and restarts the paused role at its **primary** provider. An interrupted SWE (initial, policy repair or repair round) continues from the handoff: its stored prompt plus the predecessor checklist, its last actions and the current diff. An interrupted QA or reviewer simply reruns fresh on the same candidate (the candidate's recorded checks are reused when the candidate is unchanged). Finalization is unchanged: checks, QA and review must pass on the same final candidate, and finalization reruns the checks.
- Slots and restarts: a `PAUSED` attempt holds no `jobs.max_parallel` slot, so other tickets run meanwhile, but it is still the issue's active attempt (no second attempt, close is refused). The pause is stored in SQLite and survives controller restarts. If a resumed attempt fails with an infrastructure code before any agent ran, it pauses again instead of starting a new attempt.
- Cancel: `autos jobs cancel JOB_ID` (or `POST /v1/jobs/{id}/cancel`) cancels a paused attempt immediately.
- Queue order: when the drain loop picks work, due `PAUSED` attempts always come before any `QUEUED` job (they already hold a workspace and partial work); age orders jobs within each group.
- Provider limit gate: when an attempt pauses, every provider of the limited role's chain is recorded in SQLite as limited until the attempt's resume time (durable across restarts). While **every provider of the SWE chain** is limited, the drain loop starts no new non-dry-run `QUEUED` ticket: it would only hit the same limit, create a workspace, run baseline checks and pause. Gating on the SWE chain alone is enough because SWE is the first agent role of every ticket (initial attempts, retries and revisions); dry runs start no agent and are never gated. Due `PAUSED` attempts still resume at their `resume_at`; when the gate lifts they go first, then queued tickets. The gate lifts when the earliest SWE-chain limit expires, or earlier when any role run succeeds on a limited provider (that provider's record is cleared). Submissions (`POST /v1/jobs`, discovery, retries) simply queue behind the gate. A local `autos run KEY` without a controller executes immediately and is not gated (explicit operator run). `autos status` prints `Provider limits: codex until …, claude until …; new tickets wait until …`; `GET /v1/status` has `activity.provider_limits` (`providers`, `gate_active`, `gate_until`); `provider_gate_opened` (with `resume_at`) and `provider_gate_closed` events mark changes (`autos watch`: `provider limit gate opened: new tickets wait until …`). After a controller restart an already active gate is announced once more.
- Visibility: `job_paused` (role, code, `resume_at`, pause count) and `job_resumed` events; `autos watch` prints for example `12:01:03 SAMPLE-123 paused: every QA provider limited (RATE_LIMIT) resumes 2026-11-07 13:15Z pause 1 (round 0)`. `autos status` prints one `Paused:` line per paused attempt (`GET /v1/status` → `activity.paused_jobs`). `autos show KEY`, `autos jobs show JOB_ID` and `GET /v1/jobs/{id}` show `state: PAUSED` with `resume_at`, `pause_code`, `paused_role`, `paused_since` and `pause_count`. `summary.md` explains the pause while it lasts.

```yaml
jobs:
  rate_limit_pause: {initial_minutes: 15, max_minutes: 240, max_total_hours: 24}   # defaults
```

### SWE build state and handoff

- Each job's SWE containers share one persistent `/scratch` (mode 0700, `<artifacts>/.scratch/swe-<jobId>` on the supervisor host): every SWE invocation of the job (fallbacks, repair rounds, resumes after a pause) finds the previous build copy and its warm Maven state instead of starting from zero. It is deleted when the job reaches a terminal state (including cancel), when its workspace is pruned, and by the supervisor's startup sweep (a resume after a supervisor restart therefore starts with an empty scratch). QA and reviewer containers never see it: each gets its own empty per-invocation scratch, deleted afterwards, so SWE output cannot influence their builds.
- A continuing SWE (fallback or resume) receives, besides the predecessor's checklist and the current diff, a bounded list of the predecessor's last tool uses (tool name and file path or truncated command), derived by Autos from the private transcript. Tool outputs, assistant text and reasoning are never included; the list is marked as untrusted agent-produced data and neutralized like the rest of the handoff. In repair rounds, failing check excerpts, QA evidence and review findings are added only when the repair prompt does not already contain them (for example after prompt-budget truncation). The whole handoff stays within the SWE prompt's reserved 42 KiB.

## Requesting changes after review

After a job reaches `READY_FOR_HUMAN`, review the `deep/<KEY>` branch and the evidence (`autos jobs show JOB_ID`, `GET /v1/jobs/{id}/artifacts`). If more work is needed, send notes to the running controller:

```text
autos revise JOB_ID --note "Also handle the empty-list case" [--note-file notes.txt] [--roles swe,qa] [--wait]
```

- `revise` is an HTTP client of the running controller (like `status` and `watch`): the base URL comes from the config or `--url`, the token from `api.operator_token_env`. The controller owns execution, so it must be running. It calls `POST /v1/jobs/{jobId}/revisions` and prints the new job (which has `parent_job_id` and `revision`).
- `--note` and `--note-file` may be combined (joined by a blank line); the total must be 1 to 4000 characters, and a note file larger than that is rejected. `--roles` selects which roles receive the note (default `swe`; QA and reviewer also always see SWE notes as acceptance requirements).
- `--wait` follows that job's events until `job_finished` and exits 0 only if the job ends `READY_FOR_HUMAN`; any other outcome, or stopping early, exits non-zero. Without `--wait` the command returns as soon as the revision is queued.
- What happens: the revision continues from the reviewed commit on the same `deep/<KEY>` branch with the same pinned base, then runs the full checks, QA and review again. It creates a new commit on top. If push is enabled, it fast-forwards the existing remote branch only, and refuses if the remote branch changed since the reviewed commit. Nothing is merged, rebased or force-pushed.
- Constraints: only the latest `READY_FOR_HUMAN` attempt of an issue can be revised, and only when no other attempt for it is active (otherwise exit 1 with `CONFLICT`). Notes are trusted operator guidance but cannot override path policy or any other platform rule. Notes are stored as evidence (`operator-notes.json`, listed in the artifact manifest); their text never appears in job output, events, or logs.
- The note author is `operator`, or the label in the optional `X-Autos-Operator` HTTP header on direct API calls. The header is a label, not authentication; the bearer token is the only credential.

`autos run ISSUE-123 --note TEXT` (repeatable, at most 5) attaches operator notes to an initial local attempt in the same way.

`autos revise` also accepts an issue key: `autos revise SAMPLE-123 --note "..."` revises the issue's latest `READY_FOR_HUMAN` attempt through `POST /v1/issues/{issueKey}/revisions` (404 when the issue has none, 409 when it is closed or an attempt is active). Everything else (`--note`, `--note-file`, `--roles`, `--tier`, `--effort`, `--wait`) behaves exactly as for a job id.

Model tier of a revision. With a laddered SWE role (see [model tiers](local-pilot.md#model-tiers-cheapest-model-and-effort-first)), a revision starts SWE at the step that finished the previous attempt, never below it. `--tier TIER` (optionally `--effort LEVEL` or `TIER:LEVEL`, an effort override for the tier's Claude/Codex entries) sets the SWE starting tier for this revision only, with the same rules as a ticket pin (see "Model tier pins"); it wins over a ticket pin but never goes below the role's floor. The controller refuses an unknown tier, an effort a Claude/Codex entry of the tier does not accept, or a tier below the floor with exit 2 and the reason. `--effort` without `--tier` is rejected.

## Ticket notes

A ticket note is operator guidance stored by issue key. You can add it before the issue is in the Jira filter and before Autos has ever seen it; Autos applies it to every attempt of that issue once the issue appears. It is copied into each new attempt (discovered, submitted with `autos run`, retried, or revised) until you remove it or the issue is closed, so a retry or a revision never loses it. Attempts that already started keep the notes they were created with.

```sh
# Three separate notes: two role-specific, one for everybody
autos note XYZ-120 --swe "Change only InvoiceService.java" --qa "Verify the PDF totals" --all "Do not touch the public API"

# Equivalent with --note/--roles
autos note XYZ-120 --roles swe --note "Change only InvoiceService.java" --roles qa --note "Verify the PDF totals"

# Keep Autos away from the ticket until you are ready, with the notes already in place
autos note XYZ-120 --swe "Needs the 2.4 schema first" --hold
autos note XYZ-120 --release
```

Targeting. Every flag below creates one separate note and is repeatable (at most 5 notes per issue); notes are stored in command-line order. `--swe TEXT`, `--qa TEXT`, `--reviewer TEXT` target that role, `--all TEXT` targets all three, `--note TEXT` and `--note-file PATH` (like `revise`) target the roles set by the most recent `--roles swe,qa,reviewer` that comes before them (default `swe`). `--roles` therefore goes before the notes it applies to, and a `--roles` with no note after it is rejected; the shorthands ignore it. QA and the reviewer always see SWE notes as acceptance requirements too. Notes cannot relax path policy or other platform rules. The command prints each stored note id with its roles and a read-only Jira check: `WARN KEY is not in Jira yet — note kept; check the key for typos` when the key is unknown (the note is still stored, since the issue may simply not exist yet), `Jira: KEY found.`, or `Jira: not checked.` when the controller has no Jira read available. Keys outside `jira.allowed_projects` are refused (exit 2), as are notes on a closed issue (exit 1).

Hold and release. `--hold` stops automatic discovery from queueing the issue until `--release`; it can be combined with new notes or used alone, and works for issues Autos has not seen. An explicit `autos run KEY` still works. A held issue also shows as `held` in `autos notes`.

Tier. `--tier TIER[:EFFORT]` (optionally with `--effort LEVEL`) also pins the SWE starting tier, exactly like `autos tier KEY TIER` (see "Model tier pins" below); it can accompany new notes or `--hold`, or be used alone.

Managing. `autos note KEY --list` shows the issue's notes in full, `--remove NOTE_ID` removes one, `--clear` removes all of them, `--release` lifts the hold. `--list`, `--remove`, `--clear` and `--release` cannot be combined with each other or with adding notes (only `--hold` and `--tier` may accompany new notes). All of them need the running controller (`--url` overrides the address).

Seeing everything. `autos notes` prints every issue that has notes, a hold or tier pins:

```text
KEY       NOTES                     HELD  TIER                STATUS           ATTEMPTS    LATEST                     CURRENT NOTES USED
NEW-9     3 (swe:2 qa:1)            yes   swe=med:xhigh       held             0           -                          n/a
XYZ-120   1 (swe:1 qa:1 reviewer:1) no    -                   awaiting review  2 (+1 dry)  READY_FOR_HUMAN 2h05m ago  yes
```

`NOTES` is the note count with how many notes target each role; `TIER` lists the tier pins per role (`-` when none); `STATUS` is one of not seen, held, queued, in progress, planned, awaiting review, blocked, cancelled, merged, abandoned (from the latest non-dry-run attempt); `ATTEMPTS` counts non-dry-run attempts (dry runs in parentheses); `CURRENT NOTES USED` is `yes` when at least one attempt received every current note, `no` when attempts exist but none did (for example the notes were added after the last attempt: run, retry or revise it), and `n/a` when Autos has not seen the issue. `autos notes KEY` shows one issue in detail including the note texts and a `Tier pins` section, and `--json` prints the raw summaries (`tier_pins`). `autos show KEY` has a "Ticket notes" section with the same detail.

Privacy. The note text is evidence: it is stored in the attempt's `operator-notes.json` artifact (marked as a ticket note) and is part of the dataset export (`operator_notes`). It is never put in events, logs, error messages or the audit trail (which records only issue key, note id, roles and the `X-Autos-Operator` actor label). Note text is returned only by the ticket notes endpoints, so treat the API token accordingly. See the ticket notes routes in [api-publishing.md](api-publishing.md).

## Model tier pins

With model tiers and per-role ladders configured (see [model tiers](local-pilot.md#model-tiers-cheapest-model-and-effort-first)), a tier pin chooses the tier a role starts at for one issue key. A tier is a named list of model entries (tried in order on provider-side failures); a ladder is a list of tier names.

```sh
autos tier XYZ-120 med                       # SWE starts at tier med
autos tier XYZ-120 med --effort xhigh        # same tier, every Claude/Codex entry at xhigh
autos tier XYZ-120 med:xhigh                 # shorthand for --effort xhigh
autos tier XYZ-120 lg --role reviewer        # reviewer starts at lg
autos note XYZ-120 --swe "Needs the 2.4 schema" --tier med
autos tier XYZ-120                           # list the pins
autos tier XYZ-120 --clear [--role swe]      # clear one role, or all
```

- A pin is stored by issue key like a ticket note: set it before or after Autos has seen the ticket. It is applied whenever a later attempt is picked up (new, retried or revised), survives controller restarts and stays until cleared. Attempts already picked up keep their step. `--role` defaults to `swe`; there is at most one pin per role.
- Start step, highest priority first: `autos revise … --tier` (that revision only) > ticket pin > the step that finished the previous attempt (revisions and retries start there, never below it) > triage > the first ladder tier. Nothing starts below the role's floor (`min`); a pin below the floor is refused.
- `--effort LEVEL` (or `TIER:LEVEL`; giving both is rejected) overrides the effort of every entry of the tier whose provider accepts one; Cursor entries run without one, and the level must be valid for each Claude and Codex entry. Without it, each entry keeps its configured effort.
- A tier in the role's ladder starts at its position; with an effort override it replaces that ladder step in place, and escalation continues to the next tier. A tier not in the role's ladder is a fixed step with no escalation, and is refused for a role that has a floor. A role configured with plain `provider`/`model` (no ladder) can be pinned to any tier, as a fixed step.
- Output: `Pinned swe of XYZ-120 to med:xhigh (in the ladder; escalation continues to the next tier)`, or `(fixed step: not in the role's ladder, no escalation)`; `--json` prints `{pin, step, in_ladder}`. An unknown tier, an invalid effort, a tier below the floor (or outside the ladder of a role with a floor) or a key outside `jira.allowed_projects` exits 2 with the controller's reason; a closed issue exits 1 (`CONFLICT`).
- `autos notes` (`TIER` column), `autos notes KEY` and `autos show KEY` display the pins. The API is `GET`, `PUT` and `DELETE /v1/issues/{issueKey}/tier` (`DELETE ?role=ROLE` for one role); the audit trail records issue key, role, tier and effort.

## Finishing a ticket and workspace hygiene

Every attempt has an on-disk Git workspace under `storage.workspaces_dir`. After you have reviewed (and, outside Autos, merged or discarded) the `deep/<KEY>` branch, close the issue so its workspaces are removed. These commands are HTTP clients of the running controller (like `revise`, `status` and `watch`).

```text
autos close SAMPLE-123 --merged            # asks "[y/N]" on a terminal after previewing what will be removed
autos close SAMPLE-123 --abandoned --note "superseded by SAMPLE-130" --yes
autos close SAMPLE-123 --merged --dry-run  # preview only, never asks
autos show SAMPLE-123                      # closure + attempts, newest first
autos workspaces --sizes                   # what is on disk and why
autos workspaces prune --dry-run           # what the retention policy would remove now
autos workspaces prune --older-than 24     # apply it now with a 24 hour window for this run
```

- `close` is irreversible. Exactly one of `--merged` or `--abandoned` is required. It records your resolution, removes **all** of the issue's workspaces and keeps the artifacts (evidence). Afterwards the issue accepts no new attempt, revision or retry. Autos does **not** verify that anything was merged: the resolution is an operator assertion, and Jira and Bitbucket are not modified. It is refused (exit 1, `CONFLICT`) while an attempt of the issue is active, or for `--merged` when the issue has no `READY_FOR_HUMAN` (non-dry-run) attempt; running it again with the same resolution only retries workspace removal.
- Confirmation: on a terminal, `close` first runs a dry run, prints what would be removed and asks `[y/N]`. Without a terminal it refuses (exit 2) unless `--yes` (or `--dry-run`) is given. Human output shows the resolution, the latest job, commit and branch, the removed workspace names (first 8 characters) and any removal failures (exit 1; run it again to retry), and reminds you that artifacts are kept and Jira/Bitbucket were not changed. `--note` (1 to 2000 characters) is stored in the evidence only and never returned, logged or sent in events. The API equivalent is `POST /v1/issues/{issueKey}/close` (`{resolution, note?, dry_run?}`); the `X-Autos-Operator` header labels the closer.
- `show ISSUE-123` prints the closure (or "open") and the issue's attempts, newest first; a closed issue's attempts display as `READY_FOR_HUMAN (merged)`. API: `GET /v1/issues/{issueKey}`. `closed_as` also appears in job JSON (`jobs show`, `queue list`, `GET /v1/jobs/{id}`).
- `workspaces [--sizes]` lists directories with a short name, issue, state, age, size and the retention decision (`keep (awaiting_review|active|within_retention)` or `remove (closed|superseded|retention|orphan)`), plus the configured policy. Sizes walk the trees and can be slow, so they are opt-in. Only directory names are shown, never filesystem paths. API: `GET /v1/workspaces?sizes=`.
- `workspaces prune [--dry-run] [--older-than HOURS] [--sizes]` applies the policy immediately and prints what was (or would be) removed, what remains and, with `--sizes`, the space freed. `--older-than` (0 to 2160) overrides `jobs.workspace_retention_hours` for that run. Exit 1 when a removal failed. API: `POST /v1/workspaces/prune`.
- `watch` and `events` render the `issue_closed` and `workspaces_pruned` events, for example `12:05:00 SAMPLE-123 issue closed as merged workspaces removed=2`.

Retention policy summary:

- The latest `READY_FOR_HUMAN` workspace of an open issue is kept until you close the issue (`autos close`), so you can inspect or revise it.
- `BLOCKED`, `CANCELLED`, superseded (for example the parent of a revision) and orphan workspaces are removed after `jobs.workspace_retention_hours` (default 72) automatically, at most hourly, when `jobs.auto_prune_workspaces` is true (the default). `autos workspaces prune` runs the same policy on demand.
- `close` removes the issue's workspaces immediately, regardless of age.
- Artifacts (evidence, manifests, summaries) are never removed automatically or by these commands.

## Dataset export

`autos export dataset` writes one JSON object per line (JSONL), one line per non-dry-run attempt (job), for later evaluation or training. It reads the local SQLite database (read-only, so it is safe while the controller runs) and the artifacts directory named in the config. It needs no controller, API token or network, and never changes anything.

Each record (schema: `datasetRecordSchema` in `@autos/contracts`) contains:

- Attempt metadata: job, issue, revision and parent job, repository, base branch/SHA, feature branch, commit SHA, final state, blocked code, timestamps.
- The human `outcome` and `feedback` (see below) plus the `operator_notes` given to the attempt.
- Parsed evidence (null when absent): the ticket snapshot (`issue`), `rounds`, `checks`, `baseline_checks`, `qa` and `review`; the effective repository instructions, similar-ticket precedents and the final cumulative `final_diff` against the base.
- `calls`: every provider invocation in start order with role, provider, model, chain position, repair round, timing, status, error code and whether it continued a handoff (`call.json`, written for every attempt including failed, timed-out and fallback ones; null for attempts made before it existed), plus the full prompt and transcript text and a `transcript_truncated` flag (the capture cap was hit).
- `timeline`: the sanitized progress events of the job.

Outcomes:

| outcome | meaning |
| --- | --- |
| `merged` / `abandoned` | You closed the issue with `autos close`; applies to the attempt that was latest at close. Other attempts of that issue are classified by the rules below. |
| `revised` | A `READY_FOR_HUMAN` attempt that you answered with `autos revise`; `feedback` holds the operator notes of the revision attempt(s). |
| `awaiting_review` | `READY_FOR_HUMAN` with no revision and not closed yet. The label can change on a later export. |
| `blocked` / `cancelled` | The attempt ended `BLOCKED` or `CANCELLED`. |

Dry runs, `PLANNED` attempts and jobs that are still queued or running are skipped. Missing or malformed artifact files become `null`; the export never fails because of them.

Options: `--out FILE` creates a new file (mode 0600) and refuses to overwrite an existing one (default: stdout, no file); `--since ISO` keeps attempts updated at or after a date or time; `--issue KEY`; `--outcome merged,abandoned,revised,awaiting_review,blocked,cancelled` (comma list); `--no-prompts` and `--no-transcripts` leave the prompt or transcript text out (`transcript_truncated` is then `false`). A summary (records per outcome, provider calls, bytes) goes to stderr, so redirecting stdout is safe. Invalid flags exit with code 2.

Examples:

```sh
# On the Mac (uses the local config and storage)
autos export dataset --out autos-dataset-$(date +%F).jsonl
autos export dataset --outcome merged,revised --no-prompts > feedback.jsonl

# On the server, then copy it to the Mac
docker compose exec -T controller node apps/cli/bin/autos.mjs --config /app/config/config.yaml export dataset > dataset.jsonl
scp server:dataset.jsonl .
```

Privacy: the dataset contains company source code (diffs and prompts), ticket text and full agent transcripts. Secrets are redacted when the transcripts are captured, but treat the file exactly like the artifacts directory: private storage, no sharing, and delete copies you no longer need. Provider terms may restrict training on provider outputs; check them before using transcripts for training.

Artifacts, including the private per-invocation prompt and transcript files that feed the export, are never removed automatically or by any `autos` command, so the dataset keeps accumulating. Plan disk space accordingly and remove old job directories yourself if you must.

## Precedent index and Confluence drafts

These commands exist only when `precedents` is configured (see [semantic-precedents-plan.md](semantic-precedents-plan.md)); without it every command, endpoint and log line behaves as before. Like `status`, they are thin clients of the running controller's API (the index lives in the controller process): base URL from `api.listen_host`/`api.port` or `--url`, bearer token from `api.operator_token_env`. When the controller has no precedent index the API answers 404 and the CLI exits 1 with `Controller: Precedent index is not configured ...`.

Background loop: when `precedents.enabled` and `precedents.index.auto_sync` (the default) are true, `controller start` runs one index tick about 5 seconds after start and then every minute. The index decides what is due (incremental Jira sync every `index.sync_interval_minutes`, mirror scan, reconcile every `index.reconcile_interval_hours`). Ticks are single-flight (a tick never overlaps another tick or a manual sync/rebuild), never block job execution or the poller, survive errors, and stop on shutdown (the running tick is aborted). Each tick logs one `index_tick` line with `outcome`, `duration_ms`, counts (`issues`, `vectors`, `fixes`, `ready`) and error codes only. With `auto_sync: false` the index changes only through `autos index sync`.

- `autos index status` prints readiness, counts (issues, chunks, vectors, fixes, projects), the embedding model, the last sync/full sync/reconcile/mirror scan times, the last error code, the background loop and the running or last manual operation with its per-mode reports (upserted, deleted, embedded, fixes, requests, complete, error).
- `autos index sync [--full] [--reconcile]` starts a sync in the controller and returns at once (HTTP 202); follow it with `autos index status`. `--full` re-reads the whole window; `--reconcile` also removes issues that were deleted, moved or became restricted. It is refused (exit 1, `CONFLICT`) while another index operation runs or when `precedents.enabled` is false.
- `autos index rebuild [--yes]` discards the local index and rebuilds it in the background (search answers `INDEX_NOT_READY` until it finishes; hours on CPU). `autos index purge --project KEY [--yes]` deletes every indexed issue of one Jira project now; add the project to `precedents.index.exclude_projects` to keep it out of later syncs. Both ask for confirmation on a terminal and require `--yes` otherwise (exit 2 without it); they audit counts only.
- `autos lineage show` lists lineage nodes: lineage, Jira project, development branch, fork point and date, attached `_dev`/`_sbx` branches and how they were attached, plus unattached branches and missing configured items.
- `autos precedents search (--issue KEY | --text "...")` runs the retrieval pipeline as the operator: shown fix precedents (kind, key, status, score, judge verdict, signals, fix commit and branch, summary), "Same bug may be open in other projects" (`ALSO_REPORTED`, never given to agents), related fixes (search only) and rejected candidates with the reason. `--no-judge` skips the provider judge (no ticket text leaves the host), `--limit` caps candidates, `--include-unresolved` also considers unresolved tickets, `--explain` adds one JSON line per candidate. The search text is sent in the request body and never logged.
- `autos precedents show KEY` prints the index record of one issue as JSON (summary, error signatures, code references, fixes, presence per node); exit 1 with `NOT_FOUND` when the issue is not indexed.
- `autos confluence draft JOB_ID|ISSUE-KEY` creates the Confluence fix-document draft of a `READY_FOR_HUMAN` attempt (an issue key means its latest one) and prints the page id and the edit link. **The draft is unpublished and visible only to the Atlassian account whose token the controller uses** (on the Mac pilot, your own account). Open the link, review and edit it, and **publish it yourself in Confluence**: Autos never publishes, never updates a page that was published or edited (it creates a new draft instead and says which page it supersedes) and never deletes anything. It needs `confluence.drafts.enabled`; otherwise exit 1 with `Controller: Confluence drafts are not configured ...`.

`autos doctor` adds a `precedents` list when `precedents` is configured (all offline): config summary, index file presence and permissions (`<data_dir>/<index.db_file>`, expected 0600), lineage repositories in `bitbucket.allowed_repositories`, embedding provider/model, and an uncalibrated gate. It adds `confluence_drafts` when `confluence.drafts` is configured. Missing optional pieces are warnings (also listed in `warnings`), never failures. `autos doctor --deep` adds `precedents_index` (status through the runtime's index: readiness, counts, last error) and `precedents_lineage` (node count, missing items, unattached branches), again as warnings when something is missing.

## Operator monitoring over SSH

`status`, `watch`, and `events` are thin HTTP clients of the running controller; they do not build the workflow runtime or touch the database. They read the base URL from `api.listen_host`/`api.port` in the config (or `--url`) and the bearer token from the environment variable named by `api.operator_token_env`. If the controller is not running they exit 1 with "Autos controller is not reachable"; a rejected token exits 1 with `AUTH`.

- `autos status` prints a concise summary: a leading `WARN runner not available (...)` line when the runner is not ready or Docker is unavailable, controller version and uptime, poll loop state (next poll, consecutive failures), runner health (`ready`, `unknown`, or `unreachable`), `Auto poll: ON/OFF` with the last discovery time, a `Slots: in_use/max_parallel (checks in_use/max)` line, one `Active:` line per active job (issue, state, stage, role/provider, repair round, elapsed times), last poll outcome, job counts by state, and the last event id. A `Provider limits:` line shows recorded provider limits and whether new tickets wait. `Paused:` lines list attempts waiting for provider limits to reset (issue, role, code, round, resume time; they hold no slot). `--json` prints the raw `GET /v1/status` body.
- `autos watch [--job JOB_ID]` follows `GET /v1/events/stream` and prints one line per event, for example `12:01:03 SAMPLE-123 role_started swe/claude round 0 stage=implementation` (UTC time; service-level events such as polling show `service`). It reconnects with `Last-Event-ID` after a dropped connection and exits cleanly on Ctrl-C. `--json` prints one JSON event per line.
- `autos events [--job JOB_ID] [--after N] [--limit N]` prints persisted events after a cursor (default 100 per call, up to 500).

- `autos teams relay` posts cards for finished, blocked and paused attempts, and when Autos comes up or goes down, to a Teams channel or chat; `autos teams test` checks the webhook. See [teams.md](teams.md).

Typical use: `ssh host`, then `autos status` or `autos watch`. See [api-publishing.md](api-publishing.md) for the SSH-tunnel alternative with curl. Event text is sanitized: no prompts, transcripts, tokens, URLs, or filesystem paths.

## Concurrency

By default Autos works on one ticket at a time (`jobs.max_parallel: 1`). On a larger host, raise `jobs.max_parallel` (1..8) to run several tickets at once and optionally set `jobs.max_concurrent_checks` to bound how many check suites run at the same time. There is never more than one active job per issue. `autos status` shows the slot usage and every active job, and `autos watch` already prefixes each line with the issue key, so interleaved events from several tickets stay readable. A job that cannot start because every slot is busy stays queued and is started automatically when a slot frees.

## Verification status

Fake-tested only (`tests/interfaces`): command parsing, exit codes, sanitization, `jobs show/cancel`, poll backoff, loopback binding, authenticated HTTP, graceful shutdown, and OpenAPI parity. The precedent index, lineage, search and Confluence draft commands and endpoints and the background index loop are tested with a fake index and a fake draft method only; no Jira, Bitbucket, embedding service, provider or Confluence was called. These tests use fake workflow services; they do not prove autonomous operation.

Not verified here: a real Jira filter or Confluence mapping, Bitbucket access, any real coding provider, or the Docker runner. Docker is not installed on the development machine. The real execution path goes through the Unix-socket `DockerRunnerClient` and a host supervisor that must be running; without it `run`, `providers test --all`, and controller job execution cannot complete real work. `autos doctor` reports `read_only_smoke: NOT_RUN` and does not authenticate. Do not treat this CLI as a working autonomous service against real Jira until the pilot checks in the implementation plan have been run.
