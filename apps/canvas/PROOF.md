# Synthetic caller acceptance

## Local verification

On 2026-11-01, `pnpm verify` passed under Node 24.18.0 and pnpm 10.30.3.
The TV tests used the existing isolated ASP.NET 10 runtime through
`UTV_DOTNET_RUNTIME`; the worktree's SQLite native dependency was rebuilt for Node 24.

The Canvas socket/config suite passed all 13 tests. It exercises HTTP/MCP result parity
through both supported MCP protocol paths, credential separation, capability denial,
per-request verification, protected status, Host/Origin checks, sanitized errors and
request-size rejection. Its verifier is injected; it does not prove Clerk or client behavior.

On 2026-11-02, the review follow-up passed the 16-test socket/config suite. HTTP and MCP
shared a peer-IP budget, stopped verification after exhaustion, rejected forwarded-IP bypass,
and returned safe correlated 429 responses before body parsing. Another peer retained its
own allowance and liveness remained available. Unsupported media types retained a safe 415
response without reflecting the parser error. These follow-up checks ran locally; the live
provider trials below used the preceding build.

A standalone production dependency bundle passed a separate dummy-config socket check:
liveness returned 200, protected status returned 401, and discovery returned the configured
resource. The subprocess exited successfully.

## Temporary endpoint

The owner selected `https://canvas-proof.unimatrix-01.dev/mcp` for synthetic external trials.
The existing wildcard DNS record covered the hostname. The trial used a separate Dokploy
Compose service, `canvas-proof`, with an HTTPS domain targeting internal port 3020, a
digest-pinned Node 24.18.0 image and a read-only application mount, without host ports.
The service and route were removed after testing.

The final bundle archive SHA-256 is
`29932584ef00f3a9f39ee423bbc41d2d08ca6f10198adadfac61ec496b6b79c2`.
Its temporary mount at `/tmp/canvas-proof-e036b13a` on `unimatrix-03` and remote staging
archives were removed after testing. This is not a durable deployment artifact.

The dedicated `canvas-proof` Clerk backend key was issued after owner email verification.
Runtime settings were transferred through Firefox and matched a fresh Dokploy readback.
The container started and reported healthy. Shortened key-display values were detected and
replaced before startup.

Certificate issuance initially hit Let's Encrypt's registered-domain limit. After its retry
window, a one-time recreation of only the temporary container obtained a working certificate.
Strict origin TLS stayed enabled. External `/health` and protected-resource discovery returned
200 with the expected resource and Clerk authorization server. Saved deployment commands were
not changed.

## Clerk observations

Firefox dashboard readback confirmed CIMD, PKCE and audience enabled, with client admission
restricted to pre-registered or previously connected clients. DCR remains disabled and JWT
format remains selected. The custom scopes are `canvas:read`, `canvas:status` and
`synthetic:echo`. User API keys are enabled on the Hobby workspace; organization keys are
disabled.

The account API-key form exposes name and expiration, without scopes or resource claims.
No key was created through it. Scoped script keys require provider backend provisioning;
accepting an unscoped key would weaken the verifier.

The owner approved temporary script credentials. Firefox-backed Clerk API calls issued
`canvas-proof-script`, `canvas-proof-read-only` and `canvas-proof-wrong-resource`, each with
a one-hour expiration. The first two use the selected resource; the third deliberately uses
a different HTTPS resource. Clerk's verification endpoint returned 200 for the full script
key, with the expected scopes/resource and `revoked: false`, `expired: false`.

Native Node HTTP calls through the HTTPS endpoint returned:

| Case | Observed result |
| --- | --- |
| Full scoped key, courses and status | 200, shared schemas accepted |
| Anonymous courses and status | 401 |
| Read-only key, courses | 200 |
| Read-only key, status | 403 |
| Wrong-resource key, courses | 401 |
| API key on MCP | 401 with protected-resource challenge |
| 60-second key before expiry | 200 |
| Same key after expiry | 401 |
| Previously working full key after revocation | 401 |

All script test keys were revoked after these checks; Clerk also marked the expiry key expired.
Keys reached the caller only through an echo-disabled control channel feeding a pipe. They
were not placed in command arguments, environment variables or credential files.

The dashboard warns that JWT access tokens remain valid until expiry after grant revocation.
The live Codex check below confirmed continued access with an already-issued JWT. Immediate
OAuth access revocation is therefore an acceptance gap with the selected provider format.

## Codex observations

Codex CLI 0.166.0 requested the observed CIMD client ID
`https://chatgpt.com/oauth/codex/client.json`, the canonical resource, the synthetic scopes and
`offline_access`. Clerk registration granted only those scopes, without email/profile defaults.
Owner consent completed in Firefox, and Codex reported OAuth completion.

Live requests exposed two provider-shape differences: the dedicated OAuth verification response
omits `type`, and its `expiration` equals the signed JWT's seconds value. The verifier normalizes
only the OAuth endpoint's missing type and only an expiry that exactly matches the already
verified JWT expiry. Explicit conflicting types, mismatched seconds, revoked/expired records
and API-key responses retain their rejection checks. All 120 auth tests and full repository
verification passed after these changes.

Temporary diagnostics emitted only fixed stages, field types and equality booleans. They were
removed. The trial auth module matched the tested build SHA-256
`d8074d6842eeb17a0ca99ba0895d375fa7ef9c3f1606bf3e98fc05bf1ef05de1`.

The actual Codex MCP client reported `connected` with OAuth and successfully invoked
`canvas_list_courses`, `canvas_status` and `synthetic_echo` without a model turn. Course and
status structured results matched the live HTTP responses.

Clerk's log independently records `oauth_token.created` at `2026-11-02T07:11:50.317Z`,
with `grant_type: refresh_token` and the exact registered Codex client ID. Initial owner
authorization was recorded at `06:49:45 UTC`; no second browser consent occurred between
those events. This verifies actual native renewal. The renewed
credential subsequently completed the successful tool calls after the compatibility fixes.

A separate native Codex connection requested only `canvas:read` and `offline_access`.
Its catalog exposed only `canvas_list_courses`, which returned the synthetic courses.
Direct attempts to call status or echo returned the native client's `-32602` tool-not-found
error; these establish client visibility denial, without proving a server-side 403.
The full-scope connection still returned status successfully.

At approximately `2026-11-02T07:40:25Z`, Clerk confirmed revocation of only that read-only
connection's opaque refresh grant, issued at `07:36:40.451Z`. Dashboard readback removed its
grant pair and retained the full-scope connection. An immediate call through the existing
read-only Codex connection still returned synthetic courses successfully. The current online
verification does not make this already-issued JWT immediately unusable. Refresh failure
after revocation has not been exercised. The installed native client offers no force-refresh
action; reconnecting reuses an unexpired token. Its issued JWT expires on 2026-11-03, so that
case cannot be established by an immediate reconnect without altering credential state.

On `2026-11-02` around `20:16 UTC`, the owner-approved wrong-owner check changed
only `CANVAS_OWNER_USER_ID` to `user_canvas_proof_wrong_owner`. Firefox editor readback
confirmed that single replacement before saving. Public liveness returned 200 and the
container reported healthy before the native Codex reconnect. That previously successful
credential failed initialization; temporary fixed-status diagnostics corroborated an OAuth
denial with status 403 at `20:16:57.555Z`. This excludes startup routing failures from the
denial evidence. Other services and credential values were unchanged.

The original owner was restored with another single-value edit. Fresh Firefox readback
confirmed restoration and public health returned 200. The same native keyring credential
then connected and returned the expected status successfully around `20:19 UTC`.
Temporary diagnostics were removed; the restored application module matched tested SHA-256
`f42dcbb128b22124df2742fceef9f308e5c455bc98c94c45af13fb101fdc99a8`.

## ChatGPT observations

On `2026-11-02` around `20:05 UTC`, the custom MCP connector completed owner consent in
Firefox. Discovery selected `https://chatgpt.com/oauth/client.json` and the canonical resource.
The optional OIDC setting was disabled; default scopes were `canvas:read`, `canvas:status`
and `synthetic:echo`, with only `offline_access` as a base scope. The consent page displayed
only synthetic course, status and echo permissions. ChatGPT confirmed the connection.

The custom connector was named `Canvas Synthetic OAuth Proof`. It was separate from the
portable package, whose web entry point opened a desktop-app bridge.

An explicit web-chat request returned the expected course, status and echo results, including
`chatgpt-synthetic-proof` as the echo message. Because the UI exposed a work summary rather
than raw per-call records, temporary server diagnostics logged only fixed tool names. With
other callers stopped, the repeated ChatGPT request produced `canvas_status`, `synthetic_echo`
and `canvas_list_courses` execution events at `20:12:46.777Z`, `20:12:46.961Z` and
`20:12:47.167Z`. The returned course/status JSON matched the HTTP and Codex fixtures.

Clerk metadata recorded ChatGPT authorization-code issuance at `20:05:39.640Z`. Renewal was
not observed or forced. At `20:14:12 UTC`, Clerk confirmed revocation of only this connector's
opaque refresh grant and removed its grant pair. A fresh ChatGPT course-list call still
returned the expected fixtures, corroborated by a server execution event at `20:14:43.932Z`.
Immediate revocation of the issued access JWT therefore failed for this client too.

## Cleanup

Clerk confirmed revocation of the remaining full-scope Codex refresh grant at `20:20:25 UTC`
and displayed `No active OAuth grants`. All script test keys were revoked. After owner email
verification, the dedicated `canvas-proof` backend key was deleted; visible readback retained
only the existing default key. Both temporary Codex native keyring entries were removed.

The owner explicitly approved deleting the temporary service after testing. Dokploy removed
it and its HTTPS route; host readback found no proof container or dedicated Compose directory.
The remote runtime mount, staged archives and diagnostic copies were deleted. External health
returned 404 afterward. Existing services, volumes and wildcard DNS were retained.

The owner also approved removing the remaining temporary setup. Both private proof plugin
records and their connections were deleted, and both synthetic-only pre-registered OAuth
clients were removed. Clerk's applications view then displayed `No applications yet`.
Local proof bundles, diagnostic copies and caller harnesses were removed; check logs were
retained outside the repository.

## Outstanding acceptance

- Prove ChatGPT renewal and exercise refresh failure after grant revocation. Immediate
  revocation of issued JWTs failed independently in both clients.
- Complete any remaining OAuth resource/capability denial cases; local socket tests and live HTTP
  key denials do not establish those client-specific outcomes.
