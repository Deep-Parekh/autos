FROM node:22-bookworm-slim
# Trusted Git operations (fetch, commit, optional feature push) run in the controller: it needs git, TLS roots
# for https remotes and an SSH client for git@ remotes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY tsconfig*.json ./
RUN npm ci --include=dev --ignore-scripts && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
COPY config/config.example.yaml /app/config/config.example.yaml
COPY docs/openapi.yaml /app/docs/openapi.yaml
USER node
EXPOSE 8787
CMD ["node", "apps/cli/bin/autos.mjs", "--config", "/app/config/config.yaml", "controller", "start"]
