# Web service

The public web site is a Vite SPA deployed from `apps/web/Dockerfile` through
`infra/docker/web-compose.yaml`.

The image is built by CI, not on the deploy host — see
the [new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding).

`/status` reads the anonymous `GET /deployment/status` contract. The exact hostname
`status.unimatrix-01.dev` redirects `/` to `/status` before homepage content loads.
Other hostnames retain the homepage. The status view uses the tool shell and
shows 30 UTC days; gaps have neutral bars and uptime is calculated over observed
time. Tooltips include observation coverage.

Route `status.unimatrix-01.dev` to this existing service in Dokploy's Domains
entry (`web`, port `8080`, HTTPS) and add its matching proxied Cloudflare record.
Apply both together and keep this hostname outside Cloudflare Access. Adding DNS
without the matching edge route produces a TLS error.

The status page refreshes once per minute and on demand. A failed refresh hides
previous current-state data and displays `Status unavailable` until a read
succeeds. API and deploy-service history support must ship with the web change;
the UI rejects responses without the public history contract.
