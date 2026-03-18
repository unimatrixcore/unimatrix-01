# Deployment

Dokploy plus Traefik is the primary production deployment target for the
current runtime surface. The repo-owned Dockerfiles and Compose workflow live
under `infra/docker/`; this document covers how those artifacts map onto a
production deployment.

## Build artifacts

- Web static output: `apps/web/dist/`
- API Node runtime entry: `apps/api/dist/server.js`

`vite preview` is useful for local smoke testing of the built web app, but it
is not the production web server for `apps/web/dist/`.

## Default production topology

The default production shape is separate-origin:

- `https://site.example.com` -> web
- `https://api.example.com` -> api

In this shape:

- the web image is built with `VITE_API_BASE_URL=https://api.example.com`
- the API runtime allows the public web origin through `CORS_ALLOWED_ORIGINS`
- Traefik owns TLS termination and hostname routing

Same-origin deployment remains supported, but it is not the primary documented
path for now.

## Dokploy service layout

Create two Dokploy services from the same repository and the same `main`
branch.

### Web service

- build context: repo root
- Dockerfile path: `apps/web/Dockerfile`
- container port: `8080`
- public domain: `site.example.com`
- required build arg: `VITE_API_BASE_URL=https://api.example.com`

The web container is a static SPA container. Traefik should forward the site
hostname to the web service and preserve SPA fallback behavior inside the web
container.

### API service

- build context: repo root
- Dockerfile path: `apps/api/Dockerfile`
- container port: `3001`
- public domain: `api.example.com`
- health endpoint: `/health`

Required runtime environment:

```env
HOST=0.0.0.0
PORT=3001
NODE_ENV=production
LOG_LEVEL=info
TRUST_PROXY=1
CORS_ALLOWED_ORIGINS=https://site.example.com,https://www.site.example.com
```

## Traefik expectations

Traefik is the public edge proxy in Dokploy. The repo does not ship a Traefik
stack or Traefik labels as the source of truth, but production routing should
follow these expectations:

- route the public site hostname to the web service
- route the API hostname to the API service
- terminate TLS at Traefik
- forward standard proxy headers so the API can run with `TRUST_PROXY=1`

Because separate-origin is the default deployment shape, Traefik does not need
to rewrite `/api` paths in the primary production setup.

## Web configuration

- `apps/web/.env.production.example` shows the checked-in separate-origin
  example: `https://api.unimatrix-01.dev`
- if `omnimatrix.dev` becomes the public hostname later, replace that example
  with the new public API origin
- same-origin deployments can keep the default relative `/api` value, but that
  path is secondary to the separate-origin deployment described here

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
- API CORS stays intentionally narrow: no credentials, browser methods limited
  to `GET` and `HEAD`, and `x-request-id` is exposed to browser clients

## Auto-updates from `main`

For the current production target, enable automatic Dokploy redeploys from the
repository `main` branch for both services.

That means:

- web rebuilds whenever `main` changes
- api rebuilds whenever `main` changes
- Traefik continues to route to the latest healthy service revision managed by
  Dokploy

## Verification after deploy

Verify these URLs after each production rollout:

- `https://site.example.com/`
- `https://site.example.com/about`
- `https://site.example.com/blog`
- `https://site.example.com/projects`
- `https://api.example.com/health`

Also verify that refreshing a deep route on the public site still renders the
SPA instead of returning a proxy or static-host 404.

## SPA routing

The production web host must fall back to `index.html` for unknown application
routes so the client-side router can resolve SPA paths after the initial
request.

## Related docs

- `infra/docker/README.md`: Dockerfiles, Compose, and manual container workflow
- `infra/deployment/README.md`: Dokploy plus Traefik production guidance
