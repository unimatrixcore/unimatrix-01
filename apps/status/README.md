# Status service

`@unimatrix/status` serves the public status dashboard at `/` in its own static
SPA container and reads the anonymous `GET /deployment/status` contract.

Run `pnpm --filter @unimatrix/status dev` on port 5177. Local API reads use the
`/api` proxy; copy `.env.example` when a different API target is needed. Preview
uses port 4177.

The dashboard uses the logo/title header, icon refresh, overall status,
30-day service histories, and copyright/main-site footer. Missing observations
remain neutral and tooltips include observation coverage. A failed refresh hides
previous current-state data until a read succeeds.

Route `status.unimatrix-01.dev` to the `status` compose service on container port
8080 with HTTPS. Keep the hostname outside Cloudflare Access. The Dockerfile and
compose file are generated from `deploy.config.ts`.
