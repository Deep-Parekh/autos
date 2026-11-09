# Local API operation and publishing

The controller API is an operator interface for a trusted local or internal host. The host process binds only to the configured loopback address (`127.0.0.1` or `::1`). Configure a long random operator token through the environment variable named by `api.operator_token_env`.

`GET /health` is unauthenticated and returns only `{ "status": "ok" }`. Every `/v1` route requires `Authorization: Bearer <operator-token>`. Authentication is checked with a constant-time comparison. Do not place tokens in URLs, query parameters, logs, issue fields, or artifacts.

For Compose, start the controller with `node apps/cli/bin/autos.mjs --config /app/config/config.yaml controller start`. The container may set `AUTOS_CONTAINER_BIND_HOST=0.0.0.0` so the application can receive traffic from its network namespace. Publish the port only on the host loopback interface, for example `127.0.0.1:8787:8787`. Do not publish it on `0.0.0.0`, add a public reverse proxy, or make the API reachable from an untrusted job container. Runtime/container setup is documented separately and must preserve these network boundaries.

The OpenAPI 3.1 document in [openapi.yaml](openapi.yaml) is generated from Fastify route schemas. `autos docs validate` checks generated contract parity. `autos docs preview` serves a local Swagger reference and its bundled assets on loopback, with submission controls disabled and no external CDN. The API documents PLANNED dry-run results. `GET /v1/jobs` returns recent job history and `GET /v1/queue` returns the current queue; both support bounded limit and cursor pagination. Job creation is asynchronous: `POST /v1/jobs` validates and queues the request, responds with HTTP 202, then the controller executes it in the background. Cancellation and shutdown propagate abort signals to workflow execution.

Artifact responses contain the schema-versioned manifest and safe metadata only. They do not serve raw source, prompts, transcripts, issue/customer bodies, or arbitrary filesystem paths. Provider diagnostics distinguish executable presence from authentication and read-only smoke-test status.

## Operator monitoring over SSH

The controller API binds to loopback only (`127.0.0.1` by default) and every `/v1` route needs `Authorization: Bearer $AUTOS_OPERATOR_TOKEN`. It is not reachable from the network; to watch Autos from a remote machine, go through SSH.

Routes:

- `GET /v1/status` returns controller version, start time, uptime, poll interval and poll-loop state (`running`, `next_poll_at`, `consecutive_failures`), runner health (`ready`, `unknown`, or `unreachable`, probed with a short timeout), the workflow activity snapshot (`active` = first active job, `active_jobs` = every job holding a slot, `slots` = `max_parallel`, `in_use`, `max_concurrent_checks`, `checks_in_use`, plus polling summary, counts by state, last event id), and server-computed elapsed seconds: a top-level `active_jobs` array repeats each active job with `active_elapsed_s` / `stage_elapsed_s`, and the top-level `active_elapsed_s` / `stage_elapsed_s` describe the first job for compatibility.
- `POST /v1/issues/{issueKey}/close` (`{resolution: MERGED|ABANDONED, note?, dry_run?}`) is irreversible: it removes all of the issue's workspaces and keeps artifacts. Autos does not verify the merge (operator assertion); Jira and Bitbucket are not modified. Returns the closure, the removed workspace entries (names only) and any failures. `POST /v1/issues/{issueKey}/revisions` revises the issue's latest `READY_FOR_HUMAN` attempt (202 job); `GET /v1/issues/{issueKey}` returns `{issue_key, closure, jobs}`; `GET /v1/workspaces?sizes=` lists workspaces with their retention decision and the configured policy; `POST /v1/workspaces/prune` (`{dry_run?, older_than_hours?, sizes?}`) applies the retention policy now. Notes, workspace paths and tokens never appear in responses, events or logs; see Finishing a ticket in [cli.md](cli.md).
- `GET /v1/events?after=&job_id=&limit=` and `GET /v1/jobs/{jobId}/events?after=&limit=` return `{ events, next_after }`, oldest first; pass `next_after` as `after` to continue. `limit` is 1..500 (default 100).
- `GET /v1/events/stream?after=&job_id=` is a Server-Sent Events stream (`text/event-stream`). It replays persisted events after the cursor (or the `Last-Event-ID` header), then sends live events. Each message has `id:` (the event id), `event:` (the event type), and JSON `data:`. A `: heartbeat` comment is sent every 15 seconds. No event is lost or duplicated between replay and live delivery. The stream is closed when the client disconnects or the controller stops.

Two ways to use them:

```text
# 1. On the host
ssh host
autos status
autos watch              # or: autos watch --job JOB_ID

# 2. From your laptop through a tunnel
ssh -L 8787:127.0.0.1:8787 host
curl -sS -H "Authorization: Bearer $AUTOS_OPERATOR_TOKEN" http://127.0.0.1:8787/v1/status
curl -N  -H "Authorization: Bearer $AUTOS_OPERATOR_TOKEN" http://127.0.0.1:8787/v1/events/stream
```

`provider_fallback` events mark a role moving to its next configured provider: `role`, `provider` (the provider now used), `code` (the failure that triggered it, one of the fallback-eligible error codes) and `repair_round`; see Provider fallbacks in [cli.md](cli.md). `GET /v1/providers` lists each provider with `roles: [{role, chain_index}]` (0 = primary) and `model: auto` for `cursor`.

Do not expose the port beyond loopback. Events contain sanitized metadata only (state, stage, role, provider, outcome, error code, elapsed time); never prompts, transcripts, source, tokens, URLs, or paths. Events and activity are produced by the workflow service; `runner: unknown` means the configured runner does not report health.

## Concurrency

Autos processes one ticket at a time by default. To scale on a larger host, set `jobs.max_parallel` (1..8) and optionally `jobs.max_concurrent_checks`. At most one job is active per issue. `GET /v1/status` reports the slots and all active jobs, and the event stream already carries the issue key on every event (`autos watch` prefixes each line with it). Jobs submitted through `POST /v1/jobs` or revisions while all slots are busy stay queued and are retried, in submission order, whenever a running job settles.

## Requesting changes after review

Review the `deep/<KEY>` branch and the job evidence, then ask for more work on a `READY_FOR_HUMAN` job:

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTOS_OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instructions":"Also handle the empty-list case","roles":["swe","qa"]}' \
  http://127.0.0.1:8787/v1/jobs/$JOB_ID/revisions
```

The body is strict: `instructions` (1 to 4000 characters, required) and optional `roles` (subset of `swe`, `qa`, `reviewer`; default `["swe"]`); unknown fields are rejected with 400. The response is `202` with the new job (`parent_job_id`, `revision`), and the controller starts it in the background exactly like `POST /v1/jobs`. Errors: 400 invalid body or header, 404 unknown job, 409 `CONFLICT` when the job is not the latest `READY_FOR_HUMAN` attempt of its issue or another attempt is active. Error bodies never include the instructions. `POST /v1/jobs` also accepts an optional `notes` array (at most 5, same shape) for an initial attempt.

The revision continues from the reviewed commit on the same `deep/<KEY>` branch and base, runs the full checks, QA and review again, and adds a new commit on top. With push enabled it may only fast-forward the existing remote branch, and it refuses if the remote branch changed. Notes cannot override path policy or other platform rules. They are stored as evidence (`operator-notes.json`, listed by `GET /v1/jobs/{jobId}/artifacts` as metadata only) and never appear in job output, events, or logs. The author recorded is `operator` unless the optional `X-Autos-Operator` header carries a label (`[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}`); this is a label, not authentication, since the single bearer token is the only credential. The CLI equivalent is `autos revise JOB_ID --note ...` (see [cli.md](cli.md)).

## Ticket notes and holds

Operator guidance stored by issue key, valid before Autos has seen the issue and applied to every later attempt (discovered, submitted, retried, revised) until removed. All routes need the bearer token and accept the optional `X-Autos-Operator` author label.

- `POST /v1/issues/{issueKey}/notes` with the revision body (`instructions` 1 to 4000 characters, optional `roles`, default `["swe"]`) returns `201` with the stored note (`note_id`, `issue_key`, `instructions`, `roles`, `author`, `created_at`) plus `jira`: `found`, `not_found` (the note is still stored) or `unchecked`. The lookup is a best-effort read-only Jira `GET` bounded by a short timeout and is `unchecked` whenever the controller has no Jira read configured. 400 invalid body/label or a project outside `jira.allowed_projects`, 409 for a closed issue or more than 5 notes.
- `DELETE /v1/issues/{issueKey}/notes` removes all notes, `DELETE /v1/issues/{issueKey}/notes/{noteId}` one (404 for an unknown id); both return `200 { removed }`.
- `PUT /v1/issues/{issueKey}/hold` and `DELETE /v1/issues/{issueKey}/hold` hold and release automatic discovery; both return `200 { held }`.
- `GET /v1/notes` returns `{ tickets: [...] }` for every issue with notes or a hold; `GET /v1/issues/{issueKey}/notes` returns one summary (`notes`, `held`, `status`, `attempts`, `dry_runs`, `latest_job_id`, `latest_state`, `last_activity_at`, `attempts_with_current_notes`). `GET /v1/issues/{issueKey}` now also returns `ticket_notes` and no longer answers 404 when the issue has only notes or a hold.

Note text appears only in these responses (and in the artifacts); audit lines (`ticket_note_add`, `ticket_note_remove`, `ticket_notes_clear`, `ticket_hold`, `ticket_release`) carry only the issue key, note id, roles and actor. The CLI equivalents are `autos note` and `autos notes` (see [cli.md](cli.md)).

## Bulk retry of blocked jobs

`POST /v1/jobs/retry-blocked` with an optional body `{ "code": "UPSTREAM" }` starts a new attempt (the same `workflow.retry` as `autos retry JOB_ID`) for every `BLOCKED` job, or only those blocked with that `blocked_code`. A job is skipped when its issue already has a newer attempt, so only the newest blocked attempt per issue is retried. The response is `{ matched, retried, skipped_newer_attempt, failed, jobs: [{ issue_key, job_id, new_job_id }] }`. New attempts are queued; at most `jobs.max_parallel` start immediately and the controller's drain loop runs the rest as slots free up. `autos retry --all-blocked [--code CODE]` offers the same operation locally.

## Request logging and audit

`controller start` logs one JSON line per request to stderr (Compose captures it): `request_id`, `method`, `route` (the route pattern such as `/v1/jobs/:jobId`, never the raw URL or query string), `status` and `duration_ms`; `/health` is logged only at debug level. A rejected bearer token logs `auth_rejected` (method and whether a bearer header was presented; the token is never logged) and the 401 request line. Mutations also write an `audit` line with `action` (`job_submit`, `job_revise`, `job_cancel`, `job_retry`, `jobs_retry_blocked`), the job ids, the issue key and the `actor` label from the optional `X-Autos-Operator` header (a label, not authentication; default `operator`). Headers, request bodies, tokens, query strings and note text are never logged. `GET /v1/status` `controller.poll_loop` also reports `auto_poll` and `last_discovery_at`.

## Job fields and status

Job objects contain `job_id`, `issue_key`, `state`, `dry_run`, `repository_id`, `base_sha`, `repair_round`, timestamps, and, when known, `feature_branch`, `commit_sha`, `blocked_code`, `blocked_reason`, and, for revision attempts, `parent_job_id` and `revision`. A `PAUSED` job (every provider of a role rate limited; it resumes on its own) also has `resume_at`, `pause_code`, `paused_role`, `paused_since` and `pause_count`; `GET /v1/status` lists paused jobs in `activity.paused_jobs`, and `job_paused` events carry `resume_at`. `GET /v1/jobs/{jobId}` also returns `push_status` from the artifact manifest when one exists. Free-text fields are truncated and scrubbed of URLs, filesystem paths, and token-like strings. Every error uses `{ code, message, request_id }` with a server-generated request ID. `POST /v1/jobs/{jobId}/cancel` aborts a running job and returns the resulting job; an unknown job returns 404. `GET /v1/jobs/{jobId}/artifacts` returns manifest metadata only (names, SHA-256 digests, media types).

## What has and has not been verified

Route behavior (authentication, redaction, schemas, cancellation, pagination, error shapes) and OpenAPI parity are covered by tests against fake workflow services and `fastify.inject`/loopback HTTP. These are not evidence of a working autonomous service. Running real jobs additionally needs valid Jira/Confluence/Bitbucket credentials and a running host runner supervisor reached through `DockerRunnerClient` over a Unix socket. Docker is not installed on the development machine, so the container path, Compose publishing, and real provider execution are untested here. The base branch name is not yet a job field; use `GET /v1/projects`.
