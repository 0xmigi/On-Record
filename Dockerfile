# API + worker image. Includes git (verified-update diffs) and the reference
# TLSH CLI (bytecode similarity hashing, spec §4.1).
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/enrich/package.json packages/enrich/
COPY apps/ingest/package.json apps/ingest/
RUN pnpm install --frozen-lockfile=false --filter '!@onrecord/web'
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingest ./apps/ingest
RUN pnpm --filter '!@onrecord/web' -r build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates cmake g++ make curl \
  && rm -rf /var/lib/apt/lists/*
# reference TLSH CLI
RUN curl -fsSL https://github.com/trendmicro/tlsh/archive/refs/tags/4.12.0.tar.gz | tar xz -C /tmp \
  && cd /tmp/tlsh-4.12.0 && ./make.sh >/dev/null 2>&1 || (mkdir -p build && cd build && cmake .. && make -j2) \
  && (cp /tmp/tlsh-4.12.0/bin/tlsh* /usr/local/bin/tlsh || cp /tmp/tlsh-4.12.0/build/tlsh/tools/tlsh_unittest/tlsh /usr/local/bin/tlsh || true) \
  && rm -rf /tmp/tlsh-4.12.0
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
# Single-process live deployment: API + poller + cron, pipeline inline (no Redis).
CMD ["node", "apps/ingest/dist/live.js"]
