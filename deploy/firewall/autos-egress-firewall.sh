#!/usr/bin/env bash
# Restrict agent containers on the autos-egress network to the public internet.
# Agent containers need provider APIs, but must not reach cloud instance metadata (credentials!), the host's
# private networks or VPN ranges. Rules go in Docker's DOCKER-USER chain, which Docker evaluates before its own.
#
# One-time network creation with a fixed bridge name (so rules can match it):
#   docker network create -o com.docker.network.bridge.name=autos-egress0 autos-egress
# Apply (idempotent) as root, and again after every boot (e.g. from a systemd oneshot or iptables-persistent):
#   sudo deploy/firewall/autos-egress-firewall.sh
# This is defence in depth, not an allowlist: containers can still reach any public host. For an allowlist,
# route egress through a proxy that permits only the provider API hosts.
set -euo pipefail
BRIDGE="${AUTOS_EGRESS_BRIDGE:-autos-egress0}"
BLOCKED=(169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8)
command -v iptables >/dev/null || { echo "iptables not found" >&2; exit 1; }
ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "bridge $BRIDGE not found; create the network as shown above" >&2; exit 1; }
iptables -L DOCKER-USER -n >/dev/null 2>&1 || iptables -N DOCKER-USER
for cidr in "${BLOCKED[@]}"; do
  iptables -C DOCKER-USER -i "$BRIDGE" -d "$cidr" -j REJECT 2>/dev/null || iptables -I DOCKER-USER -i "$BRIDGE" -d "$cidr" -j REJECT
done
if command -v ip6tables >/dev/null && ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
  for cidr in fe80::/10 fc00::/7 ::1/128; do
    ip6tables -C DOCKER-USER -i "$BRIDGE" -d "$cidr" -j REJECT 2>/dev/null || ip6tables -I DOCKER-USER -i "$BRIDGE" -d "$cidr" -j REJECT
  done
fi
echo "autos-egress firewall: private, link-local and metadata ranges blocked for $BRIDGE"
