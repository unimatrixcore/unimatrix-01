# syntax=docker/dockerfile:1.7
# GENERATED — edit apps/cflop/deploy.config.ts and run `node ./infra/scripts/generate-deploy-config.mjs`, not this file.

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
RUN turbo prune @unimatrix/cflop --docker

FROM base AS build
COPY --from=prune /workspace/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /workspace/out/full/ .
RUN pnpm --filter @unimatrix/cflop build

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:d9083fe47768377ef55dedafd67d4da7c2f2bc2bece7554954f29359deb0dce9 AS runtime
COPY apps/cflop/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/cflop/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
