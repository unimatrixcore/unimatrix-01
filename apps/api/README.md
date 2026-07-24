# API service

The API is a Fastify service deployed from `apps/api/Dockerfile` through
`infra/docker/api-compose.yaml`.

## Dokploy redeploy watch paths

Configure the API Dokploy service to watch these repository paths. A change to
any of them can change the API image or its runtime behavior:

```text
apps/api/**
packages/auth/**
packages/config-typescript/**
packages/db/**
packages/shared/**
infra/docker/api-compose.yaml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.dockerignore
```

`apps/api/**` includes its Dockerfile. The shared package paths are the API's
workspace dependencies; `packages/db/**` includes Drizzle migrations, which
the production service applies on startup. The root workspace files control
the frozen pnpm install used by the Docker build.

When adding a workspace dependency or another build input, add its path here
and to the Dokploy service's watch-path configuration. See
[`infra/deployment/README.md`](../../infra/deployment/README.md) for the
repository-wide convention.
