# Docker and Compose

Dokploy plus Traefik is the primary production target. The Dockerfiles and
Compose files here are the secondary, manual deployment path and the local
validation path for containerized builds.

## Generated — edit the config, not these files

Every `apps/*/Dockerfile` and every compose file in this directory is generated from
`apps/<app>/deploy.config.ts` by `infra/scripts/generate-deploy-config.mjs`. Edit the config and run
`node ./infra/scripts/generate-deploy-config.mjs` (or let the pre-commit hook do it), not the
generated file directly — `check:deploy-config` in `pnpm check`/`pnpm verify` reruns the generator in
`--check` mode and fails on drift. The one exception is each app's own `FROM` lines: the generator
reads those off the file already on disk and re-emits them verbatim, which is what lets a Dependabot
nginx digest bump land as a normal PR (see "Base image updates" below) without ever touching a
`deploy.config.ts` or reddening the drift check. `nginx.conf` is not generated at all.

## Monorepo build rules

Build every image (one per `apps/*/Dockerfile`) from the repo root, not from
an individual app directory.

Each app resolves workspace source aliases from its own `vite.config.ts` and
`tsconfig.json` and reads files outside its own directory, so an app-directory
build context cannot resolve them. `apps/api` and `apps/secrets` need the repo
root at runtime as well as at build time: the compiled output still imports
`@unimatrix/shared` by workspace name.

The checked-in images assume these repo-root build contexts:

```bash
docker build -f apps/web/Dockerfile .
docker build -f apps/api/Dockerfile .
docker build -f apps/cflop/Dockerfile .
docker build -f apps/auth/Dockerfile .
docker build -f apps/admin/Dockerfile .
docker build -f apps/deploy/Dockerfile .
docker build -f apps/secrets/Dockerfile .
```

## Web image

The web image builds `apps/web/dist` and serves it from a small internal Nginx
container. Nginx is only the static file server inside the container. It is not
the public edge proxy; Traefik stays the edge router in Dokploy.

### Web runtime contract

- container port: `8080`
- build artifact: `apps/web/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- build-time env: `VITE_API_BASE_URL`

This `VITE_*` value is compiled into the frontend bundle. Change it at image
build time, not after the container starts. The public site carries no Clerk
auth of its own — the CMS and its sign-in affordance moved to `apps/admin`.

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
- runtime env that has to be supplied: `TRUST_PROXY=<verified-proxy-IP>` behind
  a proxy (one IPv4 or IPv6 address; see `docs/deployment.md`), and
  `CORS_ALLOWED_ORIGINS` to override the built-in defaults (which include local
  development origins, so production logs a warning when it is unset).
  `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL` and `DATABASE_URL` have image
  defaults in `apps/api/Dockerfile`.

Optional runtime env: `MAX_UPLOAD_BYTES` (per-request file upload size limit
for the user-data file endpoints; defaults to 5 MiB),
`MAX_USER_STORAGE_BYTES` (cumulative per-user cap across documents and files
together; defaults to 50 MiB), plus the Clerk
variables (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY`),
required together in production.

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

## CFLOP image

The cflop image builds `apps/cflop/dist` and serves it from a
small internal Nginx container, same pattern as the web image. It has no
backend dependency: algorithm data is bundled at build time and per-case
learning progress lives in the browser's `localStorage`, so there is no
build-time or runtime env to configure.

### CFLOP runtime contract

- container port: `8080`
- build artifact: `apps/cflop/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- no build-time or runtime env required

Example build:

```bash
docker build \
  -f apps/cflop/Dockerfile \
  -t unimatrix-cflop:local \
  .
```

## Auth image

The auth image builds `apps/auth/dist` and serves it from a small internal
Nginx container, same pattern as the web and cflop images. It is the
central Clerk-backed accounts app (sign-in/sign-up and account management).

### Auth runtime contract

- container port: `8080`
- build artifact: `apps/auth/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- build-time env: `VITE_API_BASE_URL`, `VITE_CLERK_PUBLISHABLE_KEY`

`VITE_CLERK_PUBLISHABLE_KEY` is a public key and safe to ship in a browser
bundle. It defaults to the production Clerk instance's key (see
`apps/auth/deploy.config.ts`); pass `--build-arg` to target a different
Clerk instance.

Example build:

```bash
docker build \
  -f apps/auth/Dockerfile \
  --build-arg VITE_API_BASE_URL=http://localhost:3001 \
  --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx \
  -t unimatrix-auth:local \
  .
```

## Admin image

The admin image builds `apps/admin/dist` and serves it from a small internal
Nginx container, same pattern as the other SPA images. It is the operator
console behind Cloudflare Access; the container itself carries no secrets.

### Admin runtime contract

- container port: `8080`
- build artifact: `apps/admin/dist`
- required SPA fallback: unknown application routes must serve `index.html`
- build-time env: `VITE_API_BASE_URL`, `VITE_CLERK_PUBLISHABLE_KEY`; optional
  `VITE_AUTH_APP_URL` (sign-in redirect target, defaults to
  `https://auth.unimatrix-01.dev`)

`VITE_CLERK_PUBLISHABLE_KEY` defaults to the production Clerk instance's key
(see `apps/admin/deploy.config.ts`); pass `--build-arg` to target a different
Clerk instance. `loadAdminAppRuntimeConfig` still throws on an *empty* value,
so an explicit `--build-arg VITE_CLERK_PUBLISHABLE_KEY=` fails loudly rather
than rendering an admin console that can never sign anyone in.

Example build:

```bash
docker build \
  -f apps/admin/Dockerfile \
  --build-arg VITE_API_BASE_URL=http://localhost:3001 \
  --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx \
  -t unimatrix-admin:local \
  .
```

## Secrets service image

The secrets image builds `@unimatrix/shared`, compiles `apps/secrets`, then
uses `pnpm deploy` to package the runtime with production dependencies — the
same shape as the API image, but with its own Drizzle schema and SQLite file
rather than `@unimatrix/db`.

### Secrets service runtime contract

- entrypoint: `node dist/server.js`
- second in-container entry point: `node dist/cli/service-token.js` — token
  issuance, revocation and listing, run through `docker exec` against the
  mounted volume. The container never invokes it itself.
- container port: `3001`
- healthcheck path: `/health` — the only route that answers without a bearer
  service token
- runtime env that has to be supplied: `SECRETS_KEKS` — the service refuses to
  start without it. `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL` and
  `SECRETS_DATABASE_URL` (default `/data/secrets.sqlite`) have image defaults
  in `apps/secrets/Dockerfile`; `DB_MIGRATE_ON_START` defaults to `"true"` in
  `secrets-compose.yaml`.
- **no domain**: this service is deliberately unrouted — see `docs/deployment.md`.

Example build:

```bash
docker build -f apps/secrets/Dockerfile -t unimatrix-secrets:local .
```

Example run:

```bash
docker run --rm -p 3002:3001 -e SECRETS_KEKS="1:$(openssl rand -base64 32)" unimatrix-secrets:local
```

## Deploy service image

The deploy image builds `@unimatrix/shared`, compiles `apps/deploy`, then uses
`pnpm deploy` to package the runtime with production dependencies — the same
shape as the API and secrets images, but with no database and no volume. It
holds a typed Dokploy API client and performs no reconciliation and no
probing; see `apps/deploy/README.md` for what still has to happen by hand
before this stack deploys.

### Deploy service runtime contract

- entrypoint: `node dist/server.js`
- container port: `3001`
- healthcheck path: `/health` — the only route this service answers
- runtime env that has to be supplied: `DOKPLOY_BASE_URL` and
  `DOKPLOY_API_KEY` — the service refuses to start without either.
  `NODE_ENV`, `HOST`, `PORT` and `LOG_LEVEL` have image defaults in
  `apps/deploy/Dockerfile`.
- **no domain**: this service is deliberately unrouted, same as the secrets
  service — see `docs/deployment.md`.

Example build:

```bash
docker build -f apps/deploy/Dockerfile -t unimatrix-deploy:local .
```

Example run:

```bash
docker run --rm -p 3004:3001 \
  -e DOKPLOY_BASE_URL=http://localhost:3000 \
  -e DOKPLOY_API_KEY=<your-key> \
  unimatrix-deploy:local
```

## Compose workflow

Every `infra/docker/*-compose.yaml` file is a single-service file, one per
`apps/*/Dockerfile`. Each declares `image:` and no `build:`, so they pull
`ghcr.io/unimatrixcore/unimatrix-<app>:$IMAGE_TAG` from GHCR — they validate a
published image, never the working tree. Run them together from the repo root:

```bash
IMAGE_TAG=main \
CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
SECRETS_KEKS="1:<base64-32-bytes>" \
DOKPLOY_BASE_URL=http://localhost:3000 \
DOKPLOY_API_KEY=<your-key> \
docker compose \
  -f infra/docker/api-compose.yaml \
  -f infra/docker/web-compose.yaml \
  -f infra/docker/cflop-compose.yaml \
  -f infra/docker/auth-compose.yaml \
  -f infra/docker/admin-compose.yaml \
  -f infra/docker/deploy-compose.yaml \
  -f infra/docker/secrets-compose.yaml \
  up -d
```

`IMAGE_TAG` has no default: unset, it resolves to an empty string and the pull
fails with `invalid reference format` rather than starting something arbitrary.
The four SPA variables (`VITE_*`) are absent from these files on purpose —
they are inlined into a bundle at build time, so only a rebuild changes them.
To exercise a working-tree change, build it with the `docker build` lines
below.

None of the files publish host ports. That is intentional: the same files run
unmodified as Dokploy Compose apps, where Dokploy's Domains page owns port
exposure instead of a `ports:` block. Because of that, `curl`/browser checks
against `localhost` need containers run directly instead of through compose:

```bash
docker build -f apps/api/Dockerfile -t unimatrix-api:local .
docker run --rm -p 3001:3001 -e CORS_ALLOWED_ORIGINS=http://localhost:8080 unimatrix-api:local

docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=http://localhost:3001 -t unimatrix-web:local .
docker run --rm -p 8080:8080 unimatrix-web:local

docker build -f apps/cflop/Dockerfile -t unimatrix-cflop:local .
docker run --rm -p 8081:8080 unimatrix-cflop:local

docker build -f apps/auth/Dockerfile --build-arg VITE_API_BASE_URL=http://localhost:3001 --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx -t unimatrix-auth:local .
docker run --rm -p 8082:8080 unimatrix-auth:local

docker build -f apps/admin/Dockerfile --build-arg VITE_API_BASE_URL=http://localhost:3001 --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx --build-arg VITE_AUTH_APP_URL=http://localhost:8082 -t unimatrix-admin:local .
docker run --rm -p 8083:8080 unimatrix-admin:local
```

## Verification

After startup, verify:

```bash
curl http://localhost:3001/health
curl -I http://localhost:8080/
curl -I http://localhost:8081/
curl -I http://localhost:8082/
curl -I http://localhost:8083/
```

Then confirm a deep route in each SPA renders after both a normal navigation
and a refresh — that is what exercises the nginx `index.html` fallback.

## Database posture

Two services store data in SQLite, each on its own volume — `apps/api` through
`@unimatrix/db`, `apps/secrets` through its own Drizzle schema
(`apps/secrets/src/db`). The container workflow persists both:

- **SQLite volumes**: the API Dockerfile defaults `DATABASE_URL` to
  `/data/unimatrix.sqlite` (`api-compose.yaml` mounts `api-data` there); the
  secrets Dockerfile defaults `SECRETS_DATABASE_URL` to `/data/secrets.sqlite`
  (`secrets-compose.yaml` mounts `secrets-data` there). Both Dockerfiles create
  `/data` owned by the non-root `node` user, so data survives container
  recreation once each volume is mapped to durable host storage.
- **Migrations**: both compose files set `DB_MIGRATE_ON_START=true`, so each
  service applies its own pending Drizzle migrations against its volume at
  startup (idempotent — a no-op when the schema is current). No separate
  migration service or one-off command is required in this workflow.

Remaining caveat: SQLite is single-writer, so each shape assumes a single
instance of its service. Horizontal scaling would need a different database or
a shared storage strategy.

## Dokploy Compose deployment

Every `infra/docker/*-compose.yaml` file is a single-service compose file meant to be used as
Dokploy's "Compose" application type, one Dokploy app per file. They intentionally have:

- no `ports:` host publishing
- no Traefik labels

Dokploy's own Domains page handles routing: pick the service and the
container port (`8080` for web, `3001` for api, `8080` for cflop,
`8080` for auth, `8080` for admin) there, and Dokploy wires Traefik itself. Don't hand-add
Traefik labels to these files. Point the cflop Dokploy app's domain at
`cflop.unimatrix-01.dev` (plus `cube.unimatrix-01.dev` as a redirect-only entry —
see `docs/deployment.md`), the auth Dokploy app's domain at
`auth.unimatrix-01.dev`, and the admin Dokploy app's domain at
`admin.unimatrix-01.dev`. The secrets Dokploy app gets no Domains entry at all — it is
deliberately unrouted, which also keeps it off the shared `dokploy-network`, since Dokploy
attaches a stack to that overlay when Traefik has to reach it. Neither fact is what makes the
service private: a service token is. See `docs/deployment.md`'s "Secrets service" section.
The deploy Dokploy app also gets no Domains entry, but it does join `dokploy-network` — it exists
to call Dokploy's own API over that network, not to be reached across it. See
`apps/deploy/AGENTS.md`.

Every `node-api` compose file (`api-compose.yaml`, `secrets-compose.yaml`, `deploy-compose.yaml`)
carries an `environment:` block; the SPA compose files do not. The `${...}` entries in it come from
compose variable substitution — set those in the Dokploy app's environment variables UI rather than
editing the file. The literals beside them (`HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL` and the rest)
are fixed by the file, and a Dokploy variable of the same name does not override one. The SPA
stacks have no block at all: their `VITE_*` values are inlined into the bundle when the image is
built, so a Dokploy variable would reach nothing. Every stack reads `IMAGE_TAG` for the tag it
pulls; see `docs/deployment.md`.

Previews cannot be enabled on these apps — Dokploy supports them only on
Application-type services. See `docs/deployment.md` for the full
Dokploy service setup, including how previews are configured instead.

## Base image updates

Dependabot watches base images through the `docker` ecosystem, pointed at each
`apps/*` directory carrying a Dockerfile (`.github/dependabot.yml`'s `directories:` list) — **not**
at this one. The `image:` line in every
compose file here names this repository's own published app image, built by its
own CI from the `apps/*` Dockerfile Dependabot already watches. There is no
upstream version for a `docker-compose` block to bump, and pointing one here
would only propose tags for images this repo publishes. Don't add one.

Two consequences worth knowing before treating a quiet Dependabot as "nothing
to update":

- Only the `nginx` base-image pins are tracked. Every
  `FROM node:${NODE_VERSION}-alpine` is invisible: Dependabot does no ARG
  interpolation and its tag regex cannot match a leading `$`. That is
  deliberate — the Node version stays owned by `.node-version` and CI's
  `node-version-file` rather than gaining a second, competing owner.
- Base-image PRs auto-merge on the same terms as any other minor/patch: the
  required `Images` checks build every `apps/*/Dockerfile`.

That auto-merge is why base images are not a field in `deploy.config.ts` (see "Generated" above).
`dockerfileFor()` takes the `FROM` lines as an explicit argument and re-emits them verbatim instead
of deriving them, so a Dependabot digest bump touches only the Dockerfile it already targets. If the
digest were config-owned instead, every such PR would need a second commit syncing the config back —
and `.github/workflows/dependabot-auto-merge.yml` forbids exactly that: no checkout step and no PAT,
so nothing in that workflow could make the sync-back commit even if it wanted to.
