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
# Reference TLSH CLI. This build MUST fail loudly if tlsh doesn't end up
# runnable: the pipeline degrades silently without it (every fingerprint gets
# tlsh=null → 100% "novel", no lineage, dedup gate dead — bit us 2026-07-09).
RUN curl -fsSL https://github.com/trendmicro/tlsh/archive/refs/tags/4.12.0.tar.gz | tar xz -C /tmp \
  && cd /tmp/tlsh-4.12.0 \
  && (./make.sh || (mkdir -p build && cd build && cmake .. && make -j2)) \
  && BIN=$(find /tmp/tlsh-4.12.0 -type f -name tlsh_unittest -perm -u+x | head -1) \
  && if [ -z "$BIN" ]; then BIN=$(find /tmp/tlsh-4.12.0 -type f -name tlsh -perm -u+x | head -1); fi \
  && test -n "$BIN" \
  && cp "$BIN" /usr/local/bin/tlsh \
  && head -c 1024 /dev/urandom > /tmp/tlsh-selftest \
  && tlsh -f /tmp/tlsh-selftest | grep -qE '(T1)?[0-9A-Fa-f]{70}' \
  && rm -rf /tmp/tlsh-4.12.0 /tmp/tlsh-selftest
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
# Single-process live deployment: API + poller + cron, pipeline inline (no Redis).
CMD ["node", "apps/ingest/dist/live.js"]
