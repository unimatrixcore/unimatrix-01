# Secrets service

The secrets service is a Fastify service deployed from `apps/secrets/Dockerfile`
through `infra/docker/secrets-compose.yaml`.

For production setup, follow the
[new-app onboarding checklist](../../docs/deployment.md#new-app-onboarding).

Every request except `GET /health` carries a bearer service token or is
answered 401, including a request to a URL matching no route. Reaching this
service over the network is not authorization.

| Route | Capability | Returns |
| --- | --- | --- |
| `GET /secrets/value` | `read` | The decrypted value for one in-scope name — the only route anywhere in this service that returns one |
| `GET /secrets` | `write` or `manage` | Metadata (masked prefix, KEK version, timestamps) for every in-scope name, plus the active KEK version |
| `POST /secrets` | `write` or `manage` | Metadata for a newly created secret |
| `POST /secrets/rotate` | `write` or `manage` | Metadata for a freshly sealed version of an existing secret |
| `DELETE /secrets` | `manage` | `{ affected: <count> }`; denies the whole request if any submitted name is out of scope or absent |

A caller's token scope also governs every route above: a name reaches a route only when the
token's `scopePrefix` covers it (`src/service-tokens/scope.ts`). Every denial — wrong capability,
out-of-scope name, absent name — comes back the same 404, so none of the three is distinguishable
from outside.

`POST /secrets`, `POST /secrets/rotate` and `DELETE /secrets` each accept an optional
`actorUserId` in the body and record it on the audit row they write. It is an assertion by the
calling, service-token-authenticated caller — not a fact this service verifies — and feeds no
authorization decision; omitting it lands `null`. `POST /secrets` reports a name that already
exists as `409 CONFLICT`, distinct from the `400 VALIDATION_ERROR` a malformed body gets.

## Local development

Requires a KEK — the service refuses to start without one. There is no `.env`
file support here (unlike `apps/api`): loading one would put a plaintext KEK
on a developer's disk, the exact artifact this service exists to avoid
multiplying. Supply `SECRETS_KEKS` on the command line instead, generating the
key with `kek generate` (see "Managing the KEK ring" below):

    SECRETS_KEKS=1:$(pnpm --filter @unimatrix/secrets-app exec tsx src/cli/kek.ts generate | head -1 | cut -d: -f2) \
      pnpm --filter @unimatrix/secrets-app dev

Migrations run out-of-band in dev, same as `packages/db`:

    pnpm --filter @unimatrix/secrets-app db:migrate

`DB_MIGRATE_ON_START=true` applies pending migrations at boot instead — the
production default (see `infra/docker/secrets-compose.yaml`).

## Issuing a service token

Tokens are minted by a host-local CLI rather than a route — a minting endpoint
would need a credential of its own to protect it. Issuance needs the database
but never `SECRETS_KEKS`.

Locally:

    pnpm --filter @unimatrix/secrets-app run token \
      issue --name api --scope github --capability read

In the container, against the live volume:

    docker exec <container> node dist/cli/service-token.js \
      issue --name api --scope github --capability read

`--capability` has no default: `read` may fetch values under its scope,
`write` may create and rotate but never delete or read one back, and `manage`
may create, rotate and delete but never read one back. Capability is
single-valued, so a consumer needing more than one takes more than one token.

The plaintext is printed once and only its SHA-256 digest is stored, so a lost
token is reissued rather than recovered. `list` shows every token with its
scope, capability and revocation state; `revoke --name <name>` retires one. A
revoked name is free to `issue` again — uniqueness applies only among active
tokens — and the revoked row stays visible in `list` alongside the new one.

## Managing the KEK ring

Two more host-local CLIs sit beside `service-token`, both under `src/cli/`
and neither taking a `--kek` flag — `docker exec` already inherits
`SECRETS_KEKS`, and argv is world-readable on the host.

Locally:

    pnpm --filter @unimatrix/secrets-app exec tsx src/cli/kek.ts generate
    pnpm --filter @unimatrix/secrets-app exec tsx src/cli/kek.ts verify --expect-active <n>
    pnpm --filter @unimatrix/secrets-app exec tsx src/cli/kek.ts rotate --to-version <n>

In the container, against the live volume:

    docker exec <container> node dist/cli/kek.js generate
    docker exec <container> node dist/cli/kek.js verify --expect-active <n>
    docker exec <container> node dist/cli/kek.js rotate --to-version <n>

`generate [--version <n>]` prints one `<version>:<key>` entry — never the rest
of the ring — to prepend to `SECRETS_KEKS`, bounded to versions 1-9999 and
refusing one already in a loaded ring or not greater than its active version.
`verify --expect-active <n>` and `rotate --to-version <n>` both require the
flag and both refuse outright when `n` does not match `SECRETS_KEKS`'s actual
active version — the version a stale redeploy still carries is caught before
either command trusts it. `verify` censuses every `secret_versions` row from
the envelope's own KEK version field, proves each one opens under a key the
loaded ring carries, and exits non-zero if any row sits outside the active
version even when every row opens; it also records a `kek.verified` audit
row. `rotate` re-seals every row — live and superseded — under the active
version, refuses to run when the ring holds only one version or when any
row's version is missing from the ring, and is resumable: a row already
sealed under the active version is left alone. See
[`docs/deployment.md`](../../docs/deployment.md) for the full rotation
runbook, including how to capture the outgoing key before rotating.

## Reading a value

`secret read --name <name>` is the one host-local CLI permitted to print a
decrypted value — the audited escape hatch, not a bypass of the read-back
restriction in `AGENTS.md` §1: it needs host access in addition to
`SECRETS_KEKS`, and it writes the same `secret.read` audit row `GET
/secrets/value` does, before printing anything.

    pnpm --filter @unimatrix/secrets-app exec tsx src/cli/secret.ts read --name github/token
    docker exec <container> node dist/cli/secret.js read --name github/token
