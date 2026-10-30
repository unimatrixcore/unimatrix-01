# Deploy service

A Fastify service deployed from `apps/deploy/Dockerfile` through
`infra/docker/deploy-compose.yaml`. It is unrouted — no domain, no Traefik
entry — and `GET /health` is the only route it answers.

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
