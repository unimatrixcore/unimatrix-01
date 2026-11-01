# AGENTS.md

## 1. Overview
`apps/deploy` is a Fastify service holding a typed Dokploy API client, a read-only reconcile report,
and a settings-only apply (`src/reconcile/`, `pnpm --filter @unimatrix/deploy-app reconcile`): it
diffs `src/reconcile/desired-state.gen.ts` against what Dokploy actually holds, prints drift, and can
write `composePath`/`branch`/`autoDeploy` for one app at a time. It observes containers and persists
internal HTTP health probes in its own SQLite database. It queues authenticated manual redeploys
without changing image tags. It creates no services — see
`README.md` for what still has to happen by hand before
this stack deploys, and for apply's full refusal set. It also holds a read-only resolver against the
secrets store (`src/secret-env/`, `reconcile secrets-status <app>`) that resolves declared
values and applies them to Dokploy only through `secrets-apply` — it holds no write capability
against the store, and
`src/reconcile/` holds none of that resolver's read capability either; see §2's last two rules.

## 2. Rules

- **The Dokploy key is unscoped and unexpiring, and can delete every application on the instance.**
  It comes only from container env (`DOKPLOY_API_KEY`), is read once by `loadDokployApiKey`
  (`src/dokploy/client.ts`) into a closure, and never lands on `runtimeConfig` — which is decorated
  onto the Fastify instance and therefore reachable from every handler and every log call. No log,
  error message, or derived value of it (including a length or a prefix) may exist.
- **`src/config.ts` imports no workspace package.** `infra/scripts/validate-deploy-config.mjs`
  imports it directly, before anything is built, and `@unimatrix/shared`'s main entry resolves only
  through `dist` — the same reasoning as `apps/secrets/src/config.ts`. (Its `./secrets-registry`
  subpath points at `src` instead, for the same reason: `deploy.config.ts` files load the same way.)
- **Only `GET /health` is anonymous; unmatched URLs also require a deploy service token.** Network
  membership proves no caller identity. Protected routes enforce `read` or `manage` against the
  verified token identity; `manage` includes reads. Never accept a caller identity or capability
  from request input. Tokens belong to this service's SQLite store, never the secrets token store;
  plaintext appears only at host-local issuance and on the authenticated wire, never in logs.
- **Production requires pinned HTTPS.** `src/tls.ts` loads the certificate/key separately from
  `runtimeConfig`; private key material must stay off that decorated object. The certificate SAN
  must include `deploy`, because hostname verification stays enabled in network clients. The
  generated Docker healthcheck alone skips verification on its loopback connection. Keep host-local
  reconciliation and token-management CLIs independent of HTTP TLS configuration.
- **Dokploy is tRPC-derived: every call is `GET|POST /api/<router>.<procedure>`**, never a REST
  resource path, and `/api/openapi.json` 404s on v0.29.13, so schemas are hand-written rather than
  generated. Only add a procedure whose response has actually been observed —
  `docker.getContainers`, `settings.getDokployVersion`, `project.all`, `compose.one`, and
  `compose.update` are implemented in `src/dokploy/client.ts`; the observed `compose.deploy` queue
  mutation is isolated in `src/dokploy/redeploy-client.ts`. The installed v0.30.10 deployment
  reads (`deployment.allByCompose`, `deployment.readLogs`) are isolated in `src/dokploy/log-client.ts`;
  raw log output must be reduced to closed diagnostic events inside that client's schema transform.
  `DokployClientError` (`src/dokploy/transport.ts`)
  never carries a response-body fragment, on any property: `project.all` returns every project's
  whole environment-variable blob and `compose.one` returns one service's, both in plaintext.
- **`callProcedure` hardcodes `method: "GET"` and stays read-only; mutations go through the separate `callMutation` instead.** `callMutation` never reads a 200
  body — the fork's `update` procedure returns the whole updated compose row, `env` plaintext
  included, and `void` on success is the only return shape that cannot carry it. A non-2xx body is
  reduced to the error `code` and the `zodError.fieldErrors` key names only — never the zod message,
  which can echo the offending value, and never the row.
- **The settings mutation uses `compose.update` with a closed
  `{composePath?, branch?, autoDeploy?}` payload** (`DokployComposeSettingsUpdate`) —
  `compose.create` remains absent because it needs an `environmentId` nothing in this repo
  declares. Manual redeploys use a separate closed capability accepting only a resolved compose ID
  and durable attempt ID; no procedure name or image tag comes from the caller. `env` has no
  field on that type. `DokployEnvClient` is the separate env capability; it reveals a `SecretValue`
  only for the wire payload. `src/reconcile/` must not import `dokploy/env-client`,
  `dokploy/transport`, or `dokploy/env-line`; the transport exposes a general mutation primitive.
  `apps/deploy/src/reconcile/apply.ts`'s `applyAppSettings` refuses to write against this service's
  own compose entry (`RECONCILE_SELF_APP_DIR`, checked before any network call): `compose.update`
  there followed by any deploy would destroy the process performing the reconciliation mid-run, and
  Dokploy has no rollback for a Compose service (`docs/deployment.md`). Manual redeploys also
  refuse self before network calls and atomically
  reserve an app in SQLite, refusing unresolved overlaps even after timeout. They record the verified
  API session user, no CI run identity and no immutable target image; they cannot claim `landed`.
  Settings apply also refuses an app not in
  the manifest, a name that matches zero or more than one Dokploy compose service, a match anchored
  to a different GitHub owner/repository than this one's (`findComposeMatches` matches on service
  name alone, globally across the instance, and reads no `projectId`), and a `sourceType`
  disagreement (it selects which sibling column group drives the clone, and this repo declares none
  of them). `autoDeploy`'s written value always comes from the `RECONCILE_AUTO_DEPLOY` policy
  constant, never from the diff's `declared` string — the fork's `coerceSchema` treats `autoDeploy`
  as `z.coerce.boolean()`, under which the string `"false"` coerces to `true`.
- **`compose.update` is the only HTTP route on v0.29.13 that can write a compose service's `env`.**
  `compose.saveEnvironment` exists as a tRPC procedure but is absent from the exposed path map, so the
  sibling env client must use this same procedure rather than reaching for a narrower one.
- **`src/reconcile/desired-state.gen.ts` is generated** — edit the relevant
  `apps/<app>/deploy.config.ts` and run `node ./infra/scripts/generate-deploy-config.mjs`, not this
  file. It carries no value from any source, only structure: a `secrets-store`-kind env entry names
  the secrets-store key it expects (`secretName`) but never that key's stored value, and each
  service's `publicStatus` is a policy flag, not a credential.
- **No env value crosses `src/reconcile/`'s boundary, ever — only a key and a closed state.**
  `readEnvKeyStates` (`src/dokploy/schemas.ts`) reduces Dokploy's plaintext `env` blob to
  `{key, blank}` inside its own schema transform, so the plaintext exists only as that function's
  parameter; nothing downstream — the diff, the report, the CLI — ever holds a field that could
  carry a value. This is `docs/deployment.md`'s "never print a response body" rule applied one layer
  deeper than the client.
- **`src/secret-env/`'s store connection is read lazily on the
  `secrets-status` or `secrets-apply` CLI path — never from `src/config.ts`.**
  `loadDeployRuntimeConfig()` runs on every
  boot of this service and on every `reconcile report`/`reconcile apply` invocation; none of the three
  is a field on `DeployRuntimeConfig`, so a store left unconfigured cannot fail any of those.
  `store.ts`'s `loadSecretsPlatformReadToken` mirrors `loadDokployApiKey`'s shape: the token lives
  only in the closure `createSecretsClientFromEnv` builds, and never on `runtimeConfig` — this service
  builds no Fastify instance for `secrets-status` at all, but the rule is the same one the Dokploy key
  follows. The token itself arrives via `docker exec --env-file` at invoke time; it is never declared
  in `infra/docker/deploy-compose.yaml` and never at rest in Dokploy's `env` column.
- **Health probes hold no secrets-store token.** `src/health-history/` reads the declared TLS
  certificate for anonymous `/health` requests, with hostname verification enabled. Missing pin
  configuration yields unknown; never substitute the loopback Docker healthcheck's disabled TLS
  verification for a request crossing the network. Probe history lives on the deploy-owned volume,
  never in `@unimatrix/db`; shutdown must finish pending probes before closing that database.
- **`src/reconcile/` never imports `src/secret-env/` or `@unimatrix/secrets`, in either direction of
  data.** `boundaries.mjs` grants this workspace the `secrets` package edge as a whole (it has no
  per-directory granularity); `restricted-imports.mjs` narrows that edge to `src/secret-env/`, the
  only place holding read capability against the store, and
  `test/reconcile-value-isolation.test.ts` pins the same rule structurally by reading `src/reconcile/`
  off disk. `src/secret-env/status.ts` reads `DEPLOY_DESIRED_STATE` and `RECONCILE_SELF_APP_DIR`
  itself rather than taking either from a caller — data flows manifest → `secret-env`, never through
  `reconcile`. This service holds no write capability against the store. Apply outcomes carry only
  closed states
  and declared keys; resolved values remain in `SecretValue` wrappers inside the env capability.
