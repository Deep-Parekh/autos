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

### Codex command sandbox

Inside the worker container Codex runs with `--sandbox danger-full-access` and approvals set to `never`. Its own sandbox (bubblewrap) needs Linux user namespaces, which Docker's default seccomp profile blocks, so with it every Codex shell command failed (`TOOL`). The container is the boundary instead. It has a read-only root filesystem, drops all capabilities, forbids privilege escalation and runs as a non-root user. Source is mounted read-only for QA, the reviewer and triage, and the container gets no host paths, no credentials other than its own login, and no Docker socket. As with Claude's SWE build commands, Codex's commands can use the container's egress network (public internet; private addresses are blocked). Uncontained adapter use outside the worker keeps Codex's native sandbox.

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

If the prefetch fails with `Non-parseable POM … unexpected markup <!d`, a proxied repository served an HTML page instead of a POM and it was cached. Delete that artifact's folder from `~/.autos/m2-repository`, seed the cache from your working local repository (`rsync -a --ignore-existing ~/.m2/repository/ ~/.autos/m2-repository/`), and rerun. Run the prefetch (or at least `test-compile`) with each branch's own JDK (`JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn …`): compiling a Java 21 branch on JDK 25 fails inside Lombok with `TypeTag :: UNKNOWN`.

Private artifacts must come from your normal approved Maven access during this prefetch; no Maven `settings.xml` or credentials are mounted into checks. If `go-offline` misses plugins, run the repository's real test command once with the same `-Dmaven.repo.local` to populate them. For non-Maven toolchains, build the dependencies into a derived checks image instead.

### JDK and Tomcat per project

Agents and checks get the JDK (and optionally Tomcat) named on the project's branch-map row, mounted read-only from a toolchain folder outside the project. Install what the branch map uses:

```sh
node --conditions=development --import tsx scripts/install-toolchains.ts jdk 21 25
node --conditions=development --import tsx scripts/install-toolchains.ts tomcat ~/sunnet/software/apache-tomcat-11.0.24
node --conditions=development --import tsx scripts/install-toolchains.ts list
```

- **JDKs** are Linux Amazon Corretto builds copied out of the official `amazoncorretto:<major>-al2023` images for this machine's architecture. macOS JDKs cannot run inside the Linux containers.
- **Tomcat** is copied from your local install and sanitized: scripts and jars (JDBC drivers kept) are copied; `setenv.*`, Windows `.dll`/`.exe`/`.bat` files, `tomcat-users.xml`, keystores, Kerberos/JAAS files (`krb5.conf`, `login.conf`), `webapps`, `logs`, `work` and `temp` are not; `context.xml` is replaced with a stock file, `server.xml` with a minimal one if it holds datasources or passwords, and credential lines are dropped from property files. The output lists exactly what was kept, replaced and skipped.
- The folder is `~/.autos/toolchains` (`AUTOS_TOOLCHAIN_ROOT`); `--force` replaces an installed version.

Then add `JDK` and `Tomcat` columns to the Confluence branch map (for example `25` and `11.0.24`). A blank cell falls back to the repository build profile's `jdk`/`tomcat` in `config/config.yaml`. A project whose JDK or Tomcat is not installed is blocked with a clear reason; `doctor --deep` checks this up front. No database credentials are available to agents in this phase.

## 6. Start the supervisor

In its own terminal:

```sh
scripts/pilot-supervisor.sh
```

It refuses to start if an image, the network, the profile file (mode 600, outside the repo), the Maven cache or the toolchain folder is missing, then listens on `data/runner.sock`.

## 7. Run the pilot

In a second terminal, from the project root:

```sh
set -a; source .env; set +a
node apps/cli/bin/autos.mjs --config config/config.yaml doctor
node apps/cli/bin/autos.mjs --config config/config.yaml providers test --all
node apps/cli/bin/autos.mjs --config config/config.yaml run ABC-123 --dry-run
node apps/cli/bin/autos.mjs --config config/config.yaml run ABC-123
```

1. **doctor** checks configuration references and local binaries (host binaries are informational; the agents run the CLIs baked into the image). `doctor --deep` also checks the supervisor, Jira filter, branch map, remotes, disk and each provider profile's mode.
2. **providers test --all** runs a read-only smoke test of each provider in a real container. All three must report `PASS` before a real run.
3. **--dry-run** reads the ticket, the filter membership and the branch map, and pins the development-branch SHA. It must end `PLANNED` with no agent run and no branch. Check `artifacts/<jobId>/branch-map.json` and `base.json`.
4. **The real run** of one low-risk, reproducible bug should end `READY_FOR_HUMAN`. Inspect `artifacts/<jobId>/summary.md`, `checks.json`, `qa.json`, `review.json` and `rounds.json`, and the commit on `deep/<KEY>` in `workspaces/<jobId>/`. `BLOCKED` with a reason is a valid outcome; read `blocked_reason` before retrying with `autos retry <jobId>`. After your manual check, either `autos revise <KEY> --note "…"` for more work, or merge it yourself and run `autos close <KEY> --merged` to delete its workspace (evidence is kept).

The template sets `jira.auto_poll: false`, so `controller start` only runs tickets you submit and never works through the whole filter on its own. Only after a reviewed `READY_FOR_HUMAN`, consider `push_feature_branch: true`, then set `jira.auto_poll: true` for continuous polling (each poll admits at most `jira.max_new_per_poll` new tickets):

```sh
node apps/cli/bin/autos.mjs --config config/config.yaml controller start
curl -s -H "Authorization: Bearer $AUTOS_OPERATOR_TOKEN" http://127.0.0.1:8787/v1/queue
```

## Unattended runs: limits, pauses and build state

When a provider hits its session or usage limit, the next provider in the role's chain continues in the same workspace. When every provider of the role is limited, the job is `PAUSED` instead of blocked: it keeps its workspace, pinned base, branch and repair round, frees its slot, and resumes by itself at the earliest reset time the CLIs report (otherwise after 15, 30, 60, … minutes, capped at 4 h), restarting at the role's primary provider. After 24 h of consecutive pauses it is blocked with `RATE_LIMIT`. Tune it with `jobs.rate_limit_pause` (see [cli.md](cli.md#rate-limit-pauses)). Autos never pulls newer development-branch commits into a paused or resumed job; you resolve conflicts with `develop` when you merge. Keep the controller running (`controller start`) so paused jobs resume; `autos status` lists them and `autos jobs cancel JOB_ID` stops one.

Within one job, SWE containers reuse the same `/scratch`, so a fallback, repair round or resume does not recompile and repopulate `/scratch/m2` from zero. QA and the reviewer get their own empty scratch every time. The SWE scratch lives under `artifacts/.scratch/swe-<jobId>` and is deleted when the job ends, is cancelled or pruned, and when the supervisor starts.

## Model tiers: cheapest model and effort first

By default each role runs one provider/model chain. To save cost, define **model tiers** (size classes such as `sm`, `med`, `lg`; the names are yours) and give a role a **ladder** of tiers, cheapest first. Autos starts each ticket as low as it can and moves up only when the work fails, so a renamed field or a syntax bug never uses Opus or GPT-6 Sol. The sample configs carry a commented example; the `provider`/`model`/`fallbacks` form keeps working, and you can mix forms per role.

```yaml
models:                         # optional reusable named models, written in tiers as name or name:effort
  luna:  {provider: codex, model: gpt-6-luna}
  terra: {provider: codex, model: gpt-6-terra}
model_tiers:                    # each tier: ordered list of 1-3 entries {provider, model, effort}
  sm:  [{provider: claude, model: haiku, effort: high}, luna:high]
  med: [terra:high, {provider: claude, model: sonnet, effort: high}, {provider: cursor, model: auto}]
  lg:  [{provider: codex, model: gpt-6-sol, effort: xhigh}, {provider: claude, model: opus, effort: max}]
triage: {enabled: true, tier: sm, timeout_ms: 180000}
agents:
  swe:      {timeout_ms: 1800000, ladder: [sm, med, lg]}
  qa:       {timeout_ms: 900000,  ladder: [med, lg]}
  reviewer: {timeout_ms: 900000,  ladder: [med, lg], min: med}
```

- **Effort is part of an entry, not of the model**, so the same model can appear at `high` in one tier and `xhigh` in another (e.g. `sm: [luna:medium]`, `sm-x: [luna:xhigh]`). Omit it for the CLI's default. Config load validates it per provider: Claude `--effort` accepts `low|medium|high|xhigh|max`; Codex (`-c model_reasoning_effort=…`) accepts `none|minimal|low|medium|high|xhigh|max`, and which levels a given model honours is up to the model (an unsupported one fails at the provider); Cursor entries use model `auto` and no effort. Model and effort go to the CLI as separate arguments.
- **Within a tier**, entries are tried in order whenever one fails on the provider side: `RATE_LIMIT`, `AUTH`, `UPSTREAM`, `UNAVAILABLE`, `TIMEOUT`, and also `CONTEXT`/`INVALID_OUTPUT` (another model of the same size may cope). This replaces the role's `fallbacks` chain. The SWE handoff, the per-job SWE scratch and the rules for edits by a failed entry are the same as for fallbacks. When every entry of the current tier is rate limited, the job pauses as described above and resumes on the same tier. The new-ticket gate considers the SWE start tier (its floor, else its lowest tier): it engages when every entry's provider there is limited.
- **Escalation to the next tier** happens when the work fails: checks, QA or review fail, so the repair SWE run uses the next tier. It also happens when a tier's last entry fails with `CONTEXT` or `INVALID_OUTPUT` (the whole tier was too small), for any role; SWE then continues partial work with a handoff after `CONTEXT`. QA and the reviewer otherwise stay at their start tier: a FAIL verdict is their job, not a sign they were too weak. Escalation rounds do not consume `jobs.max_repair_rounds`; they are bounded by the ladder (at most 8 tiers). Once SWE is at its top tier, `max_repair_rounds` applies as before and the job blocks when it is used up. `READY_FOR_HUMAN` still needs passing checks, QA and review on the same final candidate.
- **Floor.** `min` must be one of the role's ladder tiers. Triage, pins and revisions never start the role below it, and a pin below it is refused. Use it to keep the reviewer on a strong tier.
- **Start tier.** Sources in order of precedence:
  1. A pin for this revision (`autos revise … --tier`).
  2. A ticket pin (`autos tier KEY …` or `autos note KEY … --tier`).
  3. The tier that finished the previous attempt. Revisions and retries never start below it.
  4. The triage choice.
  5. Otherwise the lowest tier (or the floor).
- **Triage** is one cheap read-only call per new ticket. It runs on the `triage.tier` entries in order, in the QA sandbox profile, so it cannot write source. It reads the ticket and picks a starting tier, with a one-line reason, for each ladder role that has no pin or previous tier. Its JSON is validated, and trusted code clamps the choice to the ladder and floor. Any failure (malformed output, every entry limited, timeout) starts at the lowest tier. Without a `triage` block, or with `enabled: false`, roles start at their lowest tier. Triage is advisory: it only decides where to start.
- **Pins** are stored by issue key like ticket notes, so you can set them before Autos has seen a ticket. They are applied when an attempt is picked up and survive restarts. `--effort` overrides the effort of every claude/codex entry of the pinned tier (the level must be valid for each; cursor entries run without), replacing that ladder tier in place so escalation continues to the next tier. A tier the role's ladder does not use is a fixed step without escalation, refused for a role with a floor. Roles in the plain provider form can be pinned to any tier (fixed). `autos notes` and `autos show` list pins; see [cli.md](cli.md).

Evidence:
- Each provider call's `call.json` records the tier, entry index (`chain_index`), model and effort; the triage call is marked `purpose: triage`.
- `role_started`/`role_finished` events carry `tier`, `model` and `effort`, and `tier_selected`/`tier_escalated` events show the start tier and every move.
- `tiers.json` holds each role's ladder, start tier and its source with the reason, the escalations and the triage outcome.
- `summary.md` shows the tier and entry that solved the ticket.
- `autos export dataset` includes `tiers` and the call fields, so you can later check which tickets a cheaper tier would have solved.

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
| `POLICY` | Project outside `allowed_projects`, issue type outside `intake_types` (only if you set it), or a change outside `allowed_paths` |
| Smoke test `FAIL (AUTH)` | Login missing, expired or revoked in the profile (re-run `claude setup-token` / `codex login`), or the profile name does not match `auth_profile` |
| Supervisor exits with a profile error | A profile lacks `mode`, mixes an API key into a subscription entry, or is not `subscription` while `AUTOS_REQUIRE_SUBSCRIPTION=true` |
| Smoke test `FAIL (TOOL)` with network errors | `AUTOS_PROVIDER_NETWORK` unset, or the network does not exist |
| Checks fail on dependency resolution | The offline Maven cache is incomplete (step 5) |
| `MAPPING`: required toolchain not installed | Install it with `scripts/install-toolchains.ts` (the JDK major or exact Tomcat version on the branch-map row) and restart the supervisor |
| Job shows `PAUSED` | Every provider of a role is rate limited; it resumes at `resume_at` (`autos status`). Cancel with `autos jobs cancel JOB_ID` |
| `CONFLICT`: workspace changed while paused | The paused workspace's Git metadata or location changed (or the ticket changed); retry the job to start a fresh attempt |
| Supervisor "Dependency cache" error | The cache must not be inside the auth, workspace or artifact folders |

## Known gaps

- Real provider CLIs have not yet been run inside the worker image. `providers test --all` is the first real verification and may reveal CLI flag or home-directory issues to fix in `packages/cli-adapters`.
- Subscription logins have not been exercised against the real services yet; `providers test --all` is the first proof. Use of team subscriptions for unattended automation is subject to each vendor's terms and your company's policy.
- Cursor's installer is not version-pinned, and its headless flags are unverified until `providers test --all` passes.
- The `autos-egress` bridge network allows general outbound access from agent containers; it is not an allowlist.
