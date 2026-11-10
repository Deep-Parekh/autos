# Live agent progress: plan

Goal: while an agent runs, `autos watch` (and optionally Teams) shows what it is doing every few seconds, for example:
```
19:46:02 CMS2-1495 swe/codex: ran rg -n "assocType" (12 commands so far)
19:46:31 CMS2-1495 swe/codex: edited src/main/webapp/js/assoc/snc_association.js
19:47:00 CMS2-1495 swe: 3 files changed (+111 −36)
```
Today Autos emits events only at stage boundaries, and the agent's transcript is written only when the agent exits, so `watch` goes quiet for the whole agent run.

## What exists already
- **Provider output:** all three CLIs already stream JSON lines: Claude `--output-format stream-json --verbose`, Codex `exec --json`, Cursor `--output-format stream-json`. The adapter (`packages/cli-adapters`) collects stdout and parses it only at exit.
- **Action extraction:** `summarizeTranscriptActions` (`packages/contracts/src/transcript.ts`) already turns a transcript into narrative-free actions for the pause handoff. Its per-event mapping can be reused line by line.
- **The path from container to controller:** controller → supervisor (HTTP over a unix socket, one JSON response per role) → `docker run` worker → entrypoint → adapter → provider CLI. The entrypoint prints one result line at the end.
- **Events:** events flow workflow → SQLite → SSE `/v1/events/stream` → `watch`, the Teams relay and the bot.

## Rules (same as the rest of Autos)
- **Content:** progress is built from what the agent does, never from what it says. Allowed:
  - the command's executable plus at most two arguments, length-capped and run through the existing secret scrubber;
  - workspace-relative paths of files it read or edited;
  - counts.
- **Never included:** narrative, command output, file contents, prompts or tokens.
- **Trusted counters:** "files changed" figures come from trusted Git on the host (`inspectCandidate`), not from the agent.
- **Rate limits:**
  - at most one progress event per role every 5 s (later actions are folded into a count);
  - at most 300 progress events per role run.

  Progress events are informational. They never change job state, and they are excluded from the dataset export.
- **Failure handling:** progress is best effort. If the stream breaks or a line cannot be parsed, the role carries on exactly as today.

## Chunks
Chunk 0 comes first; after it, A–D are independent and can run in parallel (for example with GPT-6 Luna workers). Each chunk owns only its listed files. Tests use fakes only.

### 0. Contracts (primary agent, first)
- `packages/contracts/src/jobs.ts`:
  - add the event type `role_progress` with fields `role`, `provider`, `message` (≤ 200 chars) and `count`;
  - add `ProgressAction = { kind: 'command' | 'read' | 'edit' | 'search' | 'other'; label: string }`.
- `packages/contracts/src/ports.ts`: `RunnerPort.runRole(request, signal, onProgress?: (action: ProgressAction) => void)`.
- `packages/contracts/src/transcript.ts`: export `actionFromEvent(provider, jsonLine): ProgressAction | null`, which is the current per-line mapping, now exported.

### A. Streaming in the adapter and worker
Files: `packages/cli-adapters/src/index.ts`, `docker/worker/entrypoint.mjs`, tests in `tests/cli-adapters/`.
- **Adapter:** `CliAdapter.run(request, signal, onLine?)` calls `onLine` for each complete stdout line as it arrives, buffering partial lines. Parsing at exit is unchanged.
- **Entrypoint:** maps each line with `actionFromEvent` and writes `{"autos_progress":{…}}` lines to **stderr**, throttled to one every 2 s with a count of skipped actions. The final result line stays on stdout.
- **Tests:** a fake CLI prints events with delays, and the progress lines are checked: their order, the throttling, and that no narrative text gets through.

### B. Supervisor and runner
Files: `packages/runner/src/index.ts`, tests in `tests/runner/`.
- **Supervisor:** reads the worker's stderr incrementally, validates each `autos_progress` line with Zod, and forwards it.
- **HTTP response:** the `/run-role` response becomes NDJSON. It sends `{"progress":…}` lines while the role runs, then the final `{"result":…}`. A client that doesn't ask for streaming (no `accept: application/x-ndjson`) gets today's single JSON response, so mixed versions keep working.
- **Runner client:** `DockerRunner` and the supervisor client call `onProgress` for each progress line.
- **Tests:** a fake container streams progress, then a result. Cover invalid or oversized lines being dropped, and a stream that breaks mid-role still returning the result.

### C. Workflow events and the trusted file counter
Files: `packages/workflow/src/index.ts`, tests in `tests/workflow/`.
- **Agent actions:** `runRole` passes an `onProgress` that turns actions into `role_progress` events, at most one per role every 5 s and 300 per role run. A suppressed action raises the count on the next event.
- **File counter:** during SWE runs, a timer calls `inspectCandidate` every 30 s and emits `role_progress` "N files changed (+a −d)" when the numbers change. This needs no agent cooperation, so it works with every provider and with fakes.
- **Dataset:** the dataset export skips `role_progress`.

### D. Interfaces and docs
Files:
- `apps/cli/src/index.ts`: `watch` prints progress lines and gains `--quiet-progress`; `status` shows each active job's last action;
- `apps/cli/src/teams.ts`: a notify kind `AGENT_PROGRESS`, off by default; when on, it posts at most one card per job every 10 minutes;
- `apps/controller/src/index.ts`: the event schema;
- `docs/openapi.yaml`, `docs/cli.md`, `docs/teams.md`;
- tests in `tests/interfaces/`.

## Order and effort
1. **Chunk 0:** about ½ day.
2. **Chunks A–D in parallel:** about 1 day each.
3. **Integration, the full check, and a manual run** with a fake provider plus one real dry run: about ½ day.

Shortcut: chunk C's file counter alone is useful before A and B land. It gives "N files changed" every 30 s with no container changes.

## Out of scope
- Showing agent narrative or reasoning.
- Live diffs in Teams.
- Changing agent behaviour.
