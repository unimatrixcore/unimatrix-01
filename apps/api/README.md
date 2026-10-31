# API service

The API is a Fastify service deployed from `apps/api/Dockerfile` through
`infra/docker/api-compose.yaml`.

The image is built by CI, not on the deploy host — see
the [new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding).

`GET /deployment/status` is public and returns display names, `up`/`down`/`degraded`,
last-probe timestamps rounded down to the minute (`null` before any observation), and daily
availability for today and the preceding 29 UTC days. Public history contains only minute-rounded
window bounds, uptime and coverage percentages. Its summary weights observed durations across
those daily windows. Missing observations retain null uptime and zero coverage; a failed health
read returns an empty history and an unknown summary.
Only declarations with `publicStatus: true` are included. `up` and `down` require a fresh
probe less than a minute old; unknown, stale, missing, or failed probes are `degraded`.
The API caches internal reads for 15 seconds and coalesces concurrent refreshes; it still
checks sample age on each response. If declarations cannot be read, the route returns 503
rather than disclosing apps from an expired visibility snapshot. Responses use `no-store`.

Before deploying the API compose stack, issue a read-capability token for this caller and
set `DEPLOY_SERVICE_TOKEN` and `DEPLOY_TLS_CERT_BASE64` (the deploy service's public certificate,
never its private key). See the deploy service's [TLS and token setup](../deploy/README.md).
Local development may omit the whole deployment-service configuration; the public route then
returns 503. Local HTTP is supported only outside production. Production connectivity and
credential provisioning must be checked during rollout; repository tests exercise local TLS.
