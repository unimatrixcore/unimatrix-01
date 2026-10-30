# Admin console

The administration console is a Vite SPA built from `apps/admin/Dockerfile`
and served by nginx on port 8080, matching the other three static apps.

For production setup, follow the
[new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding).

Content (the blog/project CMS) and Secrets (the credential console) are the
built sections, on `@unimatrix/chrome`'s tool shell; the remaining section
routes are still placeholders. It is deployed and reachable:
`infra/docker/admin-compose.yaml` is the Dokploy Compose file, and
`admin.unimatrix-01.dev` sits behind Cloudflare Access, which is what makes the
ungated placeholder routes safe.

## Build arguments

Vite inlines `import.meta.env.VITE_*` at build time, so these are build args
rather than runtime env — setting them on the running container does nothing.

| Build arg                     | Required | Default                                  |
| ----------------------------- | -------- | ----------------------------------------- |
| `VITE_CLERK_PUBLISHABLE_KEY`  | no       | production Clerk instance's publishable key |
| `VITE_API_BASE_URL`           | no       | `https://api.unimatrix-01.dev`            |
| `VITE_AUTH_APP_URL`           | no       | `https://auth.unimatrix-01.dev`           |

All three default to the production values, so `docker build` with no
`--build-arg` produces a correct production image. `apps/admin/deploy.config.ts`
is the source of these defaults; override any of them to target a different
environment.

## Security headers

`nginx.conf` ships a deliberately tighter policy than `apps/web` — this app
renders no user-authored markdown, so it needs less room. Its `add_header`
lines are the policy the app actually sends.

`default-src`, `script-src` and `connect-src` are absent on purpose. Clerk
loads `clerk.browser.js` from its frontend-API host and avatars from
`img.clerk.com`; that host is baked into the bundle at build time and a static
nginx conf cannot name it. Tightening further means templating the conf
(nginx's `envsubst` entrypoint) from the same build arg, not guessing.
