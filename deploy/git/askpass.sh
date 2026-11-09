#!/bin/sh
# Git askpass helper for the trusted controller (https Bitbucket remotes).
# Install: /etc/autos/git/askpass.sh (0755, root-owned) next to /etc/autos/git/bitbucket-token (0640, readable by
# the controller's uid only). Git runs with a scrubbed environment, so the token is read from that file, never env.
# Use a Bitbucket repository/workspace access token with "Repositories: Read" (add "Write" only if you enable
# feature-branch push). Bitbucket access tokens authenticate with the fixed username x-token-auth.
case "$1" in
  Username*) printf '%s\n' 'x-token-auth' ;;
  Password*) cat "$(dirname "$0")/bitbucket-token" ;;
  *) exit 1 ;;
esac
