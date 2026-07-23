# Deployment

Dokploy plus Traefik is the primary production deployment target for the
current runtime surface. The repo-owned Dockerfiles and Compose workflow live
under `infra/docker/`; this document covers how those artifacts map onto a
production deployment.

## Build artifacts

- Web static output: `apps/web/dist/`
- API Node runtime entry: `apps/api/dist/server.js`
- Cube Trainer static output: `apps/cube-trainer/dist/`
- Auth app static output: `apps/auth/dist/`

`vite preview` is useful for local smoke testing of the built web app, but it
is not the production web server for `apps/web/dist/`,
`apps/cube-trainer/dist/`, or `apps/auth/dist/`.

## Default production topology

The default production shape is separate-origin:

- `https://site.example.com` -> web
- `https://api.example.com` -> api
- `https://cube.unimatrix-01.dev` -> cube-trainer
- `https://auth.unimatrix-01.dev` -> auth

In this shape:

- the web image is built with `VITE_API_BASE_URL=https://api.example.com`
- the API runtime allows the public web origin through `CORS_ALLOWED_ORIGINS`
- the cube-trainer image needs no build-time or runtime env; it has no API
  dependency
- the auth image is built with `VITE_API_BASE_URL=https://api.example.com` and
  `VITE_CLERK_PUBLISHABLE_KEY` for the shared Clerk application
- Traefik owns TLS termination and hostname routing

Same-origin deployment remains supported, but it is not the primary documented
path for now.

## Dokploy service layout

Create four Dokploy services from the same repository and the same `main`
branch, all using Dokploy's **Compose** application type (not the plain
Dockerfile application type).

### Web service

- application type: Compose
- compose path: `infra/docker/web-compose.yaml`
- environment variable (set in Dokploy's UI, not in the file):
  `VITE_API_BASE_URL=https://api.example.com`
- Domains page: route `site.example.com` to the `web` service, container port
  `8080`

The web container is a static SPA container. Preserve SPA fallback behavior
inside the web container regardless of routing.

### API service

- application type: Compose
- compose path: `infra/docker/api-compose.yaml`
- Domains page: route `api.example.com` to the `api` service, container port
  `3001`
- health endpoint: `/health`

Required environment variable (set in Dokploy's UI):

```env
CORS_ALLOWED_ORIGINS=https://site.example.com,https://www.site.example.com
```

`HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, and `TRUST_PROXY=1` are already fixed
in `infra/docker/api-compose.yaml` for this deployment shape and don't need to
be set again in Dokploy.

**Persistent storage:** user settings and uploaded files are stored in SQLite,
so the API needs a durable volume or all user data is lost on redeploy.
`api-compose.yaml` already declares an `api-data` volume mounted at `/data`
(where the DB defaults to `/data/unimatrix.sqlite`) and sets
`DB_MIGRATE_ON_START=true`, so pending migrations are applied against that
volume automatically at container startup — no manual `db:migrate` step is
required in production. In Dokploy, confirm the volume is attached and mapped to
persistent host storage (Advanced → Volumes) so it survives redeploys.

Clerk auth is required in production: set `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_KEY` in Dokploy's UI (all three, never
just some). See "Clerk setup" below.

### Cube Trainer service

- application type: Compose
- compose path: `infra/docker/cube-trainer-compose.yaml`
- no environment variables required
- Domains page: route `cube.unimatrix-01.dev` to the `cube-trainer` service,
  container port `8080`

The cube-trainer container is a static SPA container, same shape as the web
service. Preserve SPA fallback behavior inside the container regardless of
routing. It has no API dependency, so it does not need an entry in
`CORS_ALLOWED_ORIGINS`.

### Auth service

- application type: Compose
- compose path: `infra/docker/auth-compose.yaml`
- environment variables (set in Dokploy's UI, not in the file):
  `VITE_API_BASE_URL=https://api.example.com`,
  `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`
- Domains page: route `auth.unimatrix-01.dev` to the `auth` service,
  container port `8080`

The auth container is a static SPA container, same shape as the web and
cube-trainer services. Preserve SPA fallback behavior inside the container
regardless of routing. It is the central Clerk-backed accounts app (landing,
sign-in/sign-up, account management, and the permission admin panel), so it
needs `CORS_ALLOWED_ORIGINS` on the API service to include
`https://auth.unimatrix-01.dev` if it calls the API directly from the browser.

## Traefik expectations

Traefik is the public edge proxy in Dokploy, and Dokploy's Domains page is the
source of truth for routing — it configures Traefik itself once you point a
service at a hostname and container port there. The repo does not ship
Traefik labels or a Traefik stack, and the compose files intentionally leave
Traefik config out for this reason.

Production routing still needs to satisfy:

- the public site hostname routes to the web service
- the API hostname routes to the API service
- the `cube.unimatrix-01.dev` hostname routes to the cube-trainer service
- the `auth.unimatrix-01.dev` hostname routes to the auth service
- TLS terminates at Traefik
- standard proxy headers are forwarded so the API can run with
  `TRUST_PROXY=1`

Because separate-origin is the default deployment shape, Traefik does not need
to rewrite `/api` paths in the primary production setup.

## Web configuration

- `apps/web/.env.production.example` shows the checked-in separate-origin
  example: `https://api.unimatrix-01.dev`
- if `omnimatrix.dev` becomes the public hostname later, replace that example
  with the new public API origin
- same-origin deployments can keep the default relative `/api` value, but that
  path is secondary to the separate-origin deployment described here

## Clerk setup

Clerk is a single shared application across every Unimatrix service, with
primary domain `unimatrix-01.dev`. Sessions are shared across all subdomains
(`auth.`, `api.`, `cube.`, and the apex), so **no satellite domains are
needed**.

A human needs to do the following once in the Clerk Dashboard:

1. Under **Configure → Sessions → "Customize session token"**, add a claim
   `"permissions": "{{user.public_metadata.permissions}}"` so the API can
   verify permissions networklessly from the session token.
2. Set the backend env (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
   `CLERK_JWT_KEY`) on the API service, and the frontend env
   (`VITE_CLERK_PUBLISHABLE_KEY`) on the web and auth services.
3. Bootstrap the first platform administrator by setting that user's
   `publicMetadata` to `{ "permissions": { "auth": ["admin"] } }` directly in
   the Dashboard — there is no public "become admin" flow.

See `packages/auth/README.md` for the exact steps and the full permission
scheme.

## API configuration

- Start the compiled runtime with `node apps/api/dist/server.js`
- `CORS_ALLOWED_ORIGINS` accepts a comma-separated list of exact origins such
  as `https://site.example.com` and wildcard subdomain origins such as
  `https://*.example.com`
- wildcard rules match subdomains only; they do not match the apex domain, so
  the apex must also be listed explicitly
- if `CORS_ALLOWED_ORIGINS` is unset, the API uses repo defaults:
  - `https://unimatrix-01.dev`
  - `https://*.unimatrix-01.dev`
  - `https://omnimatrix.dev`
  - `https://*.omnimatrix.dev`
  - `http://localhost:5173`
  - `http://127.0.0.1:5173`
  - `http://localhost:4173`
  - `http://127.0.0.1:4173`
- if `CORS_ALLOWED_ORIGINS` is set, it fully replaces those defaults
- API CORS stays intentionally narrow: no credentials; browser methods are
  `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` (the writes are needed by
  the admin and user-data endpoints); the `authorization` header is allowed
  (needed for Clerk-authenticated requests); and `x-request-id` is exposed to
  browser clients

## Auto-updates from `main`

For the current production target, enable automatic Dokploy redeploys from the
repository `main` branch for all four services.

That means:

- web rebuilds whenever `main` changes
- api rebuilds whenever `main` changes
- cube-trainer rebuilds whenever `main` changes
- auth rebuilds whenever `main` changes
- Traefik continues to route to the latest healthy service revision managed by
  Dokploy

## Verification after deploy

Verify these URLs after each production rollout:

- `https://site.example.com/`
- `https://site.example.com/about`
- `https://site.example.com/blog`
- `https://site.example.com/projects`
- `https://api.example.com/health`
- `https://cube.unimatrix-01.dev/`
- `https://cube.unimatrix-01.dev/oll`
- `https://cube.unimatrix-01.dev/pll`
- `https://auth.unimatrix-01.dev/`
- `https://auth.unimatrix-01.dev/sign-in`
- `https://auth.unimatrix-01.dev/account`
- `https://auth.unimatrix-01.dev/admin`

Also verify that refreshing a deep route on the public site, cube-trainer, or
the auth app still renders the SPA instead of returning a proxy or
static-host 404.

## SPA routing

The production web host must fall back to `index.html` for unknown application
routes so the client-side router can resolve SPA paths after the initial
request.

## Related docs

- `infra/docker/README.md`: Dockerfiles, Compose, and manual container workflow
- `infra/deployment/README.md`: Dokploy plus Traefik production guidance
