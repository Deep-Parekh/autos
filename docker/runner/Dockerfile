ARG JAVA_VERSION=17
# Build with the host autos user's ids so bind mounts are readable and getpwuid works:
#   --build-arg AUTOS_UID=$(id -u autos) --build-arg AUTOS_GID=$(id -g autos)
ARG AUTOS_UID=10001
ARG AUTOS_GID=10001
FROM node:22-bookworm-slim AS node-runtime
FROM maven:3.9-eclipse-temurin-${JAVA_VERSION}
ARG AUTOS_UID
ARG AUTOS_GID
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY docker/runner/check.mjs /opt/autos/runner/check.mjs
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && git --version \
 && groupadd -o --gid "${AUTOS_GID}" runner \
 && useradd -o --uid "${AUTOS_UID}" --gid "${AUTOS_GID}" --home-dir /home/worker --create-home --shell /usr/sbin/nologin runner \
 && chown -R root:root /opt/autos && chmod -R a-w /opt/autos
USER ${AUTOS_UID}:${AUTOS_GID}
ENTRYPOINT ["node", "/opt/autos/runner/check.mjs"]
