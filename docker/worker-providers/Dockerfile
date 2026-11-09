# Pilot worker image: the reviewed autos-worker image plus the real provider CLIs.
# Build after autos-worker:local:
#   docker build -f docker/worker-providers/Dockerfile -t autos-worker-providers:local .
# Pin versions you have reviewed; bump deliberately. No credentials are baked in:
# the supervisor injects auth per provider at run time from the private profile file.
FROM autos-worker:local

ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=0.162.1
# Cursor CLI: NOT version-pinned. Cursor publishes no versioned/checksummed release for this installer, so this build
# downloads and EXECUTES a vendor shell script (and whatever it fetches) as root at build time. Review the script,
# rebuild deliberately, and record the resulting `agent --version`. Set INSTALL_CURSOR=false to build without Cursor.
ARG INSTALL_CURSOR=true
ARG CURSOR_INSTALL_URL=https://cursor.com/install

USER root
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && claude --version && codex --version

# The runtime HOME is a tmpfs, so install with a fixed build-time HOME (/opt/cursor) and expose the binary on PATH.
# The installer provides `agent` (legacy name `cursor-agent`); both names are symlinked for the adapter and for operators.
# curl is not in the base image: it is added for the installer only and purged again afterwards.
RUN if [ "${INSTALL_CURSOR}" = "true" ]; then \
      apt-get update \
 &&   apt-get install -y --no-install-recommends curl ca-certificates \
 &&   mkdir -p /opt/cursor \
 &&   HOME=/opt/cursor sh -c "curl -fsS '${CURSOR_INSTALL_URL}' | bash" \
 &&   BIN="$(ls /opt/cursor/.local/bin/agent /opt/cursor/.local/bin/cursor-agent 2>/dev/null | head -n 1)" \
 &&   test -n "$BIN" \
 &&   ln -sf "$(readlink -f "$BIN")" /usr/local/bin/agent \
 &&   ln -sf "$(readlink -f "$BIN")" /usr/local/bin/cursor-agent \
 &&   chmod -R a+rX /opt/cursor \
 &&   apt-get purge -y curl \
 &&   rm -rf /var/lib/apt/lists/* \
 &&   agent --version; \
    fi

# Back to the unprivileged worker user; the runner also forces --user, --read-only and --cap-drop ALL.
USER worker
