# Local pilot on macOS

Run Autos against one real Jira ticket on this Mac before requesting a VM. The controller runs directly on the host; the trusted supervisor is the only process that talks to Docker; coding agents run in disposable containers. Jira and Confluence stay read-only and nothing is pushed unless you enable it.

Status: the synthetic scenario and the Docker isolation tests pass locally. The steps below that use real Atlassian, Bitbucket and provider accounts have **not yet been run**; record what you find.

## Files

| File | Purpose | Commit? |
| --- | --- | --- |
| `config/pilot.template.yaml` → `config/config.yaml` | Pilot configuration with `REPLACE_ME` placeholders | No (`config.yaml` is git-ignored) |
| `.env.example` → `.env` | Secrets and supervisor settings | No (`.env` is git-ignored) |
| `config/provider-profiles.example.json` → `~/.autos/auth/provider-profiles.json` | Team-subscription logins for agent containers (`provider-profiles.api.example.json` for API keys or a local model) | Never; keep outside the repo, mode 600 |
| `docker/worker-providers/Dockerfile` | Worker image with real `claude`, `codex` and Cursor `agent` CLIs | Yes (template) |
| `scripts/pilot-supervisor.sh` | Validates prerequisites and starts the supervisor | Yes |

## 1. Prerequisites

- Docker Desktop running (`docker info` succeeds).
- Node 22.20+, then `npm ci --ignore-scripts && npm run build` and `npm run check` passing.
- An Atlassian Cloud account that can read the private saved filter and the branch-map page, plus an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
- Read (and later push) access to the Bitbucket repository through your ssh-agent (`ssh -T git@bitbucket.org` works).
- Seats on your team plans for Claude (Team/Enterprise), ChatGPT (Business/Enterprise, for Codex) and Cursor, approved for this use. Step 3 turns each into a login the containers can use. API keys still work instead (see "API keys and local models" below).
- The Confluence branch-map page created from `Autos_MVP_Requirements_and_Starter_Docs/Confluence_Project_Branch_Mapping_Template.md`, with exactly one enabled row for the pilot project.

## 2. Build images

```sh
docker build -f docker/worker/Dockerfile -t autos-worker:local .
docker build -f docker/worker-providers/Dockerfile -t autos-worker-providers:local .
docker build -f docker/runner/Dockerfile -t autos-checks:local .
docker network create autos-egress
```

Rebuild the first two whenever `packages/` changes. Provider versions are pinned with `--build-arg CLAUDE_CODE_VERSION=…` / `CODEX_VERSION=…`. The checks image ships Java 17; add `--build-arg JAVA_VERSION=21` if the repository needs it. `autos-egress` is a plain bridge network that gives agent containers outbound internet access so the CLIs can reach their APIs; checks always run with no network.

## 3. Secrets

```sh
cp .env.example .env            # fill in AUTOS_ATLASSIAN_*, AUTOS_OPERATOR_TOKEN (openssl rand -hex 24)
mkdir -p ~/.autos/auth && chmod 700 ~/.autos ~/.autos/auth
cp config/provider-profiles.example.json ~/.autos/auth/provider-profiles.json
chmod 600 ~/.autos/auth/provider-profiles.json   # then fill in the logins below
```

### Provider logins on your team subscriptions

Each profile entry has a `mode`. With `mode: "subscription"` Autos uses only the seat's plan: it refuses any API key in that entry, and with `AUTOS_REQUIRE_SUBSCRIPTION=true` (the default in `.env.example`) the supervisor will not start if any profile is not a subscription.

1. **Claude Code:** run `claude setup-token`, approve in the browser with your Team/Enterprise account, and paste the printed token into `CLAUDE_CODE_OAUTH_TOKEN`. It lasts one year. Your normal Mac login lives in the Keychain, which containers cannot read, so this token is required.
2. **Codex:** sign in with your ChatGPT team account into a dedicated folder next to the profile file:
   ```sh
   mkdir -m 700 ~/.autos/auth/codex-pilot
   printf 'cli_auth_credentials_store = "file"\n' > ~/.autos/auth/codex-pilot/config.toml
   CODEX_HOME=~/.autos/auth/codex-pilot codex login      # choose "Sign in with ChatGPT"
   chmod 600 ~/.autos/auth/codex-pilot/auth.json
   ```
   The profile's `"directory": "codex-pilot"` points at it. Each run gets a private copy; when Codex refreshes its token, only the refreshed `auth.json` is copied back, and runs using the same login take turns so refreshes cannot collide.
3. **Cursor:** create a user API key in the Cursor dashboard and paste it into `CURSOR_API_KEY`. Usage follows your Cursor plan; confirm on your dashboard after the first run.

The supervisor passes each provider only its own credential, through a short-lived env file; credentials never appear in `docker` arguments, the controller, or the workspace. `autos doctor --deep` lists each profile's mode.

### API keys and local models

`config/provider-profiles.api.example.json` shows `mode: "api"` (pay-per-token `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and `mode: "local"` (Claude Code against your own Anthropic-compatible gateway via `ANTHROPIC_BASE_URL`). Set `AUTOS_REQUIRE_SUBSCRIPTION=false` to allow them. Local mode is Claude-only for now, and the egress firewall blocks private addresses, so a gateway on your LAN needs a firewall exception.

## 4. Configuration

```sh
cp config/pilot.template.yaml config/config.yaml
# replace every REPLACE_ME: site URL, filter ID, project keys, page ID, workspace/repo, paths
node --conditions=development --import tsx scripts/validate-config.ts config/config.yaml
```

Keep `push_feature_branch: false` for the first runs. Set `allowed_paths` to the directories a fix may touch; anything else blocks the job. Replace the `pilot-java` check with the repository's real test command, written as an argument array.

## 5. Offline build dependencies

Checks run inside `autos-checks:local` with no network, so dependencies must be preloaded into a cache outside the project:

```sh
mkdir -p ~/.autos/m2-repository
git clone git@bitbucket.org:<workspace>/<repo>.git /tmp/autos-prefetch && cd /tmp/autos-prefetch
git checkout <development-branch>
mvn -B -Dmaven.repo.local="$HOME/.autos/m2-repository" dependency:go-offline test-compile
cd - && rm -rf /tmp/autos-prefetch
```

Private artifacts must come from your normal approved Maven access during this prefetch; no Maven `settings.xml` or credentials are mounted into checks. If `go-offline` misses plugins, run the repository's real test command once with the same `-Dmaven.repo.local` to populate them. For non-Maven toolchains, build the dependencies into a derived checks image instead.

## 6. Start the supervisor

In its own terminal:

```sh
scripts/pilot-supervisor.sh
```

It refuses to start if an image, the network, the profile file (mode 600, outside the repo) or the Maven cache is missing, then listens on `data/runner.sock`.

## 7. Run the pilot

In a second terminal, from the project root:

```sh
set -a; source .env; set +a
node apps/cli/bin/autos.mjs --config config/config.yaml doctor
node apps/cli/bin/autos.mjs --config config/config.yaml providers test --all
node apps/cli/bin/autos.mjs --config config/config.yaml run ABC-123 --dry-run
node apps/cli/bin/autos.mjs --config config/config.yaml run ABC-123
```

1. **doctor** checks configuration references and local binaries. It reports `cursor-agent` as missing; that is expected while no role uses Cursor.
2. **providers test --all** runs a read-only smoke test of each provider in a real container. Claude and Codex must report `PASS`; Cursor will `FAIL` until it is installed.
3. **--dry-run** reads the ticket, the filter membership and the branch map, and pins the development-branch SHA. It must end `PLANNED` with no agent run and no branch. Check `artifacts/<jobId>/branch-map.json` and `base.json`.
4. **The real run** of one low-risk, reproducible bug should end `READY_FOR_HUMAN`. Inspect `artifacts/<jobId>/summary.md`, `checks.json`, `qa.json`, `review.json` and `rounds.json`, and the commit on `deep/<KEY>` in `workspaces/<jobId>/`. `BLOCKED` with a reason is a valid outcome; read `blocked_reason` before retrying with `autos retry <jobId>`. After your manual check, either `autos revise <KEY> --note "…"` for more work, or merge it yourself and run `autos close <KEY> --merged` to delete its workspace (evidence is kept).

The template sets `jira.auto_poll: false`, so `controller start` only runs tickets you submit and never works through the whole filter on its own. Only after a reviewed `READY_FOR_HUMAN`, consider `push_feature_branch: true`, then set `jira.auto_poll: true` for continuous polling (each poll admits at most `jira.max_new_per_poll` new tickets):

```sh
node apps/cli/bin/autos.mjs --config config/config.yaml controller start
curl -s -H "Authorization: Bearer $AUTOS_OPERATOR_TOKEN" http://127.0.0.1:8787/v1/queue
```

## Scaling to several tickets on a larger host

The pilot processes one ticket at a time (`jobs.max_parallel: 1`). On a larger machine, raise it in `config/config.yaml` and restart the controller; no code change is needed:

```yaml
jobs:
  max_parallel: 3            # concurrent tickets (1–8); at most one active job per issue
  max_concurrent_checks: 2   # concurrent build/test runs; must be <= max_parallel
```

Each ticket still gets its own workspace, branch and short-lived containers, so slots never share source. Size it from the host: each active ticket runs about one 2 GB / 2 CPU container at a time, and checks are the heaviest step; provider rate limits and cost often bind before hardware. `autos status` shows `Slots: in_use/max` and every active ticket; `autos watch` prefixes each line with the issue key. Parallel tickets in the same repository can still conflict when you merge them.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `AUTH` on dry-run | Wrong Atlassian email/token, or the account cannot read the private filter |
| `MAPPING` | Zero or several enabled branch-map rows for the project, or a repository not in `allowed_repositories` |
| `POLICY` | Issue type or project outside `intake_types`/`allowed_projects`, or a change outside `allowed_paths` |
| Smoke test `FAIL (AUTH)` | Login missing, expired or revoked in the profile (re-run `claude setup-token` / `codex login`), or the profile name does not match `auth_profile` |
| Supervisor exits with a profile error | A profile lacks `mode`, mixes an API key into a subscription entry, or is not `subscription` while `AUTOS_REQUIRE_SUBSCRIPTION=true` |
| Smoke test `FAIL (TOOL)` with network errors | `AUTOS_PROVIDER_NETWORK` unset, or the network does not exist |
| Checks fail on dependency resolution | The offline Maven cache is incomplete (step 5) |
| Supervisor "Dependency cache" error | The cache must not be inside the auth, workspace or artifact folders |

## Known gaps

- Real provider CLIs have not yet been run inside the worker image. `providers test --all` is the first real verification and may reveal CLI flag or home-directory issues to fix in `packages/cli-adapters`.
- Subscription logins have not been exercised against the real services yet; `providers test --all` is the first proof. Use of team subscriptions for unattended automation is subject to each vendor's terms and your company's policy.
- Cursor's installer is not version-pinned, and its headless flags are unverified until `providers test --all` passes.
- The `autos-egress` bridge network allows general outbound access from agent containers; it is not an allowlist.
