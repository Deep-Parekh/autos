FROM node:22-bookworm-slim
# Build with the host autos user's ids so bind mounts are writable and getpwuid works:
#   --build-arg AUTOS_UID=$(id -u autos) --build-arg AUTOS_GID=$(id -g autos)
ARG AUTOS_UID=10001
ARG AUTOS_GID=10001
WORKDIR /opt/autos
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY tsconfig*.json ./
RUN npm ci --include=dev --ignore-scripts
COPY docker/worker/entrypoint.mjs docker/worker/entrypoint.mjs
RUN npx tsc -b packages/cli-adapters && npm prune --omit=dev \
 && groupadd -o --gid "${AUTOS_GID}" worker \
 && useradd -o --uid "${AUTOS_UID}" --gid "${AUTOS_GID}" --home-dir /home/worker --create-home --shell /usr/sbin/nologin worker \
 && chown -R root:root /opt/autos && chmod -R a-w /opt/autos
ENV NODE_ENV=production
USER ${AUTOS_UID}:${AUTOS_GID}
ENV HOME=/home/worker
ENTRYPOINT ["node", "/opt/autos/docker/worker/entrypoint.mjs"]
