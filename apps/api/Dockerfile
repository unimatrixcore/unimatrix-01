# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.22.1

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config-eslint/package.json packages/config-eslint/package.json
COPY packages/config-typescript/package.json packages/config-typescript/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/api apps/api
COPY packages/config-eslint packages/config-eslint
COPY packages/config-typescript packages/config-typescript
COPY packages/shared packages/shared
RUN pnpm --filter @unimatrix/shared build
RUN pnpm --filter @unimatrix/api build
RUN pnpm --filter @unimatrix/api --prod deploy /prod/api

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV LOG_LEVEL=info
COPY --from=build --chown=node:node /prod/api/ ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
