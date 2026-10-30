# API service

The API is a Fastify service deployed from `apps/api/Dockerfile` through
`infra/docker/api-compose.yaml`.

The image is built by CI, not on the deploy host — see
the [new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding).
