#!/usr/bin/env bash
# Start the trusted runner supervisor for a LOCAL pilot (controller running directly on this host).
# Usage (from the project root, in its own terminal):  scripts/pilot-supervisor.sh
# Reads .env (see .env.example), or the file named by AUTOS_SUPERVISOR_ENV_FILE (server: /etc/autos/supervisor.env). Only the supervisor talks to Docker; agent containers never see the socket.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

ENV_FILE="${AUTOS_SUPERVISOR_ENV_FILE:-.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi

fail() { echo "pilot-supervisor: $*" >&2; exit 1; }
for name in AUTOS_WORKER_IMAGE AUTOS_CHECKS_IMAGE AUTOS_PROVIDER_PROFILES_FILE; do
  [[ -n "${!name:-}" ]] || fail "$name is not set (copy .env.example to .env)"
done
# Empty optional values would otherwise reach the supervisor as "" (e.g. a blank UID becomes 0 and is rejected).
for name in AUTOS_RUNNER_UID AUTOS_RUNNER_GID AUTOS_CLIENT_ROOT AUTOS_MAVEN_CACHE_ROOT AUTOS_PROVIDER_NETWORK AUTOS_PROVIDER_NETWORK_APPROVED; do
  if [[ -z "${!name:-}" ]]; then unset "$name"; fi
done
if [[ -n "${AUTOS_RUNNER_UID:-}" && "${AUTOS_RUNNER_UID}" == "0" ]]; then fail "AUTOS_RUNNER_UID must be a non-root uid (id -u autos)"; fi
docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable (start Docker Desktop)"
for image in "$AUTOS_WORKER_IMAGE" "$AUTOS_CHECKS_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is missing (see docs/local-pilot.md step 2)"
done
[[ -f "$AUTOS_PROVIDER_PROFILES_FILE" ]] || fail "profile file $AUTOS_PROVIDER_PROFILES_FILE is missing"
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }   # GNU/Linux first, then BSD/macOS
[[ "$(file_mode "$AUTOS_PROVIDER_PROFILES_FILE")" == "600" ]] || fail "chmod 600 $AUTOS_PROVIDER_PROFILES_FILE (current mode: $(file_mode "$AUTOS_PROVIDER_PROFILES_FILE"))"
case "$(cd "$(dirname "$AUTOS_PROVIDER_PROFILES_FILE")" && pwd -P)" in
  "$ROOT"|"$ROOT"/*) fail "keep the provider profile file outside the project directory";;
esac
if [[ -n "${AUTOS_PROVIDER_NETWORK:-}" ]]; then
  docker network inspect "$AUTOS_PROVIDER_NETWORK" >/dev/null 2>&1 || fail "docker network create $AUTOS_PROVIDER_NETWORK"
fi
if [[ -n "${AUTOS_MAVEN_CACHE_ROOT:-}" ]]; then
  [[ -d "$AUTOS_MAVEN_CACHE_ROOT" ]] || fail "$AUTOS_MAVEN_CACHE_ROOT does not exist (see docs/local-pilot.md step 5)"
fi

mkdir -p data artifacts workspaces
chmod 700 data artifacts workspaces
[[ -d packages/runner/dist ]] || npm run build

export AUTOS_SUPERVISOR_SOCKET="$ROOT/data/runner.sock"
export AUTOS_WORKSPACE_ROOT="$ROOT/workspaces"
export AUTOS_PROMPT_ROOT="$ROOT/artifacts"
export AUTOS_OUTPUT_ROOT="$ROOT/artifacts"
# Local pilot: the controller runs on this host, so client and host paths are identical.
# Server: the controller runs in Compose and sees this directory as /app (set AUTOS_CLIENT_ROOT=/app).
export AUTOS_HOST_ROOT="$ROOT"
export AUTOS_CLIENT_ROOT="${AUTOS_CLIENT_ROOT:-$ROOT}"
rm -f "$AUTOS_SUPERVISOR_SOCKET"

echo "pilot-supervisor: listening on $AUTOS_SUPERVISOR_SOCKET (worker=$AUTOS_WORKER_IMAGE, network=${AUTOS_PROVIDER_NETWORK:-none})"
exec node docker/supervisor/start.mjs
