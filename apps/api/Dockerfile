# syntax=docker/dockerfile:1.7
# GENERATED — edit apps/api/deploy.config.ts and run `node ./infra/scripts/generate-deploy-config.mjs`, not this file.

ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS prune
ARG TURBO_VERSION=2.10.7
RUN npm install -g turbo@$TURBO_VERSION
COPY . .
RUN turbo prune @unimatrix/api --docker

FROM base AS build
ENV UNIMATRIX_CONTAINER_BUILD=1
COPY infra/scripts/run-local-workload.mjs ./infra/scripts/run-local-workload.mjs
COPY --from=prune /workspace/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /workspace/out/full/ .
# Build this service together with its workspace dependencies, in
# topological order. It compiles with tsc and resolves them from their
# built dist (not source, unlike the Vite apps), so they must be built
# first; the "..." selector keeps this correct as the dependency set changes.
RUN pnpm --filter "@unimatrix/api..." build
RUN pnpm --filter @unimatrix/api --prod deploy --legacy /prod/app

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV LOG_LEVEL=info
# The SQLite database (user settings + files) lives under /data so it can be
# backed by a persistent volume — without one, all user data is lost on
# redeploy. Set DB_MIGRATE_ON_START=true (see api-compose.yaml) so pending
# migrations are applied against that volume at boot.
ENV DATABASE_URL=/data/unimatrix.sqlite
COPY --from=build --chown=node:node /prod/app/ ./
# Create each mount path owned by the non-root runtime user before the volumes
# mount, so a fresh named volume inherits node ownership and stays writable.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
