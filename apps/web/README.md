# Web service

The public web site is a Vite SPA deployed from `apps/web/Dockerfile` through
`infra/docker/web-compose.yaml`.

## Dokploy redeploy watch paths

Configure the web Dokploy service to watch these repository paths. A change to
any of them can change the built browser bundle or its container:

```text
apps/web/**
content/blog/**
content/home/**
content/projects/**
packages/api-client/**
packages/auth/**
packages/config-typescript/**
packages/content/**
packages/shared/**
packages/ui/**
infra/docker/web-compose.yaml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.dockerignore
```

`apps/web/**` includes its Dockerfile and Nginx configuration. The app bundles
the listed content directories and imports source directly from the listed
workspace packages, so each must trigger a rebuild. The root workspace files
control the frozen pnpm install used by the Docker build.

When adding a workspace dependency or another build input, add its path here
and to the Dokploy service's watch-path configuration. See
[`infra/deployment/README.md`](../../infra/deployment/README.md) for the
repository-wide convention.
