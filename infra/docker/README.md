# Local container workflow

No Compose workflow is checked in yet.

The current API implementation has no live external service dependency, so LOC-54 keeps the default local path pnpm-first and SQLite-first instead of introducing `docker-compose.yml` or `compose.yaml` early.

If future API work adds a real local service dependency, optional Compose files belong under `infra/docker/`.
