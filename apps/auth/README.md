# Auth service

The central Clerk-backed auth app is a Vite SPA deployed from
`apps/auth/Dockerfile` through `infra/docker/auth-compose.yaml`.

## Dokploy redeploy watch paths

Configure the auth Dokploy service to watch these repository paths. A change
to any of them can change the built browser bundle or its container:

```text
apps/auth/**
packages/api-client/**
packages/auth/**
packages/config-typescript/**
packages/shared/**
packages/ui/**
infra/docker/auth-compose.yaml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.dockerignore
```

`apps/auth/**` includes its Dockerfile and Nginx configuration. The app imports
source directly from the listed workspace packages, and the root workspace
files control the frozen pnpm install used by the Docker build.

When adding a workspace dependency or another build input, add its path here
and to the Dokploy service's watch-path configuration. See
[`infra/deployment/README.md`](../../infra/deployment/README.md) for the
repository-wide convention.
