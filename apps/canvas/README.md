# Synthetic caller proof

This service returns fixed synthetic courses through API-key HTTP routes and OAuth MCP
tools. Both adapters call the same functions in process. `connection: "synthetic"` describes
the fixture, not a usable school connection.

Build dependencies with `pnpm exec turbo run --concurrency=1 build --filter=@unimatrix/canvas-app...`,
then run `pnpm --filter @unimatrix/canvas-app start` with environment supplied by the operator.
The process does not load `.env` files. Keep credentials out of command arguments and shell history.

Required boot settings:

| Setting | Value |
| --- | --- |
| `CANVAS_OWNER_USER_ID` | Stable Clerk `user_…` subject |
| `CANVAS_RESOURCE_URL` | Canonical external HTTPS URL ending in `/mcp` |
| `CANVAS_ALLOWED_HOSTS` | Comma-separated hostnames, including the resource hostname |
| `CANVAS_ALLOWED_ORIGINS` | Comma-separated browser origin hostnames, without scheme or port |
| `CLERK_ISSUER` | Exact signed OAuth issuer, including any trailing slash |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY` | Matching instance credentials and JWT verification key |

`HOST` defaults to loopback and `PORT` to 3020. TLS termination must preserve an allowlisted
raw Host. Forwarded headers are not trusted. Clients without Origin are supported.

`GET /health` is anonymous liveness. Protected-resource metadata is anonymous. Detailed
status is protected. HTTP contracts and response schemas live in `@unimatrix/shared`.
The tool definitions in `src/app.ts` own capability requirements and annotations.

HTTP accepts only provider-managed API keys; MCP accepts only resource-bound OAuth access
tokens. An API key must have a backend-issued `claims.resource` equal to
`CANVAS_RESOURCE_URL`. An account UI that cannot attach that claim cannot issue a usable key
for this service. Use existing account UI for supported account/consent operations; use the
provider backend for scoped, resource-bound issuance when required.

The configured Clerk instance must support signed `at+jwt` access tokens with this resource
audience, signed scopes, and online verification. Opaque tokens fail closed. The live trial
found that an already-issued JWT remains usable after its refresh grant is revoked; see
[the acceptance evidence](PROOF.md) before adding coursework workflows. Changing provider,
token format or substituting local keys requires an owner decision.

## External acceptance

Choose the temporary HTTPS endpoint before configuring external infrastructure. Bind its
canonical URL into both provider issuance and service configuration. Keep the endpoint
synthetic throughout these checks.

Record client/version, UTC time, endpoint, requested/granted scopes, sanitized status/result
and request ID. Never record tokens, authorization codes, raw JWT claims, callback URLs with
codes, or school data. Record each client's results independently:

| Caller | Required observation | Result |
| --- | --- | --- |
| ChatGPT | Discovery, owner sign-in/consent, `canvas_list_courses` call, renewal, revocation | Consent and all tools passed; renewal unobserved; issued JWT remained usable after grant revocation |
| Codex | Discovery, owner sign-in/consent, `canvas_list_courses` call, renewal, revocation | All tools and renewal passed; issued JWT remained usable after grant revocation |
| Script | Scoped API-key issuance, HTTP courses/status, expiry, revocation, insufficient scope | Passed through temporary HTTPS endpoint |
| Negative callers | Wrong owner/resource, missing scope, API key on MCP, OAuth on HTTP | Live wrong-owner 403, API-key resource/scope denials and Codex reduced catalog passed; other OAuth cases pending |
| Browser | Account/consent flows and any supported existing account UI | Both clients' owner consent passed; account UI cannot attach required API-key claims |
| Provider | Enabled OAuth/API-key features and instance billing/limits | Required features and Hobby plan confirmed; usage allowance not measured |

Call `synthetic_echo` with a harmless message to exercise the unrelated tool. Compare HTTP
courses and status with the corresponding MCP structured results. Revoke a working credential
and repeat the same request; repeat with an expired key, a different owner, a different resource
and reduced scopes. Check denials after a successful call to expose accidental principal caching.

On 2026-11-01, [Clerk's API-key documentation](https://clerk.com/docs/guides/development/machine-auth/api-keys)
listed 1,000 monthly creations and 100,000 verifications free, then $0.001 per creation and
$0.00001 per verification, with Hobby limited to the free allowance. The trial confirmed the
required instance features and Hobby plan; remaining usage allowance was not measured.
Recheck allowance before further trials; verification runs on every request.

Local socket tests inject synthetic verifier responses. They establish adapter behavior and
HTTP/MCP parity, not Clerk issuance, consent, renewal, or actual ChatGPT/Codex compatibility.
Run `pnpm --filter @unimatrix/canvas-app test` after building dependencies. The shared auth
tests separately exercise signed synthetic tokens and mocked provider verification.
