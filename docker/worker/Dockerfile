FROM node:22-bookworm-slim
# Build with the host autos user's ids so bind mounts are writable and getpwuid works:
#   --build-arg AUTOS_UID=$(id -u autos) --build-arg AUTOS_GID=$(id -g autos)
ARG AUTOS_UID=10001
ARG AUTOS_GID=10001
# Apache Maven for toolchain roles. The JDK is NOT in this image: it is mounted read-only per project (JAVA_HOME), so
# `mvn` is only usable when a toolchain is mounted. The archive checksum is verified before extraction.
ARG MAVEN_VERSION=3.9.11
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o /tmp/maven.tar.gz "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
 && curl -fsSL -o /tmp/maven.tar.gz.sha512 "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz.sha512" \
 && echo "$(cut -d' ' -f1 /tmp/maven.tar.gz.sha512)  /tmp/maven.tar.gz" | sha512sum -c - \
 && mkdir -p /opt/maven && tar -xzf /tmp/maven.tar.gz -C /opt/maven --strip-components=1 \
 && rm -f /tmp/maven.tar.gz /tmp/maven.tar.gz.sha512 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && chmod -R a-w /opt/maven
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
