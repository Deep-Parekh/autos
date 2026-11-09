FROM autos-worker:local
# The base image ends as a non-root user, so set ownership/mode at copy time instead of a RUN chmod.
COPY --chown=root:root --chmod=0555 tests/fixtures/runner-fake-claude /usr/local/bin/claude
