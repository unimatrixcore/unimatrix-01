# Docker and Compose

This directory documents the repo-owned container workflow for the current live
surface:

- `apps/web` as a static Vite SPA image
- `apps/api` as a Fastify Node runtime image
- `apps/cube-trainer` as a static Vite SPA image

Dokploy plus Traefik is the primary production target for now. The Docker and
Compose files here are the secondary, manual deployment path and the local
validation path for containerized builds.

## Files

- `apps/web/Dockerfile`: multi-stage web image build
- `apps/web/nginx.conf`: static file server config with SPA fallback
- `apps/api/Dockerfile`: multi-stage API image build
- `apps/cube-trainer/Dockerfile`: multi-stage cube-trainer image build
- `apps/cube-trainer/nginx.conf`: static file server config with SPA fallback
- `infra/docker/web-compose.yaml`: single-service `web` stack, used both for
  local validation and as a Dokploy Compose deployment
- `infra/docker/api-compose.yaml`: single-service `api` stack, used both for
  local validation and as a Dokploy Compose deployment
- `infra/docker/cube-trainer-compose.yaml`: single-service `cube-trainer`
  stack, used both for local validation and as a Dokploy Compose deployment
- `.dockerignore`: root build hygiene for repo-root Docker contexts

## Monorepo build rules

Build all three images from the repo root, not from an individual app
directory.

That is required because:

- `apps/web` resolves workspace source aliases from `apps/web/vite.config.ts`
  and `apps/web/tsconfig.json`
- `apps/web` imports public markdown directly from `content/`
- `apps/api` depends on `@unimatrix/shared`, and the compiled API still imports
  that package by workspace name at runtime
- `apps/cube-trainer` resolves its `@unimatrix/ui` workspace source alias from
  `apps/cube-trainer/vite.config.ts` and `apps/cube-trainer/tsconfig.json`

The checked-in images assume these repo-root build contexts:

```bash
docker build -f apps/web/Dockerfile .
docker build -f apps/api/Dockerfile .
docker build -f apps/cube-trainer/Dockerfile .
```

## Web image

The web image builds `apps/web/dist` and serves it from a small internal Nginx
container. Nginx is only the static file server inside the container. It is not
the public edge proxy; Traefik stays the edge router in Dokploy.

### Web build inputs

- `apps/web`
- `packages/ui`
- `packages/api-client`
- `packages/shared`
- `packages/content`
- `content/`
- root workspace metadata such as `package.json`, `pnpm-lock.yaml`, and
  `pnpm-workspace.yaml`

### Web runtime contract

- container port: `8080`
- build artifact: `apps/web/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- build-time env: `VITE_API_BASE_URL`

`VITE_API_BASE_URL` is compiled into the frontend bundle. Change it at image
build time, not after the container starts.

Example build:

```bash
docker build \
  -f apps/web/Dockerfile \
  --build-arg VITE_API_BASE_URL=http://localhost:3001 \
  -t unimatrix-web:local \
  .
```

## API image

The API image builds `@unimatrix/shared`, compiles `apps/api`, then uses
`pnpm deploy` to package the runtime with production dependencies.

### API runtime contract

- entrypoint: `node dist/server.js`
- container port: `3001`
- healthcheck path: `/health`
- required runtime env:
  - `HOST`
  - `PORT`
  - `NODE_ENV`
  - `LOG_LEVEL`
  - `TRUST_PROXY`
  - `CORS_ALLOWED_ORIGINS`

The image defaults `HOST=0.0.0.0`, `PORT=3001`, and `NODE_ENV=production`.

Example build:

```bash
docker build -f apps/api/Dockerfile -t unimatrix-api:local .
```

Example run:

```bash
docker run --rm -p 3001:3001 \
  -e CORS_ALLOWED_ORIGINS=http://localhost:8080 \
  unimatrix-api:local
```

## Cube Trainer image

The cube-trainer image builds `apps/cube-trainer/dist` and serves it from a
small internal Nginx container, same pattern as the web image. It has no
backend dependency: algorithm data is bundled at build time and per-case
learning progress lives in the browser's `localStorage`, so there is no
build-time or runtime env to configure.

### Cube Trainer build inputs

- `apps/cube-trainer`
- `packages/ui`
- root workspace metadata such as `package.json`, `pnpm-lock.yaml`, and
  `pnpm-workspace.yaml`

### Cube Trainer runtime contract

- container port: `8080`
- build artifact: `apps/cube-trainer/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- no build-time or runtime env required

Example build:

```bash
docker build \
  -f apps/cube-trainer/Dockerfile \
  -t unimatrix-cube-trainer:local \
  .
```

## Compose workflow

`infra/docker/web-compose.yaml`, `infra/docker/api-compose.yaml`, and
`infra/docker/cube-trainer-compose.yaml` are each single-service files. Run
them together from the repo root for local combined validation:

```bash
VITE_API_BASE_URL=http://localhost:3001 \
CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
docker compose \
  -f infra/docker/api-compose.yaml \
  -f infra/docker/web-compose.yaml \
  -f infra/docker/cube-trainer-compose.yaml \
  up --build
```

None of the files publish host ports. That is intentional: the same files run
unmodified as Dokploy Compose apps, where Dokploy's Domains page owns port
exposure instead of a `ports:` block. Because of that, `curl`/browser checks
against `localhost` need containers run directly instead of through compose:

```bash
docker build -f apps/api/Dockerfile -t unimatrix-api:local .
docker run --rm -p 3001:3001 -e CORS_ALLOWED_ORIGINS=http://localhost:8080 unimatrix-api:local

docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=http://localhost:3001 -t unimatrix-web:local .
docker run --rm -p 8080:8080 unimatrix-web:local

docker build -f apps/cube-trainer/Dockerfile -t unimatrix-cube-trainer:local .
docker run --rm -p 8081:8080 unimatrix-cube-trainer:local
```

To stop the compose stack:

```bash
docker compose \
  -f infra/docker/api-compose.yaml \
  -f infra/docker/web-compose.yaml \
  -f infra/docker/cube-trainer-compose.yaml \
  down
```

## Verification

After startup, verify:

```bash
curl http://localhost:3001/health
curl -I http://localhost:8080/
curl -I http://localhost:8081/
```

Then open these web routes in a browser and confirm they render after both a
normal navigation and a refresh:

- `/`
- `/about`
- `/blog`
- `/projects`

And these cube-trainer routes:

- `/`
- `/oll`
- `/pll`

## Current database posture

The current API implementation does not import `@unimatrix/db`, so this first
container workflow does not add:

- SQLite volumes
- migration services
- Compose database setup

If future API work adopts `@unimatrix/db`, update this directory to document:

- a persistent volume for the SQLite database file
- a one-off migration command or service
- the single-writer caveat of SQLite for multi-instance deployments

## Dokploy Compose deployment

`infra/docker/web-compose.yaml`, `infra/docker/api-compose.yaml`, and
`infra/docker/cube-trainer-compose.yaml` are single-service compose files
meant to be used as Dokploy's "Compose" application type, one Dokploy app per
file. They intentionally have:

- no `ports:` host publishing
- no Traefik labels

Dokploy's own Domains page handles routing: pick the service and the
container port (`8080` for web, `3001` for api, `8080` for cube-trainer)
there, and Dokploy wires Traefik itself. Don't hand-add Traefik labels to
these files. Point the cube-trainer Dokploy app's domain at
`cube.unimatrix-01.dev`.

`web-compose.yaml` and `api-compose.yaml` read their environment-dependent
values (`VITE_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`) from compose variable
substitution, so set those in the Dokploy app's environment variables UI
rather than editing the file. `cube-trainer-compose.yaml` has no
environment-dependent values to set.

See `infra/deployment/README.md` for the full Dokploy service setup.

## Relationship to production deployment docs

- `infra/docker/README.md`: repo-owned Dockerfiles, Compose, and manual
  container workflow
- `infra/deployment/README.md`: Dokploy plus Traefik production deployment
  guidance
