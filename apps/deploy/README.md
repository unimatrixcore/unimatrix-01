# Deploy service

A Fastify service deployed from `apps/deploy/Dockerfile` through
`infra/docker/deploy-compose.yaml`. It is unrouted — no domain, no Traefik
entry. `GET /health` is anonymous; every other request requires a deploy service token,
including requests to unmatched URLs. Production serves HTTPS.

All requests share a per-peer IP limit of 60 per minute, including anonymous health checks and
unmatched URLs. The limiter runs before token lookup and body parsing; exhausted callers receive
429 with `Retry-After`. Forwarded IP headers do not change the peer identity. The in-memory limit
resets on process restart.

## The irreducible bootstrap set

Three credentials can never come from the secrets store this service will
eventually manage, and this service cannot be what creates itself in Dokploy
the first time:

- **The Dokploy API key** (`DOKPLOY_API_KEY`) — it is what the env apply uses to reach Dokploy in the
  first place, so it cannot itself be fetched from the store.
- **This service's own secrets-store read token** (`SECRETS_PLATFORM_READ_TOKEN`)
  — issuing it needs the secrets service already running and reachable, which
  this service's own deploy cannot depend on. It arrives at invoke time via
  `docker exec --env-file`, never as compose env: it is never at rest in
  Dokploy's `env` column and never in `infra/docker/deploy-compose.yaml`.
- **`SECRETS_KEKS`** — never held by this service at all; named here only
  because it is the same root-set reasoning. See `packages/secrets/AGENTS.md`
  §4 for the store-side floor these three sit beside.

## Production setup

Follow the [new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding) and the
[deploy service configuration](../../docs/deployment.md#deploy-service) before the first deploy.

### TLS

Set `DEPLOY_TLS_CERT_BASE64` and `DEPLOY_TLS_KEY_BASE64` to base64-encoded PEM material before
deploying the production image. Both are required in production. Generate the pair once on a trusted
host, preserve it across redeploys, and keep the key out of Git, images and caller configuration.
The certificate SAN must include `deploy`, the Compose DNS name callers verify:

```bash
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout deploy-key.pem -out deploy-cert.pem -subj '/CN=deploy' \
  -addext 'subjectAltName=DNS:deploy'
base64 -w0 deploy-cert.pem > deploy-cert.base64
base64 -w0 deploy-key.pem > deploy-key.base64
```

Transfer the encoded values securely into the deploy service's Dokploy environment. Callers receive
only the certificate and use `createDeployPinnedAgent` from `src/tls.ts` for HTTPS requests; its
certificate replaces the trust store and hostname verification stays enabled. Use `https://deploy:3001`
on the shared network. Never substitute the container healthcheck's disabled loopback verification
for a network request. Certificate rotation requires updating caller pins with the server pair;
check expiry and arrange that coordinated rollout before the certificate expires.

With neither TLS variable set, development and tests may use HTTP. Setting only one, an empty value,
invalid PEM, or a mismatched pair fails startup. The reconciliation CLI does not load HTTP TLS
configuration or caller credentials.

The caller-authentication and TLS rollout has not been verified in production. Before rollout,
provision the pair and confirm a request from a network peer succeeds with the matching pin and
fails with the wrong pin; confirm anonymous `/health` is 200 and an unmatched anonymous URL is 401.

### Service tokens

The host-local CLI uses the deploy database without needing the Dokploy key or TLS material:

```bash
docker exec <deploy-container> node dist/cli/service-token.js \
  issue --name api --capability read
docker exec <deploy-container> node dist/cli/service-token.js list
docker exec <deploy-container> node dist/cli/service-token.js revoke --name api
```

Locally, use `pnpm --filter @unimatrix/deploy-app token` with the same arguments. `issue` prints
the token once; only its SHA-256 digest is stored. Give the plaintext only to its named caller and
send it as `Authorization: Bearer <token>` over pinned HTTPS. `list` returns metadata without token
values or digests. These credentials are separate from secrets-store tokens and the Dokploy key.

Choose `read` for observation callers and `manage` for callers permitted to mutate; `manage` also
permits reads. Protected routes enforce the required capability. Revocation takes effect on the
next request without a restart. For rotation with overlap, issue a new caller name, switch the
consumer, then revoke the old name. A revoked name may be reissued, but its old token stays revoked.
Preserve `deploy-data`: losing the database invalidates issued credentials as well as health history.

## Manual redeploys

Verified admins with Deploys access can POST `{app, requestId}` to
`/deployment/admin/redeploy` on the API. Use a new UUID for each deliberate request and reuse it
when retrying that request. The API forwards the verified session user over its authenticated
service connection; its deploy token needs `manage` capability. The browser holds no Dokploy key.

The internal `/deployment/redeploy` route accepts only a declared app, request UUID and attributed
user. It refuses `deploy`, missing or ambiguous matches, foreign repositories and non-GitHub
sources. It persists a reservation before queueing `compose.deploy` with the attempt UUID marker.
Retries return the same retained record without another mutation, even if Dokploy is unavailable.
Idempotency ends when a resolved record expires from history. Neither service nor project
`IMAGE_TAG` is rewritten: Dokploy deploys its configured image, which may differ from the running image.

Manual records have an unspecified image and no CI run identity or tag-write result. Acknowledged
queueing yields `queued`; transport/server failures retain `unknown`, while definite client
rejection yields `failed`. A changed full container ID observed after the queue claim can record
`recreated`, with the actual observed image, when the baseline is fresh and correlation is unambiguous. This resolves
the overlap guard but cannot establish that the configured image or runtime values landed.
Manual attempts never claim `landed`. The 30-minute deadline yields `timed-out`, which does not
prove Dokploy stopped; later recreation is recorded separately without erasing the timeout.
Unresolved attempts keep blocking new manual requests for the app, including after timeout and
normal history retention. Inspect associated logs and runtime state separately. CI may
still record overlapping work, making correlation ambiguous.

Production manual queueing and UUID association have not been exercised. Before activation,
verify the API's manage token, a controlled queue request, idempotent retry, attributed history and
associated logs; check runtime image/configuration and health separately.

## Container observation

Deployment attempts are persisted separately from the process-local container snapshot. See
[deployment attempt setup](../../docs/deployment-attempts.md) for CI activation, the host-local
immutable image bridge, outcome semantics and the remaining production verification gates.

The running service samples Dokploy's `docker.getContainers` every 30 seconds and keeps the latest
observation in memory for each app in `src/reconcile/desired-state.gen.ts`. A container is associated
with an app only when its image repository matches that app's declared image uniquely. Missing or
multiple matches are `unknown`; they do not establish that the app is down. A failed Dokploy read
also yields `unknown` rather than retaining a stale running result.
An image match alone cannot prove which Compose stack owns a container if another stack uses the
same image repository.

An observed container ID change records recreation. The Docker `status` text is retained for coarse
display, but the response has no creation timestamp, so exact container age is unavailable. The
first observation time measures only how long this service has seen that ID. Observations reset on
service restart and do not establish that a requested image or configuration was deployed.

`GET /deployment/state` returns the snapshot for all declared apps, or one selected by `?app=api`.
Container freshness is `missing` before observation, `fresh` for less than 30 seconds, and `stale`
after that. A stale matched record describes the last observation, not current running state.

## Internal health history

The collector probes each declared app every 60 seconds using the generated internal target in
`src/reconcile/desired-state.gen.ts`. Node services use `/health`; SPA images use `/`. Requests
have a five-second deadline, accept only 2xx responses, and follow no redirects. Response bodies
and upstream error text are discarded. These requests measure internal app reachability; they do
not measure Cloudflare or Traefik availability.

Secrets and deploy health use their declared HTTPS targets and certificate env variables as the
trust store, with hostname verification enabled and no bearer token. A missing or malformed pin produces an
unknown observation. A completed probe that fails HTTP, connection, TLS or deadline checks is down.

SQLite stores at most one observation per app per minute, retaining 30 days plus one minute for
intervals crossing the window boundary. Each observation covers at most the following 60 seconds,
ending sooner if another observation arrives. Missing intervals and stale observations are unknown.
Uptime is up time divided by observed up-or-down time; coverage is observed time divided by the
whole window. With no observed time, uptime is null. Daily summaries use UTC boundaries and include
the elapsed portion of today. The internal snapshot includes the rolling 30-day summary, daily
summaries for today and the preceding 29 UTC days,
and the most recent 60 probes. `GET /deployment/health?app=api` returns that snapshot, including
`missing`, `fresh` or `stale` freshness at the 60-second sampling boundary. A fresh `unknown`
sample is distinct from missing history or a stale sample.

Production uses `/data/deploy.sqlite` on the `deploy-data` Compose volume, separate from the API
and secrets databases. Preserve that volume across redeploys. `DEPLOY_DATABASE_PATH` selects a different
file; local development defaults to `local/deploy.sqlite` relative to the service working directory.
The service initializes its schema on startup and refuses unsupported schema versions. Shutdown
stops and awaits pending probes before closing SQLite.

Check reachability from the deploy container after network or certificate changes; a public URL
succeeding does not establish that these internal targets are reachable.

## Authenticated reads

The deployment read contracts live in `packages/shared/src/contracts/deployment.ts`. Each route
requires a deploy token with `read` or `manage` capability and returns `Cache-Control: no-store`.
App selectors are validated query parameters; an undeclared app returns 404. These routes are
internal service interfaces. Browser consumers reach deployment data through the API.

`GET /deployment/declarations` returns committed deployment metadata, optionally selected by
`?app=api`. The API exposes it at `GET /deployment/admin/declarations` to verified admins with
Deploys access. The generated `src/declarations/manifest.gen.ts` carries compose literals,
generated public values, Dockerfile env defaults, build-arg defaults and variable/secret source
names. Defaults describe declarations, not the running environment or the image's actual build
inputs. The endpoint reads neither process env values, Dokploy env values nor the secrets store;
secret references reveal no value, mask, length or store-availability claim. Metadata describes the
declaration artifact bundled in the running deploy-service image, not the latest repository checkout.
Keep credentials out
of committed literals and defaults. Reconciliation retains its separate value-free manifest.

`GET /deployment/reconciliation` returns the latest scheduled detection snapshot, optionally
limited by `?app=api`. Its `checkedAt` is the response time; `observedAt` identifies the completed
check. Status and scheduling metadata describe the entire run even when `?app` filters its results.
`status`, `freshness`, `nextRunAt` and `intervalMs` distinguish an unchecked service, an
active check, a completed check and failed reads. Freshness describes the recency of a completed
attempt, including a failed attempt; `status: read-failed` means at least one app could not be
checked. Other successfully checked apps retain their findings. Env findings contain only keys
and closed states.
Per-app read failures return `outcome: error` with `reason: read-failed`; an inventory failure
replaces the snapshot with that result for every app. Invalid or oversized detection results also
become failed-read results rather than retaining old success. An invalid response snapshot returns
503, as do observation or health snapshots that cannot be validated or read.

The state and reconciliation routes read process-local snapshots, and the health route reads
SQLite. Reads do not trigger upstream polling or apply configuration. Existing per-peer request
limits apply to all of these routes.

## Scheduled drift detection

The policy is `scheduled-detection-explicit-apply`. The service checks drift when it starts
listening, then schedules the next check 15 minutes after the previous one finishes. Checks do not
overlap; shutdown stops the schedule and awaits an active check. The snapshot resets on restart,
so `not-checked` is distinct from an in-sync result. A failed read replaces the affected findings
with an error rather than presenting the previous result as a successful check.

Detection uses the same key-state and settings diff as `reconcile report`. It does not read the
secrets store or compare stored secret values with Dokploy values: a `set` key establishes
presence only. It creates no service, writes no settings or env, and triggers no deploy.
Undeclared keys and emergency Dokploy edits remain untouched. Resolve drift through the
host-local settings or secrets apply commands below, or by deliberately updating the declaration
or Dokploy configuration. The next scheduled check observes the result; applying configuration
does not refresh this snapshot or prove that a container uses it.

Production scheduling has not been verified. After rollout, confirm a completed check and its
next-run time through the authenticated route, then confirm a subsequent check advances the
observation time without changing Dokploy configuration.

## Reconcile report

`pnpm --filter @unimatrix/deploy-app reconcile report` diffs
`src/reconcile/desired-state.gen.ts` — generated from every `apps/<app>/deploy.config.ts` — against
what Dokploy actually holds, and prints the result. Read-only: it calls only `project.all` and
`compose.one`, never `compose.create`, `compose.update`, or `compose.deploy`.

For each declared app it reports one of `MISSING` (no Dokploy compose service of that name),
`AMBIGUOUS` (more than one, matched globally across every Dokploy project the same way CI's
`Deploy` job does), `IN SYNC`, or `DRIFT` naming which env keys and which of `composePath`,
`sourceType`, `branch`, `autoDeploy` disagree. An env finding is always a key and a state — `set`,
`blank`, `missing`, `optional-absent`, `undeclared`, or `build-arg-runtime-copy` — never a value;
the last state is printed in a separate `BUILD ARG RUNTIME COPIES` section when a Dokploy key
duplicates a declared image build arg.
It does not mask unrelated undeclared keys. Dokploy's `env` blob is
reduced to that before it reaches reconciliation (`readEnvKeyStates`,
`src/dokploy/schemas.ts`).
Unsupported env syntax, including multiline quoted assignments, yields a read failure rather
than allowing value text to be mistaken for an undeclared key.

It deliberately does not check a service's Domains entry (out of scope — `packages/deploy-config`
holds no domain data at all) or its `watchPaths`/`composeFile` (inert while `autoDeploy` is off, and
the inline-source field of a source type this repo does not use).

Same env requirement as `pnpm --filter @unimatrix/deploy-app dev` — `DOKPLOY_BASE_URL` and
`DOKPLOY_API_KEY` on the command line, locally or in production:

    DOKPLOY_BASE_URL=http://localhost:3000 DOKPLOY_API_KEY=<your-key> \
      pnpm --filter @unimatrix/deploy-app reconcile report

## Reconcile apply

`pnpm --filter @unimatrix/deploy-app reconcile apply <app>` writes `composePath`, `branch`, and
`autoDeploy` for one declared app when report would show them drifted — a single `compose.update`
call, settings only. It never writes `env` (no field on the wire payload can hold one — see
`src/dokploy/client.ts`'s `DokployComposeSettingsUpdate`), never calls `compose.create`,
`compose.deploy`, or a domain route, and never touches more than one app per invocation.

It refuses to write, with zero Dokploy calls beyond whatever was needed to reach the decision, when:
the app is this service's own compose entry (`deploy` — a self-write followed by any deploy would
destroy the process performing the reconciliation, and Dokploy has no rollback for a Compose
service); the app is not declared in the manifest; the name matches zero or more than one Dokploy
compose service; the single match is anchored to a different GitHub owner/repository than this one
(`findComposeMatches` matches on service name alone, globally across every project the instance
holds); or the match's `sourceType` disagrees with policy (`sourceType` selects which sibling column
group drives the clone, and this repo declares none of them).

Apply's exit code is not a sync assertion: `apply web` can succeed today on an app `report` still
exits 1 on, because `report` also finds env drift apply deliberately never touches. Run
`pnpm --filter @unimatrix/deploy-app reconcile apply` with no app name for the full exit-code table.

In production: `docker exec <deploy container> node dist/cli/reconcile.js apply <app>`.

    DOKPLOY_BASE_URL=http://localhost:3000 DOKPLOY_API_KEY=<your-key> \
      pnpm --filter @unimatrix/deploy-app reconcile apply api

## Secrets status

`pnpm --filter @unimatrix/deploy-app reconcile secrets-status <app>` resolves the secrets-store
values one declared app's manifest entry names — the `secretName` on each `secrets-store`-kind
`composeEnv` entry — against the store this service holds a read-only token for. It writes nothing,
to the store or to Dokploy, and never prints a value, a length, or a prefix: only whether each
declared name resolved, and whether a resolved value is single-line (a stored value with real
newlines is refused by env apply). Run
`pnpm --filter @unimatrix/deploy-app reconcile secrets-status` with no app name for the full
exit-code table.

The store is read lazily by `secrets-status` and `secrets-apply` — `report` and `apply` never touch a store
variable, so a store left unconfigured cannot affect either of them.

In production: `docker exec <deploy container> node dist/cli/reconcile.js secrets-status <app>`. The
read token (`SECRETS_PLATFORM_READ_TOKEN`) arrives via `--env-file` on that `docker exec`, never as
compose env:

    docker exec --env-file /path/to/token.env <deploy container> \
      node dist/cli/reconcile.js secrets-status api

## Secrets apply

`pnpm --filter @unimatrix/deploy-app reconcile secrets-apply <app> [--overwrite]` resolves every
manifest-declared store name before reading Dokploy. It refuses self, unknown, ambiguous,
foreign-repository and non-GitHub targets. It fills missing keys; a differing existing value requires
`--overwrite`. Empty values, real CR/LF or NUL characters, Dokploy `${{...}}` references and duplicate declared keys are refused before
any write. Existing blobs using `export`, multiline quoted assignments, or syntax the shared
physical-line parser cannot safely identify are refused as a whole; no key-like line inside
another value can be replaced. Keys must use the environment-name grammar `[A-Za-z_][A-Za-z0-9_]*`. A blank existing assignment is an existing value and also requires `--overwrite`.

The merge preserves every unrelated byte, including `IMAGE_TAG=${{project.IMAGE_TAG}}`, comments,
blank lines and line endings. Comparison trims assignment padding and removes one matching outer
quote pair. Single-quoted values decode escaped single quotes; double-quoted values decode JSON
escapes and doubled dollars. Unquoted inline comments are excluded from comparison, and
interpolated values cannot establish equality with a literal secret. New values containing dotenv syntax or edge whitespace are
double-quoted, with escaped backslashes, quotes and dollars so Compose treats them literally. Dokploy reference syntax is refused because
Dokploy expands it before Compose sees the file. Values are never printed or persisted.
After a write it re-reads and compares each declared value, since a legal 200 can silently drop env.
Exit codes: 0 applied and verified, 1 already in sync, 2 refused, 3 write status unknown, 4 read
failure, 5 verification failed. After exit 3, inspect state before retrying with overwrite.

Use the same invoke-time token setup as secrets status:

    docker exec --env-file /path/to/token.env <deploy container> \
      node dist/cli/reconcile.js secrets-apply api

This updates stored configuration and triggers no deploy. The correction window lasts until the
next merge to `main`, which triggers deployment. Avoid concurrent Dokploy env edits during apply:
`compose.update` replaces the whole blob and provides no conditional-write guard.

## Local development

No `.env` file support and no `dotenv` dependency, same reasoning as
`apps/secrets`: loading one would put the Dokploy API key on a developer's
disk. Supply both variables on the command line:

    DOKPLOY_BASE_URL=http://localhost:3000 DOKPLOY_API_KEY=<your-key> \
      pnpm --filter @unimatrix/deploy-app dev
