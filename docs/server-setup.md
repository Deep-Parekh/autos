# Server setup

Run Autos continuously on an Ubuntu host. The **controller** runs in Docker Compose and polls the Jira filter. The **trusted supervisor** runs under systemd and is the only process with Docker access; it launches short-lived agent and check containers per ticket. Jira and Confluence stay read-only; nothing is pushed unless you enable it.

Status: these files are prepared and their configuration validates, but this server layout has **not yet been run end to end**. Try the [local pilot](local-pilot.md) first; it exercises the same images and supervisor.

## Layout

| Path | Owner / mode | Contents |
| --- | --- | --- |
| `/opt/autos` | `autos` | This repository (built), `config/config.yaml`, `.env` |
| `/opt/autos/{data,artifacts,workspaces}` | `autos`, 0700 | SQLite + supervisor socket, evidence, per-ticket Git workspaces |
| `/etc/autos/supervisor.env` | root, 0600 | Supervisor settings (`deploy/env/supervisor.env.example`) |
| `/etc/autos/auth/provider-profiles.json` (+ `codex-pilot/`) | `autos`, 0600 / 0700 | Provider logins (`config/provider-profiles.example.json`) |
| `/etc/autos/git/{askpass.sh,bitbucket-token}` | root 0755 / `autos` 0640 | Trusted Git credentials (`deploy/git/askpass.sh`) |
| `/var/lib/autos/m2-repository` | `autos` | Offline Maven repository for checks |

Credentials are split by trust: Atlassian and the operator token live with the controller; provider keys live only with the supervisor; the Bitbucket token is readable only by trusted Git in the controller. Agent containers receive just their own provider key.

## 1. Host

```sh
sudo apt-get install -y docker.io docker-compose-v2 git nodejs npm openjdk-17-jdk maven   # Node 22.20+ required
sudo useradd --system --create-home --shell /usr/sbin/nologin autos
sudo usermod -aG docker autos
sudo git clone <this repository> /opt/autos && sudo chown -R autos:autos /opt/autos
cd /opt/autos && sudo -u autos npm ci --ignore-scripts && sudo -u autos npm run build && sudo -u autos npm run check
sudo -u autos install -d -m 0700 /opt/autos/data /opt/autos/artifacts /opt/autos/workspaces
```

Membership of the `docker` group is root-equivalent; only the supervisor uses it. Use a Node 22.20+ package (for example NodeSource) if the distribution's Node is older.

## 2. Images and network

```sh
UIDS="--build-arg AUTOS_UID=$(id -u autos) --build-arg AUTOS_GID=$(id -g autos)"
sudo -u autos docker build $UIDS -f docker/worker/Dockerfile -t autos-worker:local .
sudo -u autos docker build -f docker/worker-providers/Dockerfile -t autos-worker-providers:local .
sudo -u autos docker build $UIDS -f docker/runner/Dockerfile -t autos-checks:local .
sudo -u autos docker network create -o com.docker.network.bridge.name=autos-egress0 autos-egress
sudo /opt/autos/deploy/firewall/autos-egress-firewall.sh
```

- **Images:** the UID build arguments give containers a real user entry for the `autos` account. The checks image ships Java 17 (`--build-arg JAVA_VERSION=21` for 21). Rebuild the images after updating the repository. Add an approved `cursor-agent` to `docker/worker-providers/Dockerfile` before assigning Cursor to any role.
- **Egress firewall:** agent containers need the internet to reach provider APIs. The firewall script blocks them from cloud metadata (`169.254.169.254`), private and VPN ranges. Re-apply it after every boot, for example with `iptables-persistent` or a systemd oneshot. It is not an allowlist; for that, route egress through a proxy that permits only the provider API hosts.
- **Provider keys:** prefer dedicated, spend-capped API keys for Autos.

## 3. Secrets

```sh
sudo install -d -m 0755 /etc/autos /etc/autos/git
sudo install -d -m 0700 -o autos -g autos /etc/autos/auth
sudo install -m 0600 deploy/env/supervisor.env.example /etc/autos/supervisor.env      # then edit
sudo install -m 0600 -o autos -g autos config/provider-profiles.example.json /etc/autos/auth/provider-profiles.json  # add logins
sudo -u autos install -d -m 0700 /etc/autos/auth/codex-pilot   # Codex ChatGPT login (see below)
sudo install -m 0755 deploy/git/askpass.sh /etc/autos/git/askpass.sh
sudo install -m 0640 -o root -g autos /dev/null /etc/autos/git/bitbucket-token     # paste the token into it
sudo -u autos install -m 0600 deploy/env/controller.env.example /opt/autos/.env    # then edit
```

- **Atlassian:** an API token for an account that can read the private filter and the branch-map page.
- **Bitbucket:** a repository or workspace access token with Repositories: Read (add Write only when enabling push).
- **Providers (team subscriptions):** fill the profile named by `auth_profile` exactly as in [local-pilot.md, Provider logins](local-pilot.md#provider-logins-on-your-team-subscriptions): a `claude setup-token` token, a Codex ChatGPT login in `/etc/autos/auth/codex-pilot/auth.json` (on a headless server use `sudo -u autos env CODEX_HOME=/etc/autos/auth/codex-pilot codex login --device-auth`, or copy an `auth.json` made on your Mac; `chmod 600` it), and a Cursor user API key. Keep `AUTOS_REQUIRE_SUBSCRIPTION=true` in `supervisor.env` so the supervisor refuses any API-key profile. For API keys or a local model use `config/provider-profiles.api.example.json` and set it to `false`.
- **UIDs:** set `AUTOS_CONTROLLER_UID/GID` in `.env` and `AUTOS_RUNNER_UID/GID` in `supervisor.env` to `id -u autos` / `id -g autos`.

## 4. Configuration

```sh
sudo -u autos cp config/server.template.yaml config/config.yaml   # replace every REPLACE_ME
sudo -u autos node --conditions=development --import tsx scripts/validate-config.ts config/config.yaml
```

The template starts safe: `jira.auto_poll: false` (the controller only runs tickets you submit), `push_feature_branch: false` and `jobs.max_parallel: 1`. Change them only after single-ticket runs have been reviewed.

## 5. Offline build dependencies

Checks have no network. Preload Maven dependencies once per repository (and after dependency changes):

```sh
sudo install -d -o autos -g autos /var/lib/autos/m2-repository
sudo -u autos git clone https://bitbucket.org/<workspace>/<repo>.git /tmp/autos-prefetch
cd /tmp/autos-prefetch && sudo -u autos git checkout <development-branch>
sudo -u autos mvn -B -Dmaven.repo.local=/var/lib/autos/m2-repository dependency:go-offline test-compile
cd / && sudo rm -rf /tmp/autos-prefetch
```

### Toolchains

Install the JDKs and Tomcats your branch map names into `/opt/autos/toolchains` (`AUTOS_TOOLCHAIN_ROOT`), as the `autos` user:

```sh
node --conditions=development --import tsx scripts/install-toolchains.ts --root /opt/autos/toolchains jdk 21 25
node --conditions=development --import tsx scripts/install-toolchains.ts --root /opt/autos/toolchains tomcat /path/to/apache-tomcat-11.0.24
```

JDKs are extracted for the server's own architecture, so install them on the server rather than copying them from a Mac. Copy Tomcat folders to the server first; the installer sanitizes them the same way as on the pilot Mac (see docs/local-pilot.md).

## 6. Start the services

```sh
sudo cp /opt/autos/deploy/systemd/autos-supervisor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now autos-supervisor
sudo systemctl status autos-supervisor            # "listening on /opt/autos/data/runner.sock"
cd /opt/autos && sudo -u autos docker compose up -d --build controller
sudo -u autos docker compose logs -f controller
```

The controller publishes its API only on `127.0.0.1:8787` and restarts automatically (`restart: unless-stopped`). The supervisor restarts on failure.

## 7. Verify, then run one ticket

With `auto_poll: false` the controller is running but idle. Run the CLI inside the controller container (it already has the config and operator token):

```sh
alias autos='sudo -u autos docker compose -f /opt/autos/docker-compose.yml exec controller node apps/cli/bin/autos.mjs'
autos doctor --deep               # supervisor, Docker images, Git token, Jira filter, branch map, remotes, disk
autos providers test --all        # Claude/Codex must PASS through real containers
autos run ABC-123 --dry-run       # must end PLANNED: routing and pinned base, no agents
autos run ABC-123                 # one low-risk bug; expect READY_FOR_HUMAN or a clear BLOCKED reason
```

Review the result (`artifacts/<jobId>/summary.md`, `changes.patch`, the branch in the workspace). When you are satisfied, set `jira.auto_poll: true` in `config/config.yaml` and `docker compose restart controller`. Each poll then admits at most `jira.max_new_per_poll` new tickets, so an existing backlog is worked through gradually.

## Operating

- **Watch:** `autos status`, `autos watch`, `autos events --job <id>`; or `ssh -L 8787:127.0.0.1:8787 <host>` and use the API with the bearer token.
- **Review:** each job's evidence is under `/opt/autos/artifacts/<jobId>/` and its branch under `/opt/autos/workspaces/<jobId>-*/`.
- **Request changes:** `autos revise <KEY|jobId> --note "…"` (an issue key revises its latest READY_FOR_HUMAN attempt).
- **Finish a ticket:** after you merge (or decide not to use) the branch, run `autos close <KEY> --merged` or `autos close <KEY> --abandoned` (`--dry-run` previews; `--note` is kept in `closure.json`). This removes every workspace of the issue, keeps its evidence, and refuses any later attempt, revision or retry for it. Autos does not verify the merge and does not touch Jira or Bitbucket; move the Jira status yourself. `autos show <KEY>` shows the closure and attempts.
- **Upgrade:** `git pull`, `npm ci --ignore-scripts && npm run build && npm run check`, rebuild the images, `sudo systemctl restart autos-supervisor`, `docker compose up -d --build controller`. Jobs interrupted by the restart are requeued automatically once.
- **Provider limits:** when every provider of a role is rate limited, the job is `PAUSED` (no slot held) and resumes by itself in the same workspace at the reported reset time or after a backoff (`jobs.rate_limit_pause`, default 15 min doubling to 4 h, blocked after 24 h). Paused jobs survive controller and supervisor restarts; `autos status` lists them and `autos jobs cancel <id>` stops one. Newer `develop` commits are never pulled into a running or paused job.
- **SWE scratch:** each job's SWE containers share `/opt/autos/artifacts/.scratch/swe-<jobId>` (warm build copy and Maven state) until the job ends, is cancelled or pruned; the supervisor deletes all scratch at startup. Budget disk for one build copy per active or paused ticket.
- **Infrastructure outages:** if the supervisor, Docker, Jira or Git is unavailable before an agent has started, the ticket is retried automatically with backoff (up to 5 times). `autos retry --all-blocked --code UPSTREAM` retries the rest in bulk.
- **Back up:**
  - Use `sqlite3 data/autos.sqlite ".backup /backup/autos.sqlite"`. A plain file copy of a live database can be inconsistent.
  - Back up `artifacts/` too.
  - With push disabled, a READY_FOR_HUMAN fix exists only as a local commit in its workspace, plus `artifacts/<jobId>/changes.patch`. Keep those until merged. Revisions also need the parent's workspace.
- **Disk:** the latest READY_FOR_HUMAN workspace of each open issue is kept until `autos close`. Workspaces of BLOCKED/CANCELLED attempts, superseded revisions and orphan directories are removed automatically after `jobs.workspace_retention_hours` (default 72, checked at most hourly; disable with `jobs.auto_prune_workspaces: false`). `autos workspaces --sizes` lists them with the decision for each; `autos workspaces prune --dry-run` previews a manual run. Artifacts are never removed automatically.
- **Logs:** `journalctl -u autos-supervisor` (one line per container action) and `docker compose logs controller` (one line per API request, no secrets; rotated at 5 × 10 MB).

## Known limitations

- The real Claude and Codex CLIs have not yet completed a ticket inside the worker image. `providers test --all` and the first dry run are the first real checks.
- Repositories using Git LFS or submodules are refused at preparation with a clear reason.
- Checks run offline. Builds that need network services, databases or `.git` metadata are not supported yet.
- Agents cannot edit instruction files (`AGENTS.md`, `CLAUDE.md`, rule files). A ticket that requires changing them is blocked for a human.
- Jira Cloud only, with a classic (unscoped) API token. Data Center and scoped tokens are not supported.
- Outbound traffic through a corporate HTTP proxy or TLS-inspecting CA is not configured.
