# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.22.1

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS build
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
# Clerk is optional on the public site: without VITE_CLERK_PUBLISHABLE_KEY the
# app builds with no auth (no header sign-in affordance). Vite inlines these at
# BUILD time, so they must be passed as build args here — setting them only in
# the container's runtime env has no effect on the already-built bundle.
ARG VITE_CLERK_PUBLISHABLE_KEY=
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
ARG VITE_AUTH_APP_URL=https://auth.unimatrix-01.dev
ENV VITE_AUTH_APP_URL=${VITE_AUTH_APP_URL}
COPY . .
RUN find . -name '*.tsbuildinfo' -delete && pnpm install --frozen-lockfile
RUN pnpm --filter @unimatrix/web build

FROM nginx:1.29-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
