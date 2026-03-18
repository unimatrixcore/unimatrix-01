# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.22.1

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/config-eslint/package.json packages/config-eslint/package.json
COPY packages/config-typescript/package.json packages/config-typescript/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY apps/web apps/web
COPY content content
COPY packages/api-client packages/api-client
COPY packages/config-eslint packages/config-eslint
COPY packages/config-typescript packages/config-typescript
COPY packages/content packages/content
COPY packages/shared packages/shared
COPY packages/ui packages/ui
RUN pnpm --filter @unimatrix/web build

FROM nginx:1.29-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
