# Cube Trainer service

Cube Trainer is a static Vite SPA deployed from `apps/cube-trainer/Dockerfile`
through `infra/docker/cube-trainer-compose.yaml`.

## Dokploy redeploy watch paths

Configure the Cube Trainer Dokploy service to watch these repository paths. A
change to any of them can change the built browser bundle or its container:

```text
apps/cube-trainer/**
packages/config-typescript/**
packages/ui/**
infra/docker/cube-trainer-compose.yaml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.dockerignore
```

`apps/cube-trainer/**` includes its Dockerfile and Nginx configuration. The
trainer resolves `@unimatrix/ui` from workspace source, and the root workspace
files control the frozen pnpm install used by the Docker build.

When adding a workspace dependency or another build input, add its path here
and to the Dokploy service's watch-path configuration. See
[`infra/deployment/README.md`](../../infra/deployment/README.md) for the
repository-wide convention.
