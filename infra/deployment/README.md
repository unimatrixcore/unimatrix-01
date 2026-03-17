# Deployment

LOC-56 makes the v1 runtime surfaces explicit without adding deployment automation, container files, or vendor-specific proxy configuration.

## Build artifacts

- Web static output: `apps/web/dist/`
- API Node runtime entry: `apps/api/dist/server.js`

`vite preview` is useful for local smoke testing of the built web app, but it is not the production web server for `apps/web/dist/`.

## Deployment contract

The repo supports both of these deployment shapes:

- Same-origin deployment: serve the web app and API from one origin, and keep `VITE_API_BASE_URL=/api`.
- Separate-origin deployment: serve the web app and API from different origins, set `VITE_API_BASE_URL` to the public API URL, and allow the web origin through API CORS.

### Web

- `apps/web/.env.production.example` shows the checked-in separate-origin example: `https://api.unimatrix-01.dev`
- If `omnimatrix.dev` becomes the public hostname later, replace that example with the new public API origin.
- Same-origin deployments can keep the default relative `/api` value.

### API

- Start the compiled runtime with `node apps/api/dist/server.js`.
- `CORS_ALLOWED_ORIGINS` accepts a comma-separated list of exact origins such as `https://unimatrix-01.dev` and wildcard subdomain origins such as `https://*.unimatrix-01.dev`.
- Wildcard rules match subdomains only. They do not match the apex domain, so the apex must also be listed explicitly.
- If `CORS_ALLOWED_ORIGINS` is unset, the API uses repo defaults:
  - `https://unimatrix-01.dev`
  - `https://*.unimatrix-01.dev`
  - `https://omnimatrix.dev`
  - `https://*.omnimatrix.dev`
  - `http://localhost:5173`
  - `http://127.0.0.1:5173`
  - `http://localhost:4173`
  - `http://127.0.0.1:4173`
- If `CORS_ALLOWED_ORIGINS` is set, it fully replaces those defaults.
- API CORS stays intentionally narrow: no credentials, browser methods limited to `GET` and `HEAD`, and `x-request-id` is exposed to browser clients.

## SPA routing

The production web host must fall back to `index.html` for unknown application routes so the client-side router can resolve SPA paths after the initial request.

## Out of Scope

This issue does not add:

- deployment automation
- GitHub Actions deployment workflows
- Dockerfiles or Compose files
- vendor-specific reverse-proxy configuration
