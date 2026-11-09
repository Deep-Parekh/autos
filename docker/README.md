# Container and trusted supervisor

The controller image is started with Compose and publishes its HTTP port only on host loopback. It has no Docker socket mount. Before startup, create a private `config/config.yaml` from the example and set its referenced environment variables in the Compose environment. SQLite and artifact data persist in `./data` and `./artifacts`; Git workspaces persist in `./workspaces`.

The trusted supervisor runs on the host as a separate process and owns Docker access. Start it from the project root after building the packages with the environment below. It serves only health, role-run, checks, and stop operations over a mode-0600 Unix socket at `./data/runner.sock`. The controller sees that socket through the persisted data bind mount. Set `AUTOS_CONTROLLER_UID` and `AUTOS_CONTROLLER_GID` for Compose to the same user and group that own the socket and bind directories. Configure `AUTOS_HOST_ROOT` to the absolute project root; its `/app` client namespace maps to that host root. The configured workspace/artifact paths must resolve below those roots. The supervisor validates each translated path before mounting it.

```sh
npm run build
AUTOS_SUPERVISOR_SOCKET="$PWD/data/runner.sock" \
AUTOS_WORKSPACE_ROOT="$PWD/workspaces" \
AUTOS_PROMPT_ROOT="$PWD/artifacts" \
AUTOS_OUTPUT_ROOT="$PWD/artifacts" \
AUTOS_HOST_ROOT="$PWD" \
AUTOS_WORKER_IMAGE="autos-worker:local" \
AUTOS_CHECKS_IMAGE="autos-checks:local" \
AUTOS_PROVIDER_PROFILES_FILE="/etc/autos/provider-profiles.json" \
node docker/supervisor/start.mjs
```

Build reviewed images explicitly (see "Image build" below for the UID/GID build args): `docker build -f docker/worker/Dockerfile -t autos-worker:local .` and `docker build -f docker/runner/Dockerfile -t autos-checks:local .`. The base worker image includes the adapter but no provider executable. `docker/worker-providers/Dockerfile` derives `autos-worker-providers:local` with Claude Code 2.1.310 and Codex 0.162.1 (pinned) plus the Cursor CLI (`agent`, also linked as `cursor-agent`; **not version-pinned**: the build downloads and runs Cursor's vendor install script as root, so review it and rebuild deliberately; `--build-arg INSTALL_CURSOR=false` skips it, `CURSOR_INSTALL_URL` overrides the script URL). Authentication is never baked into an image.

## Provider profiles and auth modes

The supervisor reads a private (mode 0600) JSON file, `AUTOS_PROVIDER_PROFILES_FILE`: `{ "<profile>": { "claude" | "codex" | "cursor": { "mode": ..., "env"?: {...}, "directory"?: "relative/dir" } } }`. `mode` is required and is one of `subscription`, `api`, `local`. Every profile is validated at supervisor startup (exit 2, message names the profile and provider, never a value) and again on every run. Autos never falls back between modes: a profile is exactly one of them.

| Provider / mode | Required | Refused | Notes |
| --- | --- | --- | --- |
| claude / subscription | `env.CLAUDE_CODE_OAUTH_TOKEN` only (from `claude setup-token`, Pro/Max/Team/Enterprise seat) | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `directory` | Claude Code ranks API keys above the OAuth token (and always uses a key in `-p` mode), so none may be present. No Claude config directory is mounted (a stale `.credentials.json` would shadow the token) and `--bare` is never passed (it ignores the token). |
| claude / api | `env.ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `directory` | Pay-per-token. |
| claude / local | `env.ANTHROPIC_BASE_URL` (http/https, no credentials in the URL) | API key, OAuth token, `directory`; `ANTHROPIC_AUTH_TOKEN` optional | Operator-run model endpoint. |
| codex / subscription | `directory` holding a `codex login` (ChatGPT) `auth.json` | `env` of any kind (never `OPENAI_API_KEY`) | See "Codex login staging". |
| codex / api | `env.OPENAI_API_KEY` | `directory` | Pay-per-token. |
| cursor / subscription | `env.CURSOR_API_KEY` (user key from the Cursor dashboard; usage follows the owning account's plan) | `directory` | The only supported Cursor mode. |
| codex / local, cursor / api, cursor / local | - | always | "not supported yet". |

Set `AUTOS_REQUIRE_SUBSCRIPTION=true` on the supervisor to refuse, at startup and per run, every profile whose mode is not `subscription` (a team on seats then cannot silently run on API pricing). `/v1/health` returns `auth` (sorted `{profile, provider, mode}`, nothing else) and `require_subscription`; the supervisor also logs one startup line `auth` listing `profile/provider/mode` (no secrets, no paths). Only the variables allowed for the mode are written to the short-lived 0600 Docker env file (removed after the container is cleaned up); secrets never appear in Docker argv, results or logs, and the worker adapter redacts them from transcripts.

Example (do not check this file in): `{"team":{"claude":{"mode":"subscription","env":{"CLAUDE_CODE_OAUTH_TOKEN":"..."}},"codex":{"mode":"subscription","directory":"codex-team"},"cursor":{"mode":"subscription","env":{"CURSOR_API_KEY":"..."}}}}`. A `directory` must be a subdirectory beside the profile file, outside workspace/artifact roots.

### Codex login staging

For codex / subscription the profile directory is never mounted. Per run the runner (1) takes an in-process lock keyed by the canonical profile directory, so runs sharing one login are serialized (concurrent refresh-token rotation would invalidate the login); (2) copies `auth.json` into a fresh 0700 staging directory under `AUTOS_AUTH_STAGING_ROOT` (default: the OS temp dir; must be absolute, private to the supervisor user, and disjoint from workspace/output/cache roots) and writes a runner-generated `config.toml` with `forced_login_method = "chatgpt"` and `cli_auth_credentials_store = "file"`; (3) mounts that directory read-write at `/run/autos/auth` with `CODEX_HOME` pointing there so Codex can refresh tokens; (4) after the container exits, including failure, timeout and cancel, writes `auth.json` back atomically (temp file, rename, 0600) only if it changed and still passes validation (ChatGPT login with tokens, no `OPENAI_API_KEY`), discards everything else and removes the staging directory. The container user is `AUTOS_RUNNER_UID:GID`; unless the supervisor runs as root (it then chowns the staging files) that must equal the supervisor's own user. Staging directories left by a crashed supervisor are swept at startup; the last written-back login remains in the profile directory.

Provider containers default to Docker `--network none`. An operator may set both `AUTOS_PROVIDER_NETWORK` and `AUTOS_PROVIDER_NETWORK_APPROVED=true` for an explicitly approved Docker network. `host` and `container` network modes are rejected. A bridge network is only an explicit egress choice; this prototype does not claim that an arbitrary bridge isolates access to internal services. Checks always use `--network none`.

Role invocations mount only the workspace, the single prompt file, that invocation's private output directory, and (codex / subscription only) the per-run staged login directory. SWE receives source read-write with `.git` separately read-only. QA and reviewer receive source read-only. Build checks mount source read-only and copy it into a disposable scratch mount before executing configured argument arrays. The checks image includes Java 17 (or `--build-arg JAVA_VERSION=21`), Maven, Node 22, and npm. Checks use no network. For Maven projects, supply an artifact-only Maven repository at a host path outside workspaces and artifacts, set `AUTOS_MAVEN_CACHE_ROOT` to it, and ensure the configured check command includes `mvn -o` and `-Dmaven.repo.local=/opt/autos/m2/repository` (the runner also sets the latter through `MAVEN_OPTS` when the cache mount is present). Private Maven artifacts must be preloaded through an approved process; do not mount Maven `settings.xml` or credentials. For other toolchains, build dependencies into an operator-reviewed checks image or add a separate read-only cache mount before the pilot. All containers run non-root with a read-only root filesystem, dropped capabilities, no-new-privileges, `--init`, PID/memory/CPU limits (configurable below), and bounded time/output. Check report paths are currently empty because the shared `CheckCommand` contract has no report declaration.

The DockerRunner executor-injection path is marked test-only and is not exposed by product configuration. Production construction always launches Docker; there is no host-process fallback. `tests/runner` assertions use a fake Docker executor and prove command construction only. For a real boundary check, build the worker and fake worker images, then run `npm test -- tests/e2e/docker-boundaries.test.ts`. It skips only when the daemon is unavailable; if the daemon is available but the image is missing or a permission boundary fails, the test fails. The fake CLI edits only disposable fixture source, attempts (and must fail) to edit `.git` as SWE, and attempts (and must fail) source writes as QA and reviewer. It verifies worker containers have no controller/Git credential environment and no Docker socket mount. No container-isolation claim is made until that test actually passes on a Docker-enabled host.

## Image build and UID/GID

The worker and checks images create a passwd/group entry (HOME `/home/worker`) for the uid/gid the supervisor runs containers as, so tools that call `getpwuid` work. The defaults are 10001/10001. When the supervisor runs as the host `autos` user (the default: the supervisor passes its own uid/gid with `--user`), build with that user's ids:

```sh
ID_ARGS="--build-arg AUTOS_UID=$(id -u autos) --build-arg AUTOS_GID=$(id -g autos)"
docker build $ID_ARGS -f docker/worker/Dockerfile -t autos-worker:local .
docker build $ID_ARGS -f docker/test-worker/Dockerfile -t autos-test-worker:local .   # test-only fake provider image
docker build $ID_ARGS -f docker/runner/Dockerfile -t autos-checks:local .
```

(`useradd -o` allows ids that collide with existing system accounts, for example macOS gid 20 maps to `dialout`.) The worker image builds only `packages/cli-adapters` and `packages/contracts`, so it does not depend on the rest of the monorepo compiling. The checks image requires `git` (present in the base image; the build fails if it is missing).

## Supervisor environment

Empty environment values are treated as unset (so `AUTOS_RUNNER_UID=` never becomes uid 0). Invalid values make the supervisor exit with status 2 and a message naming the variable; no value is echoed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOS_RUNNER_UID`, `AUTOS_RUNNER_GID` | supervisor's own ids | Non-root ids used for `--user` and tmpfs ownership |
| `AUTOS_ROLE_MEMORY` | `2g` | Memory limit of role (provider) containers, `<n>m` or `<n>g` |
| `AUTOS_ROLE_CPUS` | `2` | CPU limit of role containers (positive number) |
| `AUTOS_CHECK_MEMORY` | `4g` | Memory limit of check containers. Exit 137 is reported as an out-of-memory failure that names this variable |
| `AUTOS_CHECK_CPUS` | `2` | CPU limit of check containers |
| `AUTOS_PIDS_LIMIT` | `256` | `--pids-limit` for all containers (16 to 4096) |
| `AUTOS_TMP_SIZE` | `128m` | Size of the `/tmp` tmpfs (noexec) |
| `AUTOS_HOME_SIZE` | `256m` | Size of the `/home/worker` tmpfs (provider CLIs write caches and sessions there) |
| `AUTOS_MAX_PROMPT_BYTES` | `262144` | Prompt size the worker adapter accepts (1024 to 1000000); passed to the worker as an environment value |
| `AUTOS_MAX_TRANSCRIPT_BYTES` | `5242880` | Cap on each role's `transcript.jsonl` (65536 to 52428800); the full redacted provider stream (Claude/Cursor `stream-json`, Codex `--json`) is kept up to this size, cut on a line boundary with a final `[transcript truncated]` line; passed to the worker as an environment value |
| `AUTOS_SHUTDOWN_WAIT_MS` | `10000` | Bounded wait for in-flight requests on SIGTERM/SIGINT |
| `AUTOS_REQUIRE_SUBSCRIPTION` | `false` | `true` refuses any profile whose mode is not `subscription` (startup and per run) |
| `AUTOS_AUTH_STAGING_ROOT` | OS temp dir | Parent of per-run Codex login staging directories (absolute, private) |
| `AUTOS_MAVEN_CACHE_ROOT`, `AUTOS_PROVIDER_NETWORK`, `AUTOS_PROVIDER_NETWORK_APPROVED`, `AUTOS_DOCKER_BINARY`, `AUTOS_CLIENT_ROOT`, `AUTOS_HOST_ROOT` | see above | unchanged |

The per-request timeout is not a supervisor setting: each role request's `timeout_ms` is passed into the worker as `AUTOS_TIMEOUT_MS`, which the entrypoint uses for the adapter instead of a fixed value. Every container runs with `--init` so orphaned provider and build subprocesses are reaped.

## Failure semantics

- Supervisor socket missing or refused: `DockerRunnerClient` throws `AutosError('UNAVAILABLE')` (retryable) so the workflow can requeue.
- `docker run` exit 125, 126 or 127 (daemon, image, flags or exec problem) or a docker binary that cannot be spawned: a role returns status `FAILED` with `error_code: 'UNAVAILABLE'`; `runChecks` throws `AutosError('UNAVAILABLE')` (retryable) instead of recording a failing check.
- Exit 137 (killed, usually OOM): a role returns `FAILED` / `TOOL` with a safe reason in `result.reason`; a check is `FAIL` with the excerpt "killed (exit 137): likely out of memory; raise AUTOS_CHECK_MEMORY". The check wrapper itself exits 70 on its own errors, so 125 to 127 always mean Docker.
- Worker failures before or around the provider run (invalid request or environment, adapter exception) return a JSON `FAILED` result with a sanitized `error_code` (`INVALID_INPUT`, `UNAVAILABLE`, `TOOL`, or another contract code); messages, stacks and process output are never emitted.
- `health()` reports `available` only when `docker info` succeeds and both the worker and checks images exist locally.

## Supervisor lifecycle and logs

On start, after claiming the socket (so a second supervisor cannot sweep a live one), the supervisor force-removes every container labelled `autos.job_id`, deletes `<artifacts>/.checks/*` scratch directories and stale `autos-auth-*` env directories. On SIGTERM or SIGINT it aborts in-flight runs (the docker CLI is stopped and the runner removes the containers), stops accepting connections, waits up to `AUTOS_SHUTDOWN_WAIT_MS`, force-closes what remains, sweeps labelled containers again and exits. A second signal exits immediately.

Each request writes one JSON line to stdout (for `journalctl`): `ts`, `service`, `event`, `action`, `job_id`, `role`, `provider`, `status`, `code`, `http_status`, `elapsed_ms`. Prompts, paths, commands, credentials and environment values are never logged.

## Check workspace copy and output excerpts

When the checks source is a git checkout, only `git ls-files -co --exclude-standard` paths are copied into the scratch directory (so ignored build output never enters it); otherwise the tree is copied. `.git` and `.autos-handoff` are never copied. Builds that need `.git` metadata (for example git-describe or commit-id version plugins) are unsupported: no `.git` view is provided inside checks. The output excerpt keeps the first 3,000 and last 6,500 characters plus up to 1,800 characters of middle lines matching `ERROR|FAIL|Tests run|BUILD FAILURE|Exception`, and states how much output was dropped. The total stays within the 12,000-character contract limit.
