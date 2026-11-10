# Environment requirements

What has to be installed where before Autos can run on a new machine. Autos runs on two kinds of system: the **host**, where the controller, the supervisor and trusted Git code run; and the **Docker images**, where the agents and checks run. A tool missing in one of them is not fixed by installing it in the other. For example, the worker image once lacked `git`, so agents' `git status` failed even though the host had Git.

Versions marked "tested" are what the macOS pilot uses; older ones may work but are untried.

## Host

| Software | Why Autos needs it | Check |
| --- | --- | --- |
| **Node.js 22.20+** (`engines` in `package.json`) | Runs the controller, the CLI, the supervisor and the scripts. Tested: 22.20.0. | `node -v` |
| **npm** (ships with Node) | `npm ci --ignore-scripts && npm run build` | `npm -v` |
| **Docker** (Docker Desktop on macOS, Docker Engine on Linux) | The supervisor starts every agent and check container; `scripts/install-toolchains.ts` copies Linux JDKs out of images. Only the supervisor talks to Docker. Tested: 29.9.1. | `docker info` |
| **Git** | Trusted Git code (`packages/git-runner`) clones, fetches, commits and pushes on the host. Agents never get the host's Git or its credentials. Tested: 2.39.5. | `git --version` |
| **ssh and ssh-agent** with a key that Bitbucket accepts | Fetch and push of `deep/KEY` branches over `git@bitbucket.org`. | `ssh -T git@bitbucket.org` |
| **Maven 3.9** | One-time offline prefetch into `~/.autos/m2-repository` (`docs/local-pilot.md`, step 5). Checks and agents use the Maven in the images, not this one. Tested: 3.9.6. | `mvn -v` |
| **A JDK for each Java major the projects use** (for example 21 and 25) | Only for that prefetch: compile each branch with its own JDK (`JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn …`). The JDKs given to containers are separate Linux builds (next section). | `/usr/libexec/java_home -V` |
| **openssl** | Generating `AUTOS_OPERATOR_TOKEN` (`openssl rand -hex 24`). Any random 48-character hex string works. | `openssl version` |
| **devtunnel** (Teams bot only, `teams-integration` branch) | Exposes the loopback bot endpoint to Azure Bot Service (`docs/teams-bot.md`). Not needed for the Teams notification relay. | `devtunnel --version` |

Not needed on the host: the `claude`, `codex` and Cursor `agent` CLIs (they are installed in the provider worker image), Tomcat as a runtime (only a local install to copy from, see below), and any database client.

## Files and folders outside the repository

| Path | Contents | Created by |
| --- | --- | --- |
| `~/.autos/auth/provider-profiles.json` (mode 600) | Provider logins or API keys for agent containers | You, from `config/provider-profiles.example.json` |
| `~/.autos/m2-repository` | Offline Maven cache mounted read-only into checks and agents | The Maven prefetch |
| `~/.autos/toolchains` | Linux JDKs (and sanitized Tomcat copies) mounted read-only per project | `scripts/install-toolchains.ts jdk 21 25`, `… tomcat <path>` |
| `.env` and `config/config.yaml` in the repo (git-ignored) | Secrets and configuration | You, from `.env.example` and `config/pilot.template.yaml` |

`scripts/pilot-supervisor.sh` refuses to start when the images, the `autos-egress` network, the profile file, the Maven cache or the toolchain folder is missing. `autos doctor --deep` checks the rest, including that each project's JDK and Tomcat are installed.

## Docker images

Build them on every new machine (commands in `docs/local-pilot.md`, step 2). Rebuild the worker images whenever `packages/` or `docker/worker/` changes, then restart the supervisor.

| Image | What it contains | Notes |
| --- | --- | --- |
| `autos-worker:local` (`docker/worker/Dockerfile`) | Node 22, the adapters, **git** (read-only inspection), **Maven 3.9.11** (checksum-verified) | No JDK: the project's JDK is mounted at run time. `/workspace/.git` is read-only, so agents can run `git status`/`diff`/`log` but cannot commit; there is no ssh client and no credential. |
| `autos-worker-providers:local` (`docker/worker-providers/Dockerfile`) | The above plus the `claude`, `codex` and Cursor `agent` CLIs | Pin with `--build-arg CLAUDE_CODE_VERSION=…` / `CODEX_VERSION=…`. Cursor's installer is not version-pinned. |
| `autos-checks:local` (`docker/runner/Dockerfile`) | Maven with Eclipse Temurin (Java 17 by default) and Node | `--build-arg JAVA_VERSION=21` for Java 21 repositories. Checks run with no network. |

The Docker network `autos-egress` (`docker network create autos-egress`) gives agent containers outbound access to the provider APIs.

### Adding a tool agents need

If an agent reports `command not found` (exit code 127) for a tool, the tool is missing in the **worker image**, not on the host. Add it to `docker/worker/Dockerfile` with `apt-get install -y --no-install-recommends`, rebuild both worker images, and restart the supervisor. Agents only get commands their role allows (for example, the SWE Bash allow-list in `packages/cli-adapters`), so a new tool may also need adding there.

## Quick check on a new machine

```sh
node -v && npm -v && git --version && mvn -v | head -1 && docker info >/dev/null && echo docker ok
ssh -T git@bitbucket.org
docker image inspect autos-worker:local autos-worker-providers:local autos-checks:local >/dev/null && echo images ok
docker run --rm --entrypoint git autos-worker:local --version
docker network inspect autos-egress >/dev/null && echo network ok
ls ~/.autos/toolchains ~/.autos/m2-repository >/dev/null && echo autos folders ok
```
