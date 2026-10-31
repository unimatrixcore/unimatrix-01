# Deployment

Dokploy plus Traefik is the primary production deployment target for the
current runtime surface. The repo-owned Dockerfiles and Compose workflow live
under `infra/docker/`; this document covers how those artifacts map onto a
production deployment.

`vite preview` is useful for local smoke testing of the built web app, but it
is not the production web server for `apps/web/dist/`,
`apps/cflop/dist/`, or `apps/auth/dist/`.

Every `apps/*/Dockerfile` and `infra/docker/*-compose.yaml` referenced below, plus
`apps/deploy/src/reconcile/desired-state.gen.ts`, is generated from `apps/<app>/deploy.config.ts` —
see `infra/docker/README.md`. The subdomain and container port listed per service in this document
are **not** sourced from that config and stay hand-maintained duplication: `packages/deploy-config`
deliberately holds no subdomain or Dokploy metadata (see its `AGENTS.md`), so nothing generates or
reads them.

## New-app onboarding

Follow this order when adding a deployable `apps/<app>` workspace. The checklist covers production
Compose services; the local-only `lab` must never gain deployment artifacts.

1. Declare the app in `apps/<app>/deploy.config.ts`, using the matching archetype from
   `packages/deploy-config`. Add its workspace dependency and seed its Dockerfile from a matching
   sibling so the generator can read the base-image `FROM` lines. Put browser configuration in
   image build-arg defaults and backend configuration in the declared runtime env; keep credentials
   out of build args. Run `node ./infra/scripts/generate-deploy-config.mjs` and review the generated
   Dockerfile, Compose file and desired-state manifest. **Enforced:** `Deploy config` rejects
   invalid declarations and generated-file drift; it does not validate live credentials.
2. Add the app to the `Images` and `Publish` matrices in `.github/workflows/ci.yml`.
   **Enforced:** `App wiring` checks every Dockerfile against both matrices and checks that the
   Compose image matches the published image name. For Vite apps it also checks shared-package
   stylesheet sources and router deduplication.
3. Have a repository administrator add the exact context `Images (<app>)` to the effective required
   status checks for `main`, preserving the other requirements. **Enforced:** `Required image
   checks` in `Verify` reads GitHub's public branch-rules API and fails with each missing context.
   It makes no ruleset writes and needs no token. Matrix membership alone does not make a failed
   image build block a merge.
4. Add `/apps/<app>` to the Docker ecosystem's `directories` in `.github/dependabot.yml` and check
   GitHub's Dependency graph → Dependabot for configuration errors. **Manual:** neither app wiring
   nor the required-check gate verifies Dependabot coverage or updater execution.
5. Before merging, create a uniquely named Dokploy **Compose** service named `<app>`, connected to
   this repository's `main` branch with compose path `infra/docker/<app>-compose.yaml`. Leave
   `autoDeploy` off: CI publishes the image before queuing deployment. **Manual before merge:** the
   reconciler reports missing/ambiguous services and settings drift, but creates no service; CI's
   `Deploy` job detects a missing match only after merge.
6. In that service's environment, set the literal `IMAGE_TAG=${{project.IMAGE_TAG}}` reference and
   supply its declared runtime variables. Keep project-level env limited to `IMAGE_TAG`, because CI
   replaces that blob. Provision external networks, pinned TLS, service tokens and durable volumes
   before the first deploy where the app requires them; use the service-specific sections below.
   **Manual:** CI validates config structure, not Dokploy env, network reachability or durable
   storage. `reconcile report` checks env key states without exposing values; explicit
   `secrets-apply` can fill declared store-backed values but triggers no deploy.
7. Configure DNS, TLS and the Dokploy Domains entry with the app's service name and container port
   if it is public; provision Cloudflare Access where required. Keep internal services unrouted and
   authenticate their data routes. **Manual:** declarations and reconciliation do not manage domains
   or access policy. Verify browser origins, API CORS and auth redirects for a browser app.
8. Run `pnpm check` and `pnpm verify`, exercise browser behavior where applicable, and require the
   PR's image build to pass before merging. After the first `Publish` run creates
   `ghcr.io/unimatrixcore/unimatrix-<app>`, make the package public in its GitHub package settings.
   **Manual:** package visibility is not inherited from the public repository and these gates do
   not verify it. Until visibility is changed, the first queued deploy can fail its unauthenticated
   pull; retry deployment after changing it.
9. Confirm the deployment actually landed: inspect the recreated container and its requested image,
   then check health, public routing and browser interactions, including deep-route refreshes and
   unknown-route behavior appropriate to the app. **Manual:** a green `Deploy` job means queued,
   and an old healthy container does not prove that the new image is serving.

## Default production topology

The default production shape is separate-origin:

- `https://site.example.com` -> web
- `https://api.example.com` -> api
- `https://cflop.unimatrix-01.dev` -> cflop
- `https://cube.unimatrix-01.dev` -> 301 to `cflop.unimatrix-01.dev`
  (pre-rebrand hostname; see "CFLOP service" below)
- `https://auth.unimatrix-01.dev` -> auth
- `https://admin.unimatrix-01.dev` -> admin

In this shape:

- the web image is built with `VITE_API_BASE_URL=https://api.example.com`
- the API runtime allows the public web origin through `CORS_ALLOWED_ORIGINS`
- the cflop image needs no build-time or runtime env; it has no API
  dependency
- the auth image is built with `VITE_API_BASE_URL=https://api.example.com` and
  `VITE_CLERK_PUBLISHABLE_KEY` for the shared Clerk application
- Traefik owns TLS termination and hostname routing
- the secrets service gets no hostname and no Domains entry at all — it is
  deliberately unrouted. That makes it unreachable from the internet; it does
  not make it private. See "Secrets service" below

### SPA build args are baked into the published image

`apps/web`, `apps/auth`, and `apps/admin` each declare production values as
their `ARG` defaults (see `apps/<app>/deploy.config.ts`). CI builds each image
with no `--build-arg` and the compose files pull that image rather than
building one, so those defaults are the only values that ever reach a browser
bundle: setting `VITE_API_BASE_URL`, `VITE_CLERK_PUBLISHABLE_KEY` or
`VITE_AUTH_APP_URL` on a Dokploy service changes nothing at all. Pointing an
app at a different API origin or Clerk instance means editing its
`deploy.config.ts` default and publishing a new image.

## Published GHCR images

CI's `Publish` job (`.github/workflows/ci.yml`) builds every `apps/*/Dockerfile`
with no build args and pushes it to `ghcr.io/unimatrixcore/unimatrix-<app>` on
every push to `main`, tagged with the commit SHA and a moving `main` tag. The
packages are public, so Dokploy pulls them unauthenticated.

Every `infra/docker/<app>-compose.yaml` declares `image:` and no `build:`, so
nothing is built on the deploy host: each stack pulls
`ghcr.io/unimatrixcore/unimatrix-<app>:${IMAGE_TAG}`, and `IMAGE_TAG` is the
only thing deciding which commit production runs.

**Each Compose service needs `IMAGE_TAG=${{project.IMAGE_TAG}}` in its own
environment variables, once.** Dokploy does not inherit project-level variables
into a Compose stack. It writes the stack's `.env` from the *service's* own env
alone, expanding `${{project.X}}` references out of the project blob as it goes,
and then runs `docker compose … up` under `env -i`, so nothing ambient reaches
the substitution either. Without that one line `${IMAGE_TAG}` resolves to an
empty string and the deploy fails on `invalid reference format` — loudly, with
the previous container still running. (Read from `getCreateEnvFileCommand`,
`prepareEnvironmentVariables` and `getBuildComposeCommand` in Dokploy v0.29.13;
not measured against the instance.)

### A new app's package is private until someone makes it public by hand

Every package is created **private**, whatever the repository's visibility. A
package linked to a repository inherits that repository's access permissions but
never its visibility, so a public repo does not produce a public package. Adding
a new app therefore carries one manual step, once, that nothing enforces:
let the first `Publish` run create the package, then set it public at
`https://github.com/orgs/unimatrixcore/packages/container/unimatrix-<app>/settings`.
The organization must permit public packages at all — Settings → Packages →
Package Creation → Public — or that per-package control is greyed out.

**There is no API for this.** The Packages REST API lists, gets, deletes and
restores packages and versions, and mutates visibility nowhere; `gh` cannot do
it either, and the web UI is the only route. So no check can assert it, which is
why it is written here rather than enforced somewhere.

Miss it and Dokploy's unauthenticated pull fails as *image-not-found* —
indistinguishable from a bad tag, so the obvious next move is to go and debug
the tag scheme. Visibility is a property of the package rather than of each
version, so this is once per app, not once per deploy.

## How a deploy is triggered

CI's `Deploy` job (`.github/workflows/ci.yml`) runs after `Publish`, on a push
to `main` and nowhere else — a `workflow_dispatch` from a feature branch
publishes a SHA-tagged image but can never point production at it. It makes two
writes over Dokploy's REST API, in this order:

1. `POST /api/project.update` sets the project's environment to
   `IMAGE_TAG=<commit sha>`, once per project the compose services span.
2. `POST /api/compose.deploy`, one call per service and sequentially, which is
   what makes Dokploy pull the newly tagged images.

Which service is which is resolved per run from `GET /api/project.all`, by
matching each `infra/docker/<app>-compose.yaml` to a Dokploy compose service of
the same name. A service that is missing, renamed, or duplicated fails the job
by name rather than being skipped, and a project whose tag write failed has its
services skipped rather than deployed at the previous commit's tag.

**Project-level environment holds `IMAGE_TAG` and nothing else**, and each
service reads it through the one-line reference described under "Published GHCR
images" above. `project.update` is a partial that Dokploy spreads over the row,
so the write above *replaces* the whole blob — a second variable stored at
project level would be deleted on the next merge. CI deliberately never reads the blob back
to merge into it, because that would pull whatever it holds into a public
repository's runner, so this invariant is the only thing protecting anything
kept there. Per-service variables (`CORS_ALLOWED_ORIGINS`, `CLERK_*`, the
`SECRETS_*` set) live on the service and are untouched by any of this.

**`autoDeploy` must stay off on every service** (one per `infra/docker/*-compose.yaml`). With it on, Dokploy deploys
on a push of its own accord, at whatever `IMAGE_TAG` the project holds at that
moment — which during a CI run is the previous commit. Watch paths are no
defence: `shouldDeploy` returns true when a service's watch-path list is empty,
so a service with none set redeploys on every push to `main`. It is a
Dokploy-side setting; `pnpm --filter @unimatrix/deploy-app reconcile report` (`apps/deploy/README.md`)
reads it back and reports drift when it finds `autoDeploy: true`, and `reconcile apply <app>` can
set it back to `false` — a single `compose.update` call, one app at a time, refusing its own compose
entry and a handful of other cases (`apps/deploy/AGENTS.md`).

That choice has a price. `POST /api/compose.refreshToken` mints a per-service
webhook URL — a far narrower credential than the instance-wide API key — and it
answers `400 Automatic deployments are disabled for this compose` while
`autoDeploy` is off. The instance-wide key is what the safety control costs.

**A 200 is an acknowledgement, not a deploy.** The job logs `queued` and claims
nothing more; see "A deploy is queued, not applied" below for the distinction
between recreation and verified image correlation.

### Deployment-attempt ingestion and image correlation

This is the implementation contract for attempt recording. The current CI workflow queues
deployments directly in Dokploy; `apps/deploy/src/observe/observer.ts` observes container IDs and
image strings. Neither implements the durable reporting and immutable correlation required here.

**CI keeps orchestration; the deploy service owns attempt records and outcome observation.**
CI reports intent before queuing work and reports the request result afterwards. Reporting must
not queue a deployment, change project env, or retry a Dokploy mutation. Future manual redeploy
and rollback operations record through the same attempt model. Direct Dokploy UI operations are
out of band: a container change without a recorded request remains an observation, with no
invented trigger, requested image, or successful attempt. Dokploy history polling is not the
ingestion mechanism.

The reporting sequence must satisfy these invariants:

1. Publish carries forward each app's image repository, full commit SHA, platform and immutable
   published manifest digest from the successful push. Capture the digest for that publication;
   looking up the SHA tag later can resolve to a different image after a rebuild.
2. Before CI changes a project's tag or calls `compose.deploy`, persist an intent for each affected
   app in the deploy-owned database. Keep a stable attempt ID, authenticated reporter identity,
   workflow run ID and run attempt, app, trigger, requested image identity and request time. Capture
   the before-container identity and observation time independently of caller claims. A missing
   baseline is explicit. Failure to acknowledge durable intent stops the associated deployment
   writes; recording is therefore an availability dependency even though orchestration stays in CI.
3. Reporting retries reuse the same logical request key, including repository, workflow run ID,
   run attempt and app. Identical retries return the existing record; conflicting image data is rejected.
   Rerunning the workflow is a new attempt. A duplicate report must never trigger another deploy.
4. Report tag-write failures and per-app queue responses against those records. A 200 establishes
   only queue acknowledgement. A transport failure after sending a mutation is an unknown request
   result, because the operation may have been accepted. Never turn it into a definite rejection
   or automatically replay the mutation. A tag write without a subsequent queue request is not
   queued work.
5. Missing completion reports, including CI cancellation, leave durable incomplete records.
   Recovery after a service restart uses those records and fresh observations, not process-local
   observer state. Attempt expiry must not depend on a final CI callback arriving.

Reporting uses validated, bounded contracts and the deploy service's authenticated mutation
boundary. Read tokens cannot write attempts. The reporter cannot submit a `landed` verdict or
choose its own trusted identity. No env blob, credential, raw Dokploy response or arbitrary log
text belongs in an attempt. Shared HTTP contracts use static paths with validated bodies/queries.
The authenticated route from GitHub-hosted CI to this unrouted service requires implementation
and reachability verification; this contract does not provision a public deploy-service endpoint.

**Landed requires both a changed container ID and an exact immutable image match.** Store the
requested repository, platform, digest kind and digest separately from display tags and commit metadata. The
runtime evidence must identify the image used by that specific observed container. Docker image
config IDs, platform manifest digests and multi-platform index digests are different identities:
compare the same kind of digest, or verify the content-addressed relationship between them. A
registry lookup of the container's tag does not establish what that container is running.

The current `docker.getContainers` schema supplies only an image string. A runtime digest source
and its association with the container must be observed and validated before extending the client.
Missing digest evidence, an ambiguous app mapping, an unchanged ID, or a missing before-container
baseline cannot produce `landed`. This also applies when redeploying the image already running.
An image match proves image content, not runtime env, secrets, routing or health; verify those
separately where a runbook depends on them.

Keep request acknowledgement, image outcome and service health separate. A definite request
rejection or verified attempt-specific execution failure can establish failure; an unhealthy
container alone cannot. A deadline without sufficient landing evidence means timed out, not proof
that Dokploy stopped processing. Retain the timeout and any later matching observation separately
so a late rollout does not erase the missed deadline. The recorded seven-minute delay below is
not a timeout policy; the recording feature must specify and test its deadline and retention bounds.

Overlapping requests must not borrow each other's recreation evidence. Persist their identities
and ordering; when two requests could explain the same container transition, retain ambiguous
correlation rather than marking either landed. This includes repeated requests for the same
digest and cancellation followed by another CI run. CI's shared project tag can change while
Dokploy work is queued, so a matching time window or CI title is insufficient. Self-deployment
must survive the observer being replaced: persist its baseline before queuing and resume from
durable state; an observation gap cannot become evidence of success. Retention must preserve
unresolved evidence through its deadline and bound both records and returned histories.

Before enabling attempt recording, verify publication digest capture, runtime digest observation,
authenticated CI reporting, restart recovery and the failure cases above. Exercise a same-tag
rebuild with a different digest and a same-image redeploy without recreation; neither may land.
No live digest source or
end-to-end attempt reporting has been verified by this documentation change. Per-attempt log
retrieval and rollback execution remain separate features; a local attempt ID alone does not
establish an upstream log identity or permission to change the project-wide image tag.

### Rolling back

Dokploy has **no rollback for Compose services** — its rollback path resolves
`deployment.applicationId` only, and a compose deployment has none. Reverting
the commit does not roll production back either, because the running version is
whatever `IMAGE_TAG` says, not whatever `main` says.

So a rollback is one edit and one deploy:

1. Pick the commit to go back to. Any commit whose `Publish` run succeeded has
   a `ghcr.io/unimatrixcore/unimatrix-<app>` tag under its SHA.
2. Set `IMAGE_TAG` to that SHA in the Dokploy project's environment UI, keeping
   it the only variable there.
3. Redeploy the affected services and confirm each container was **recreated** and runs the
   intended immutable image — see "A deploy is queued, not applied" below. A matching SHA tag
   alone cannot distinguish images published by separate builds of that commit.

Reverting on `main` and merging works too and is slower: it goes through CI,
publishes a new image, and writes the new SHA. Reach for that when the revert
belongs in the repository as well.

## Dokploy service layout

Create one Dokploy service per `infra/docker/*-compose.yaml`, all from the same
repository and the same `main` branch, all using Dokploy's **Compose**
application type (not the plain Dockerfile application type).

### Web service

- application type: Compose
- compose path: `infra/docker/web-compose.yaml`
- no service-level environment variables — `VITE_API_BASE_URL` is baked into
  the published image (see "SPA build args are baked into the published image")
- Domains page: route `site.example.com` to the `web` service, container port
  `8080`

The public site is fully anonymous — no Clerk, no sign-in affordance, no
account-scoped UI. That surface lives on `apps/admin`; see the admin service
below.

The web container is a static SPA container. Preserve SPA fallback behavior
inside the web container regardless of routing.

### API service

- application type: Compose
- compose path: `infra/docker/api-compose.yaml`
- Domains page: route `api.example.com` to the `api` service, container port
  `3001`
- health endpoint: `/health`

Required environment variable (set in Dokploy's UI):

```env
CORS_ALLOWED_ORIGINS=https://site.example.com,https://www.site.example.com
```

`HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, and `TRUST_PROXY` are fixed by
`apps/api/deploy.config.ts` and generated into `infra/docker/api-compose.yaml`;
a Dokploy variable of the same name does not override them.

**Persistent storage:** user settings and uploaded files are stored in SQLite,
so the API needs a durable volume or all user data is lost on redeploy.
`api-compose.yaml` already declares an `api-data` volume mounted at `/data`
(where the DB defaults to `/data/unimatrix.sqlite`) and sets
`DB_MIGRATE_ON_START=true`, so pending migrations are applied against that
volume automatically at container startup — no manual `db:migrate` step is
required in production. In Dokploy, confirm the volume is attached and mapped to
persistent host storage (Advanced → Volumes) so it survives redeploys.

Clerk auth is required in production: set `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_KEY` in Dokploy's UI (all three, never
just some). See "Clerk setup" below.

Four more variables connect this service to the secrets store —
`SECRETS_SERVICE_TOKEN`, `SECRETS_INTEGRATIONS_MANAGE_TOKEN`,
`SECRETS_PLATFORM_WRITE_TOKEN` and `SECRETS_TLS_CERT_BASE64`. All four must
exist in Dokploy before this stack is deployed: an unset variable named in the
compose file reaches the container as an empty string rather than as absent,
and the API's loader refuses an empty value, so the stack restart-loops and
every content route 404s. `SECRETS_BASE_URL` is not a fifth: it is generated
into the compose file from `apps/api/deploy.config.ts`, not set in Dokploy's
UI. The ordered procedure is under "Secrets service" below.

### CFLOP service

- application type: Compose
- compose path: `infra/docker/cflop-compose.yaml`
- no environment variables required
- Domains page: route `cflop.unimatrix-01.dev` to the `cflop` service,
  container port `8080`

Unlike the web service, the cflop container serves one HTML file per route and
answers an unknown path with a real 404. Do not add a catch-all in Dokploy or
Traefik that routes every path to the app: it would reinstate the soft 404 from
outside the container, where `infra/scripts/check-cflop-serving.sh` cannot see
it and the only symptom is unknown URLs quietly returning 200 again. The web
service keeps its SPA fallback (`apps/web/nginx.conf`) and is right to — it has
no per-route files to serve instead.

cflop has no API dependency, so it does not need an entry in
`CORS_ALLOWED_ORIGINS`.

#### The pre-rebrand `cube.` hostname

`cube.unimatrix-01.dev` is the tool's pre-rebrand hostname and still has users
and links pointing at it. It permanently 301s to `cflop.unimatrix-01.dev` with
the path and query string preserved.

The redirect lives in Traefik on the Dokploy host, across two surfaces. Nothing
in this repository configures either one, so if the Dokploy service is recreated
from scratch both have to be re-added by hand — neither CI nor the image will
notice they are gone, and the only symptom is `cube.` quietly serving the app
again:

- `/etc/dokploy/traefik/dynamic/middlewares.yml` defines `cube-to-cflop`, a
  `redirectRegex` with `permanent: true`, alongside the `redirect-to-https` that
  Dokploy ships.
- the Dokploy domain record for `cube.unimatrix-01.dev` carries
  `middlewares: ["cube-to-cflop@file"]`. The `@file` suffix is load-bearing: the
  router is generated by Dokploy's docker provider, and an unqualified middleware
  name resolves inside the router's own provider, where this one does not exist.
  Dokploy appends `@file` itself only to the `redirect-to-https` it injects.

That domain record also has to keep pointing at a live service and terminating
TLS, or the redirect is never reached — a hostname Traefik has no router for
answers `526` through the proxy, indistinguishable from one that does not exist.
The middleware is attached to the websecure router only, so `http://cube.…`
takes two hops: `redirect-to-https@file`, then the redirect.

A Cloudflare Redirect Rule would also work, and was not chosen. There is no
per-host `cube.` or `cflop.` DNS record — both are served by the proxied
`*.unimatrix-01.dev` wildcard, and Redirect Rules only execute on proxied
traffic. Flipping that one wildcard to DNS-only would stop the rule firing with
no error anywhere. Traefik sits below that switch. Nginx-in-the-container was the
other candidate and would have been repo-owned, which is a real advantage; the
trade accepted here is that the redirect lives on the host instead, invisible to
anyone reading this repository.

#### Progress saved under the old hostname is unreachable

`localStorage` is partitioned by origin, so whatever a visitor accumulated under
`https://cube.unimatrix-01.dev` cannot be read from `https://cflop.unimatrix-01.dev`.
`apps/cflop/src/lib/local-storage.ts` falls back from the `cflop:` key prefix to
`cube-trainer:`, which covers the key rename within one origin and does nothing
across two. The old data is not deleted — a one-time hand-off page served at
`cube.` could still recover it — but until something does that, a redirected
visitor arrives with an empty profile.

### Auth service

- application type: Compose
- compose path: `infra/docker/auth-compose.yaml`
- no service-level environment variables — `VITE_API_BASE_URL` and
  `VITE_CLERK_PUBLISHABLE_KEY` are baked into the published image (see "SPA
  build args are baked into the published image")
- Domains page: route `auth.unimatrix-01.dev` to the `auth` service,
  container port `8080`

The auth container is a static SPA container, same shape as the web and
cflop services. Preserve SPA fallback behavior inside the container
regardless of routing. It is the central Clerk-backed accounts app (landing,
sign-in/sign-up, and account management), so it needs `CORS_ALLOWED_ORIGINS` on
the API service to include
`https://auth.unimatrix-01.dev` if it calls the API directly from the browser.

### Admin service

- application type: Compose
- compose path: `infra/docker/admin-compose.yaml`
- no service-level environment variables — `VITE_CLERK_PUBLISHABLE_KEY`,
  `VITE_API_BASE_URL` and `VITE_AUTH_APP_URL` are baked into the published
  image (see "SPA build args are baked into the published image")
- Domains page: route `admin.unimatrix-01.dev` to the `admin` service,
  container port `8080`

Access control is Cloudflare Access on the proxied hostname, not app code —
`curl https://admin.unimatrix-01.dev/` returns a 302 to
`unimatrix-01.cloudflareaccess.com`. That is what makes the scaffold's ungated
placeholder route safe; see `apps/admin/AGENTS.md`.

### Secrets service

- application type: Compose
- compose path: `infra/docker/secrets-compose.yaml`
- no Domains page entry — this service is deliberately unrouted, with no
  public hostname and no container port exposed through Traefik
- required environment variables (set in Dokploy's UI, not in the file):
  `SECRETS_KEKS` (see `packages/secrets/AGENTS.md` for its format; there is no
  default, so a missing value fails the service at startup rather than
  silently sealing values under a placeholder key), plus
  `SECRETS_TLS_CERT_BASE64` and `SECRETS_TLS_KEY_BASE64` — see "Shared network
  and TLS" below

**Persistent storage:** `secrets-compose.yaml` declares a `secrets-data`
volume mounted at `/data` (where the DB defaults to `/data/secrets.sqlite`)
and sets `DB_MIGRATE_ON_START=true`, so pending migrations are applied against
that volume automatically at container startup. As with the API service,
confirm the volume is mapped to persistent host storage (Advanced → Volumes)
so it survives redeploys.

**Issuing a service token:** every request except `GET /health` carries a
bearer token, and tokens are minted by a CLI inside the running container
rather than over HTTP. It needs the database but not `SECRETS_KEKS`.

```bash
docker exec <container> node dist/cli/service-token.js \
  issue --name api --scope github --capability read
```

The plaintext prints once and only its digest is stored, so a lost token is
reissued rather than recovered. `list` and `revoke --name <name>` are the other
two subcommands, and both they and `issue` append a row to the audit log.

**Rotating the KEK:** two more host-local CLIs, `dist/cli/kek.js` and
`dist/cli/secret.js`, sit beside `service-token.js`. Neither takes a
`--kek` flag — `docker exec` already inherits `SECRETS_KEKS`. The ordered
runbook:

1. Capture the current key before touching anything, encrypted offline:

   ```bash
   set -o pipefail
   docker exec <container> sh -c 'test -n "${SECRETS_KEKS:-}" && printf %s "$SECRETS_KEKS"' \
     | gpg -c --armor --output kek-<date>.asc
   ```

   Or read it from Dokploy's environment-variable UI where it was pasted. The pipe keeps the key
   out of the argument list and shell history; restore with `gpg -d kek-<date>.asc`.

   **`set -o pipefail` and the `test -n` are what make this fail loudly.** Without them a failed
   `docker exec` — wrong container name, container not running — still runs `gpg`, which encrypts
   empty input and writes a well-formed `.asc` file containing nothing. It decrypts cleanly to an
   empty string, so nothing about the artifact says it is not a backup. Confirm the file is
   non-trivial in size and prove the restore opens every row (`kek verify` under the restored key)
   before treating it as one.

   Do this regardless of whether anything looks wrong — a backup taken after a key is already lost
   is not a backup, and one that has never been restored is a hypothesis rather than a backup.
2. `docker exec <container> node dist/cli/kek.js generate` and encrypt the
   printed `<version>:<key>` entry offline the same way — call this new version `<n>`. It
   prints only the new entry, never the rest of the ring. `SECRETS_KEKS` set
   but unparsable (the state a broken volume can leave it in) does not block
   this step: `generate` says so on stderr and still prints a usable entry.
3. In Dokploy's environment-variable UI, prepend the new entry to
   `SECRETS_KEKS` (new entry first, comma-separated), keeping the old entry,
   and redeploy. **Wait for the container to be recreated before step 4** — the
   deploy is queued rather than applied, and the old ring stays live for minutes
   afterwards; see "A deploy is queued, not applied" below.
4. `docker exec <container> node dist/cli/kek.js rotate --to-version <n>` —
   re-seals every `secret_versions` row, live and superseded, under version
   `<n>`. Refuses to start if `<n>` is not the ring's actual active version
   (the redeploy in step 3 has not taken effect in this container) or if any
   row's KEK version is missing from the ring, and is resumable if
   interrupted.
5. `docker exec <container> node dist/cli/kek.js verify --expect-active <n>`
   — must report zero rows outside version `<n>` before the next step, and
   likewise refuses outright if `<n>` is not the ring's actual active
   version. It censuses every row from the envelope's own KEK version field,
   not the `kek_version` column, because `SecretsKeyring#open` resolves the
   key the same way; a census built from the column could read "nothing left
   on the old key" while envelopes are still sealed under it.
6. Only once `verify` reports zero rows outside the active version, remove
   the old entry from `SECRETS_KEKS` and redeploy again.

**Recovering a volume when the service will not boot:** run the CLI directly
against the volume from outside the running container. Export
`SECRETS_KEKS` in the invoking shell first — `-e SECRETS_KEKS` with no `=`
forwards that shell variable into the container without ever putting the key
in argv — and pass the image tag Dokploy built for this service (visible in
its Dokploy UI or `docker images`):

```bash
export SECRETS_KEKS=...
docker run --rm -e SECRETS_KEKS -v <project>_secrets-data:/data \
  <image> node dist/cli/kek.js verify --expect-active <n>
```

The volume name is prefixed with the Dokploy project name by Compose — read
the actual name from `docker volume ls` rather than copying `secrets-data`
from `secrets-compose.yaml` directly.

**Shared network and TLS.** This stack and the API stack both join one
external Docker network, `unimatrix-secrets`, and the store serves HTTPS on it
with a self-signed certificate the API pins by value. The network is what puts
the store within reach of another stack at all; the pin is what stops three
long-lived bearer tokens crossing it in cleartext.

The store still has no Domains entry and stays off `dokploy-network`, where
every container is one Traefik serves. Network position was never the boundary
in either direction: every request but `GET /health` is rejected without a
valid service token.

Generate the certificate on the host, once. Not in the image — the private key
would land in a registry layer. Not at boot — it would change on every restart
and the API's pinned copy would be stale within minutes.

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
  -days 3650 -subj "/CN=secrets" -addext "subjectAltName=DNS:secrets"
base64 -w0 cert.pem   # -> SECRETS_TLS_CERT_BASE64 (both stacks)
base64 -w0 key.pem    # -> SECRETS_TLS_KEY_BASE64 (this stack only)
```

The SAN must be `secrets`, the store's Compose service name, because that is
the host the API connects to and hostname verification stays on. Ten years is
deliberate: a certificate pinned by value gains nothing from expiring, and an
expired one is an outage with a confusing error.

Order matters, and none of these steps is optional. Steps 1 to 3 happen
**before either stack is deployed with the new compose file**, not after: an
unset variable reaches the container as an empty string, present rather than
absent, and both loaders refuse an empty value. Deploy first and the store and
the API both restart-loop — and with the store down, step 3's tokens cannot be
minted at all, because the CLI that mints them runs inside the running
container.

Setting the variables early is safe. The containers already running do not read
them until a deploy replaces them.

1. `docker network create unimatrix-secrets` on the host. Compose does not
   create an external network; it fails when one is missing.
2. Generate the certificate as above and set `SECRETS_TLS_CERT_BASE64` and
   `SECRETS_TLS_KEY_BASE64` on the **secrets** stack.
3. Mint the three service tokens against the still-running store, then set all
   five `SECRETS_*` variables on the **api** stack: the base URL
   `https://secrets:3001`, the three distinct tokens, and the certificate.
   Never the private key.
4. Merge, wait for `Publish` to push the new images, then deploy both stacks. A
   deploy is queued rather than applied — see "A deploy is queued, not applied"
   below.
5. Confirm `"scheme":"https"` in the store's boot log and the container
   reporting `healthy`, then check the public API through Traefik immediately.
   A 502 means the explicit `networks:` block cost the service its Traefik
   attachment.

**Telling a misconfigured token from a missing secret.** The store answers a
wrong-capability caller, an out-of-scope name and an absent name with a
byte-identical 404, so the admin console cannot distinguish them and neither
can a log line. What does distinguish them:

1. A 401 is unambiguous — an invalid or revoked token. Everything else is a
   404.
2. `/secrets/admin` answering 404 rather than 401 when unauthenticated means
   the module never registered, so the store's base URL or one of its three
   scoped tokens is missing. A missing certificate is not this symptom: with an
   `https://` base URL the API refuses to boot at all rather than serving
   without the module.
3. Every row reading "Not set" while the store holds values means a manage
   token scoped to the wrong tier.
4. Authoritative, and host-local:
   `docker exec <secrets> node dist/cli/service-token.js list` prints each
   token's scope and capability, and `secret_audit_log` holds a row per read
   attempt.
5. As a positive control, create a throwaway credential in each tier from the
   console.

### Deploy service

- application type: Compose
- compose path: `infra/docker/deploy-compose.yaml`
- no Domains page entry — this service is deliberately unrouted, same as the
  secrets service
- required environment variables (set in Dokploy's UI, not in the file):
  `DOKPLOY_BASE_URL`, `DOKPLOY_API_KEY`, `DEPLOY_TLS_CERT_BASE64` and
  `DEPLOY_TLS_KEY_BASE64` — production startup requires all of them. Follow the
  [deploy TLS setup](../apps/deploy/README.md#tls) before rollout; the certificate SAN includes
  `deploy`, and network callers pin its certificate with hostname verification enabled.
- `DOKPLOY_BASE_URL` uses the internal Dokploy address `http://dokploy:3000` on
  `dokploy-network`; verify name resolution and API reachability from the deployed container
- `SECRETS_TLS_CERT_BASE64` (set in Dokploy's UI): the store's certificate.
  Used by internal HTTPS health probes and by `secrets-status` or `secrets-apply` (below).
  An unset or malformed pin makes secrets health unknown without blocking service startup;
  the secrets CLI still refuses an unconfigured connection.
- persistent storage: `deploy-data` mounted at `/data`, with `DEPLOY_DATABASE_PATH=/data/deploy.sqlite`.
  Preserve this volume across redeploys; it holds caller-token digests and bounded health history and is separate from the
  API and secrets volumes. Confirm the actual Compose-prefixed volume name and mount on the host.

The collector probes internal app targets every 60 seconds and retains 30 days of observations.
Uptime excludes unknown intervals and is accompanied by coverage; see
[internal health history](../apps/deploy/README.md#internal-health-history) for interval semantics
and probe verification. Missing observations must not be interpreted as healthy.

It joins `dokploy-network`: it exists to call Dokploy's own API, and joining
is what lets it reach that API by service name rather than round-tripping out
through Cloudflare. The cost, stated plainly: a container holding an
unscoped, instance-wide Dokploy API key sits on the same network every app
Traefik serves. No domain or Traefik entry routes public traffic here, but network peers can reach
it. Only `GET /health` is anonymous; all other requests, including unmatched URLs, require a
deploy-owned bearer service token over HTTPS. Issue and revoke tokens with the
[host-local CLI](../apps/deploy/README.md#service-tokens); use `read` for observations and `manage`
for mutations. These credentials are separate from secrets-store tokens and the Dokploy key. It also
joins `unimatrix-secrets`, alongside the secrets service and the API: the
same container now also sits on the network carrying every secrets-store
read for this instance. See `apps/deploy/AGENTS.md`.

`pnpm --filter @unimatrix/deploy-app reconcile report` diffs every app's `deploy.config.ts` against
what Dokploy actually holds and prints the drift — missing or ambiguously-named compose services,
env keys that are unset/blank/undeclared (never a value, only a key and a state), and disagreement
on `composePath`, `sourceType`, `branch`, or `autoDeploy`. Read-only: it calls only `project.all`
and `compose.one`. A Dokploy env key also declared as an image build arg is reported as a
`build-arg-runtime-copy` without counting as drift; its runtime value cannot change the bundle.
It does not check a service's Domains entry or its `watchPaths`/`composeFile` —
see `apps/deploy/README.md`.

`pnpm --filter @unimatrix/deploy-app reconcile apply <app>` writes `composePath`, `branch`, and
`autoDeploy` for one app when they drift — a single `compose.update` call, settings only, refusing
its own compose entry, an app not in the manifest, a name matching zero or more than one Dokploy
compose service, a match anchored to a different GitHub owner/repository, or a `sourceType`
disagreement. It still writes no `env`, creates nothing (`compose.create` needs an `environmentId`
this repo declares nowhere), deploys nothing, and touches no domain. On that last point: v0.29.13's
`domain.create` procedure does work — the reason this repo does not call it is that
`packages/deploy-config` declares no domain data, not that the API can't. See `apps/deploy/AGENTS.md`
and `apps/deploy/README.md`.

`pnpm --filter @unimatrix/deploy-app reconcile secrets-status <app>` resolves the secrets-store
names one declared app's manifest entry carries, against the store this service holds a read-only
token for. It writes
nothing and prints no value, only whether each declared name resolved. The token
(`SECRETS_PLATFORM_READ_TOKEN`) arrives via `docker exec --env-file`, never as compose env, and the
store connection is read lazily — a store left unconfigured cannot affect `report` or `apply`. See
`apps/deploy/README.md`.

`reconcile secrets-apply <app> [--overwrite]` applies resolved store values to Dokploy without
triggering deployment. See `apps/deploy/README.md` for refusal rules, comparison semantics and exit
codes. The correction window is until the next merge to `main`; do not edit Dokploy env concurrently
with the read-modify-write operation.


## Traefik expectations

Traefik is the public edge proxy in Dokploy, and Dokploy's Domains page is the
source of truth for routing — it configures Traefik itself once you point a
service at a hostname and container port there. The repo does not ship
Traefik labels or a Traefik stack, and the compose files intentionally leave
Traefik config out for this reason.

Production routing still needs to satisfy:

- the public site hostname routes to the web service
- the API hostname routes to the API service
- the `cflop.unimatrix-01.dev` hostname routes to the cflop service
- the `cube.unimatrix-01.dev` hostname 301s to `cflop.unimatrix-01.dev` via a
  Traefik middleware, and still terminates TLS so the redirect is reachable
- the `auth.unimatrix-01.dev` hostname routes to the auth service
- the `admin.unimatrix-01.dev` hostname routes to the admin service
- TLS terminates at Traefik
- standard proxy headers are forwarded, and the API trusts only Traefik's
  explicit address through `TRUST_PROXY`

The API's `TRUST_PROXY` literal in `apps/api/deploy.config.ts` must match the
immediate Traefik endpoint. `docker inspect dokploy-traefik` reported an explicit
`dokploy-network` endpoint address of `10.0.1.166`, and DNS from the API container
resolved `dokploy-traefik` to that address. Persistence across proxy recreation
has not been verified. After recreating Traefik, recheck its network address,
update the config if needed, regenerate deployment artifacts, and redeploy the API.
Address drift ignores forwarded headers and makes clients share the proxy's rate
limit bucket. Do not trust the whole shared overlay subnet: unrelated apps join it.
Numeric hop counts such as `TRUST_PROXY=1` are rejected; use one verified IPv4 or
IPv6 address. `true` trusts all peers and is unsuitable for this shared network.

Because separate-origin is the default deployment shape, Traefik does not need
to rewrite `/api` paths in the primary production setup.

## Web configuration

- `apps/web/.env.production.example` shows the checked-in separate-origin
  example: `https://api.unimatrix-01.dev`
- same-origin deployments can keep the default relative `/api` value, but that
  path is secondary to the separate-origin deployment described here

## Clerk setup

Clerk is a single shared application across every Unimatrix service, with
primary domain `unimatrix-01.dev`. Sessions are shared across all subdomains
(`auth.`, `api.`, `cflop.`, and the apex), so **no satellite domains are
needed**.

A human needs to do the following once in the Clerk Dashboard:

1. Under **Configure → Sessions → "Customize session token"**, add a claim
   `"permissions": "{{user.public_metadata.permissions}}"` so the API can
   verify permissions networklessly from the session token.
2. Set the backend env (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
   `CLERK_JWT_KEY`) on the API service, and the frontend env
   (`VITE_CLERK_PUBLISHABLE_KEY`) on the auth and admin services. The web
   service carries no Clerk key — it is a fully anonymous public site.
3. Bootstrap the first platform administrator by setting that user's
   `publicMetadata` to `{ "permissions": { "auth": ["admin"] } }` directly in
   the Dashboard — there is no public "become admin" flow.

See `packages/auth/README.md` for the exact steps and the full permission
scheme.

## API configuration

- Start the compiled runtime with `node apps/api/dist/server.js`
- `CORS_ALLOWED_ORIGINS` accepts a comma-separated list of exact origins such
  as `https://site.example.com` and wildcard subdomain origins such as
  `https://*.example.com`
- wildcard rules match subdomains only; they do not match the apex domain, so
  the apex must also be listed explicitly
- if `CORS_ALLOWED_ORIGINS` is unset, the API falls back to
  `DEFAULT_API_CORS_ALLOWED_ORIGINS` in `apps/api/src/config.ts`, which includes
  local development origins — set it explicitly in production

## The host reuses its layer cache between builds

Scope: the two preview **Application** services (see "Pull request preview
deployments" below) are the only Dokploy services that still build on the host.
Every Compose stack pulls a published image, so nothing below affects how long a
production deploy takes.

The prune stage's `COPY . .` misses on every build — each build is a different
commit and the whole repository is that stage's context. The install layer
survives it anyway, because `turbo prune <package> --docker` emits an `out/json`
that a change outside the package's pruned scope does not move.

Measured on the `api` service across two consecutive deploys, 2026-08-14: b169a72
at 07:17:43 UTC, then 96c4397 at 07:33:17 UTC — a change spanning `apps/cflop`, a
new `packages/cube`, and the root `pnpm-lock.yaml`. Running
`turbo prune @unimatrix/api --docker` at both commits and diffing gives a
byte-identical `out/json`, and the second build reported:

```text
#14 [build 1/5] COPY --from=prune /workspace/out/json/ .
#14 CACHED
#15 [build 2/5] RUN pnpm install --frozen-lockfile
#15 CACHED
#17 [build 4/5] RUN pnpm --filter "@unimatrix/api..." build
#17 DONE 10.5s
```

The cache is shared across services rather than held per service: in that same
window, the `web` build at 07:17:17 reused an install layer a `main` deploy of
the `web-preview` Application service had built 78 seconds earlier. That was an
ordinary branch deploy — PR previews still produce nothing, see "Pull request
preview deployments" below.

It is not durable, though. The host carries no `/etc/docker/daemon.json`, so
BuildKit's default garbage collection applies: read on 2026-08-14 at 07:37 UTC,
the oldest surviving cache record was under three hours old. Treat a layer from a
previous day as gone.

Read the install step off the host per build:

```bash
f=$(ls -t /etc/dokploy/logs/<service>/* | head -1)
awk '/RUN pnpm install --frozen-lockfile/ { id = $1 }
     id && $1 == id && ($2 == "CACHED" || $2 == "DONE") { print; exit }' "$f"
```

A `grep -B1 … | grep -A1 'pnpm install'` pipeline looks equivalent and fails
silently: on a cache miss BuildKit prints progress lines between the step header
and its `DONE`, so it matches nothing and prints the same empty output as a
mistyped service name.

**The saving is seconds.** On `api` the install step is about 10s (`#15 DONE 9.4s`
on the 07:17:43 build) against a whole-image build of 35-47s, and
`pnpm --filter "@unimatrix/api..." build` plus `pnpm --prod deploy` take most of
what is left. Those two totals come from a hand-run `docker build` pair on the host
at b169a72, outside Dokploy, differing by one appended line in
`apps/api/src/server.ts`. On `web` the install step is 13.4s and the image has no
`--prod deploy` stage at all — it hands its `dist/` to nginx.

## A deploy is queued, not applied

A Dokploy deploy is queued rather than applied, however it was triggered. Over
the API, `POST /api/compose.deploy` answers
`200 {"success":true,"message":"Deployment queued"}` and nothing in that response
says when the new configuration takes effect; a redeploy clicked in the UI gives
no completion signal at all. Measured on the `secrets` compose service on
2026-08-10: the container kept its previous environment for roughly seven minutes
after the 200, while `docker ps` reported it `Up N minutes (healthy)` throughout.
That is one observation rather than a bound — treat the lag as minutes of
unpredictable length, not as a figure to code a timeout against.

First establish whether the container was **recreated**:

```bash
docker ps --filter name=<service> --format '{{.CreatedAt}}'
```

Read it before the deploy and again after; the value changing is recreation evidence,
not proof that the requested image or configuration landed. A restart does not move it, so
a crash loop cannot fake recreation. An empty result means the container is
between the old one and the new one — `docker ps` lists running containers only —
and looks identical to a mistyped service name, so confirm the filter matches
before the deploy rather than after.

For a recorded attempt, compare full before/after container IDs and independently verify that
the new container uses the requested immutable image digest, following "Deployment-attempt
ingestion and image correlation" above. The current observer cannot provide that digest evidence.
For an env-only change, image identity still cannot prove which runtime values took effect;
use the operation's own readback checks before acting on the new configuration.

A 200 is not the signal, and neither is a healthy status: the old container goes
on reporting healthy while it runs the configuration you believe you replaced.

This binds on any runbook that edits an environment variable in Dokploy and then
acts on the new value. The KEK rotation runbook under "Secrets service" above is
the worst case, because acting inside the window re-seals rows under the very key
that is about to be retired, and then deletes the key still holding them. Its
steps 4 and 5 refuse outright when the ring is not the one they were told to
expect, which closes that particular hole — but the guard lives in those two
CLIs, while the lag belongs to Dokploy and reaches everything else that redeploys
to change a value.

## Pull request preview deployments

Previews are entirely Dokploy-side. **Nothing in this repository is required**
— no workflow, no secret, no token, no permission change. The Dokploy GitHub
App's installation token drives the webhook, the build, the PR comment, and
the teardown.

The setting defaults below were verified on 2026-07-27 against
`packages/server/src/db/schema/application.ts` on Dokploy `canary`, against
Dokploy issue #2028 for the Compose limitation (open, unassigned, no linked PR,
opened 2025-06-11), and then against the live instance: creating an application
over the API returns `previewPort: 3000`, `previewHttps: false`,
`previewCertificateType: "none"`, `previewLimit: 3`, and
`isPreviewDeploymentsActive: false` on the fresh record.

The `web-preview` and `cflop-preview` services live in the `Unimatrix-01`
project's `production` environment, configured as below. Their settings live in
Dokploy's database rather than in this repo, so this document describes intent —
read the instance, not this file, when the two disagree.

> **Previews do not currently work, and the cause is upstream.** The services
> are configured correctly but no preview has ever built. On Dokploy v0.29.13,
> a `pull_request` webhook for `synchronize`/`reopened` gets as far as
> `✅ SECURITY: Preview deployment authorized ... Permission: admin` and then
> dies with `TRPCError: Github Account not configured correctly`
> (`code: NOT_FOUND`) from `apps/dokploy/pages/api/deploy/github`, returning
> HTTP 500 to GitHub. `push`, `opened`, and `closed` deliveries return 200.
>
> The credentials are **not** actually missing: the same provider record clones
> fine for every production Compose service, and `authGithub` succeeds
> earlier in that very request — it is what emits the SECURITY line. A second
> provider lookup later in the preview path resolves to nothing. Ruled out by
> testing: webhook signature, `previewWildcard` format (the `*.` prefix is
> required, not wrong), `previewCertificateType`, `previewBuildArgs`, and
> git-provider ownership/sharing.
>
> Do **not** "fix" this by recreating the GitHub provider — that would re-point
> every production service for no reason. Next step is a Dokploy upgrade
> past v0.29.13 and, failing that, an upstream bug report.

### Previews need Application services, not the existing Compose apps

The `infra/docker/*-compose.yaml` files run as Dokploy **Compose** apps,
and Dokploy has no preview support for that service type: all thirteen
`preview*` columns live on `applications`, and `compose` has none of them.
This is not a configuration gap that can be filled in — the fields do not
exist on the record.

So a previewable app needs a **second** Dokploy service alongside its
production Compose app, of type Application, reusing the same Dockerfile
unchanged:

- Build type: `Dockerfile`
- Dockerfile path: `apps/web/Dockerfile` / `apps/cflop/Dockerfile`
- Docker context path: `.` — the repo root, matching the build rule in
  `infra/docker/README.md`
- Preview port: **8080**

### Settings whose defaults are wrong for this repo

Defaults quoted verbatim from the schema (see the verification note above).

| Setting | Dokploy default | Needs to be | Why |
| --- | --- | --- | --- |
| `previewPort` | `.default(3000)` | `8080` | Both previewable images serve on 8080 (`listen 8080` in every `apps/*/nginx.conf`). Leaving the default produces a domain that resolves and then dead-ends. |
| `previewHttps` | `.notNull().default(false)` | `true` | An `http://` preview origin is rejected by the API's CORS rule — every entry in `DEFAULT_API_CORS_ALLOWED_ORIGINS` (`apps/api/src/config.ts`) is scheme-qualified `https://` for the public domains. With HTTPS on, the existing `https://*.unimatrix-01.dev` entry already matches preview hosts, so no repo change is needed. |
| `previewCertificateType` | `.notNull().default("none")` | issue certs | TLS is not automatic. Needs either per-host Let's Encrypt or a wildcard cert covering the preview domain. |
| `isPreviewDeploymentsActive` | `.default(false)` | `true` | Off until switched on per application. |
| `previewRequireCollaboratorPermissions` | `.default(true)` | leave `true` | The public-repo guard. See "Fork PRs" below. |

`apps/auth/src/features/auth/safe-redirect.ts` also requires
`protocol === "https:"` for any `unimatrix-01.dev` host, but that is the auth
app, which is deliberately not previewed — it is not what forces `previewHttps`
here. The CORS rule is.

### The preview domain is a prerequisite, not polish

Dokploy's default preview domain is an auto-generated `*.traefik.me` host. For
`apps/web` that is not a cosmetic choice: a `.traefik.me` origin matches no
entry in `DEFAULT_API_CORS_ALLOWED_ORIGINS`, so the preview loads and then
fails every API call. A half-working preview is worse than a broken one.

Set `previewWildcard` to a wildcard under `unimatrix-01.dev` (e.g.
`*.preview.unimatrix-01.dev`) and point a wildcard `A`/`CNAME` record at the
Dokploy server before enabling previews. `apps/cflop` would survive the
default (no API dependency), but there is no reason to split them.

### Three behaviours that are invisible from the UI

- **Watch paths do not apply to pull requests.** The `push` handler filters by
  watch path; the `pull_request` handler does not, so a watch path set on one of
  these Application services throttles its branch deploys and never its
  previews. Every PR against `main`
  rebuilds every previewable app — a docs-only PR triggers two full repo-root
  `pnpm install --frozen-lockfile` plus workspace builds and posts two bot
  comments. If that is too much load, the throttle is the preview **label**
  gate. Note its sharp edge: labels gate creation and rebuild only. Removing
  the label does **not** tear an existing preview down, so it is not a kill
  switch.
- **`previewLimit` (default 3) fails silently.** Exceeding it skips the
  deployment with no PR comment and no error, so a missing preview is not
  evidence that something broke.
- **Web previews run the new frontend against the *production* API.** Only web
  and cflop are previewed, and web's preview build arg points
  `VITE_API_BASE_URL` at the live API. A PR that changes both `apps/web` and
  `apps/api` therefore previews the new UI against the old backend: a contract
  change can look broken in preview when it is fine, and — the dangerous
  direction — can look fine when it is not.

Preview target-branch matching uses `pull_request.base.ref`, so only PRs
targeting `main` produce previews. Teardown is automatic on PR `closed`, which
covers merges.

### Fork PRs

Two independent barriers, which matters because this repo is public:

1. `previewRequireCollaboratorPermissions` defaults to `true`, so only
   write/maintain/admin actors pass.
2. The clone runs `git clone --branch <pull_request.head.ref>` against the
   **base** repo, where a fork's head branch does not exist — so a fork
   preview would fail at clone even with the gate disabled.

Dokploy's own documentation still recommends against preview deployments on
public repositories, on the grounds that external contributors can trigger
builds on your server. The gate above is what makes that recommendation
survivable here, so do not disable it.

### Which apps to preview

- **`apps/cflop`** — the clean case. No build args, no backend, no env;
  progress lives in `localStorage`.
- **`apps/web`** — point previews at the production API. The site carries no
  Clerk key at all, so every preview is anonymous by construction.
- **`apps/auth`** — **do not preview.** Not for secret exposure:
  `VITE_CLERK_PUBLISHABLE_KEY` is public by design and `CLERK_SECRET_KEY`
  never enters the auth image (it is API-only). The real reason is that
  previewing auth means adding ephemeral hostnames to the production Clerk
  instance's allowed origins and redirect URLs — and any HTTPS preview host
  under `unimatrix-01.dev` then becomes a valid post-authentication redirect
  target for real user sessions.

### What to click in Dokploy

1. Install the Dokploy GitHub App on the `unimatrixcore` org and grant it
   access to `unimatrix-01`.
2. Create a new **Application** service for `apps/web` (alongside, not
   replacing, the existing Compose app). Set build type Dockerfile, Dockerfile
   path `apps/web/Dockerfile`, context path `.`.
3. Repeat for `apps/cflop` with `apps/cflop/Dockerfile`.
4. On each, open Preview Settings and enable preview deployments.
5. Set Preview Port to `8080` on both — the default of 3000 is wrong here.
6. Enable Preview HTTPS and choose a certificate type. This is required, not
   cosmetic: an `http://` preview origin fails the API's CORS check.
7. Set the preview wildcard domain, and confirm DNS resolves it to the server
   (a wildcard `A`/`CNAME` under `unimatrix-01.dev`).
8. Leave "require collaborator permissions" enabled.
9. Set `previewLimit` deliberately — the default of 3 skips silently once
   exceeded.
10. For `apps/web`, set preview build args to the production
    `VITE_API_BASE_URL`.
11. Optionally add a `preview` label gate if per-PR build load is a problem.

### Doing it over the API instead of the UI

Every *Dokploy-side* step above is reachable through its REST API, so the
service creation and preview configuration can be scripted or handed to an
agent rather than clicked — that is how the current services were created. The
two prerequisites that live outside Dokploy are not scriptable with a key; see
below. Generate a key under Settings -> Profile (API/CLI section); it is sent
as an `x-api-key` header.

Two things that cost time when scripting it:

- **`/api/openapi.json` returns 404 on this instance.** Swagger is restricted to
  authenticated administrators by default, so the machine-readable field list is
  not available to a key alone. Discover shapes from validation errors instead —
  a `400` returns a `zodError.fieldErrors` map naming exactly what is missing.
- **`application.saveBuildType` requires `herokuVersion` and `railpackVersion`**
  even for a Dockerfile build. They are non-optional but nullable, so pass
  `null`. Omitting them fails with
  `"expected nonoptional, received undefined"`.

The relevant endpoints are `POST /api/application.create` (needs `name` and
`environmentId` — read the latter from `project.all`),
`POST /api/application.saveGithubProvider`, `POST /api/application.saveBuildType`,
`POST /api/application.update`, and `POST /api/application.deploy`. Every
preview column is writable through `application.update`:
`isPreviewDeploymentsActive`, `previewPort`, `previewHttps`, `previewWildcard`,
`previewLimit`, `previewCertificateType` (`"letsencrypt" | "none" | "custom"`),
`previewRequireCollaboratorPermissions`, `previewBuildArgs`, plus `previewEnv`,
`previewBuildSecrets`, `previewLabels`, `previewPath`, and
`previewCustomCertResolver`.

Two things this does not remove: installing the GitHub App is an OAuth consent
flow that cannot be done with the key, and the wildcard DNS record lives at the
registrar.

Treat the key accordingly. It is a bearer credential with no scoping and no
expiry, granting instance-wide administrative control: it can create, mutate,
and delete every application on the Dokploy instance — not only this project's
— and trigger builds. Since a build runs a Dockerfile of the holder's choosing
on the host, treat that reach as host-level in practice even though the key
itself is not an OS credential. A key issued for a one-off task still gets
revoked when that task is done.

One such key is a standing exception: `DOKPLOY_API_KEY` in this repository's
Actions secrets, with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
beside it to get past Cloudflare Access. That reverses the rule this section
carried until 2026-08-14 — issue a key per task, never in CI — and it was
reversed on purpose: Dokploy has no scoped or per-project key to issue instead,
and the narrower per-service webhook credential requires `autoDeploy: true`,
which is exactly the control that stops every push deploying every service (see
"How a deploy is triggered" above). What makes it tolerable is that Actions
secrets are not exposed to workflows triggered by fork pull requests, so an
outside contributor cannot reach them. What it costs is that anyone who can
push to `main` can reach the whole instance.

The Cloudflare half is an Access **service token** named `github-actions-deploy`,
allowed by a Service Auth policy on the `Dokploy control panel` application. It
sits behind the existing owner-email policy rather than replacing it, so it
grants no browser access to anyone.

**It expires 2027-08-14, and its lapse is silent.** An expired service token
does not fail closed with an error a reader would recognise — Cloudflare answers
the runner with a 302 to the login page, exactly as it did before the token
existed, and `Deploy` reports it as `POST /api/compose.deploy returned 302`.
Nothing warns beforehand. Minting a replacement and updating the two Actions
secrets is the whole fix; the policy references the token by id, so a new token
needs the policy updated too.

**Cloudflare Bot Fight Mode must stay off on `unimatrix-01.dev`.** With it on,
a GitHub-hosted runner reaching Dokploy is refused with a 403 while the
identical request from a residential address succeeds. Every credential
therefore tests correct by hand — the API key, the service token, the Access
policy — and `Deploy` still fails on `GET /api/project.all returned 403`, which
points at nothing.

The free-plan setting is zone-wide, and no attempt was made to scope it to
`dokploy.unimatrix-01.dev` alone; Super Bot Fight Mode on a paid plan runs on
the Ruleset Engine and takes a skip rule, which is the upgrade to make if the
zone needs bot filtering back. What guards the sensitive hostnames is
Cloudflare Access, unaffected either way.

## Verification after deploy

Verify these URLs after each production rollout:

- `https://site.example.com/`
- `https://site.example.com/about`
- `https://site.example.com/blog`
- `https://site.example.com/projects`
- `https://api.example.com/health`
- `https://cflop.unimatrix-01.dev/`
- `https://cflop.unimatrix-01.dev/learn`
- `https://cflop.unimatrix-01.dev/drill`
- `https://cube.unimatrix-01.dev/learn` — must 301 to
  `https://cflop.unimatrix-01.dev/learn`, preserving the path
- `https://auth.unimatrix-01.dev/`
- `https://auth.unimatrix-01.dev/sign-in`
- `https://auth.unimatrix-01.dev/account`

Also verify that refreshing a deep route on the public site, cflop, or
the auth app still renders the SPA instead of returning a proxy or
static-host 404.

## Troubleshooting

- **`Nixpacks build failed` / `Failed to read app source directory / Not a directory`**:
  the Dokploy service was created as the default **Application** type, which
  auto-detects a builder (Nixpacks) and cannot build this pnpm monorepo. Every
  service here must be a **Compose** application pointing at its
  `infra/docker/*-compose.yaml` file (see the per-service sections above), which
  pulls a published image and builds nothing. Recreate the service as a Compose
  application rather than editing the Nixpacks one.
