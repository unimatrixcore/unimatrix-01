# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.22.1

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS build
COPY . .
RUN find . -name '*.tsbuildinfo' -delete && pnpm install --frozen-lockfile
# Build the API together with its workspace dependencies (@unimatrix/shared,
# @unimatrix/db, @unimatrix/auth) in topological order. apps/api compiles with
# tsc and resolves these from their built dist (not source, unlike the Vite
# apps), so they must be built first; the "..." selector keeps this correct as
# the dependency set changes.
RUN pnpm --filter "@unimatrix/api..." build
RUN pnpm --filter @unimatrix/api --prod deploy --legacy /prod/api

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
COPY --from=build --chown=node:node /prod/api/ ./
# Create /data owned by the non-root runtime user before the volume mounts, so
# a fresh named volume inherits node ownership and stays writable.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
