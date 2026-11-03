# Canvas student coursework

The protected status and course operations read the Admin-managed integration credential
and verify the configured Canvas account. HTTP and MCP invoke the same in-process
workflows. Course access requires current, verified student enrollment; a course ID alone
does not grant access.

Use the static contracts in `@unimatrix/shared` with the generic API client's
`request(canvasCoursesContract, { query: {} })` or
`request(canvasCourseContract, { query: { courseId } })`. HTTP uses
`GET /api/v1/courses` and `GET /api/v1/course`; identifiers stay in query parameters.
MCP exposes `canvas_list_courses` and `canvas_get_course` with the same arguments and
structured results. `canvas_status` and `canvas_connection_status` both verify account
access, as do `/api/v1/status` and `/api/v1/connection`.

Assignment, submission and grade contracts live in `packages/shared/src/contracts/canvas-assignments.ts`.
Their HTTP routes and MCP tools accept a verified `courseId`; detail and submission reads also
require `assignmentId`. Assignment dates come from Canvas with personal overrides applied.
The service preserves nullable availability dates, restrictions, rubric associations and
requested-include availability. An omitted include does not establish that no association exists.

Instructions are converted to bounded, untrusted Markdown. Pass the returned document continuation's
`documentId` and `offset` as `instructionDocumentId` and `instructionOffset` to the assignment
detail operation. Changed instructions invalidate the document continuation. Assignment lists
use the same opaque cursor pattern as courses.

Submissions preserve Canvas's attempt, workflow state, timestamps and missing/late/excused flags.
Offline and external-tool work can lack an online submission; the service does not infer missing
work. Scores and grades are returned only with a posting timestamp and no explicit hidden flag.
Explicit ungraded nulls remain null; absent posting information is unknown. Course grades preserve
Canvas's visible current/final scores and grades, including zero, null and omitted fields, and
never include unposted totals. `gradingPeriodId` selects a specific period; omission requests the
whole course. Incomplete grade enrollment pagination fails instead of presenting a complete result.

Course queries default to active enrollments. Set `concluded: true` to include completed
enrollments and courses. Lists accept `limit` (1–100), `cursor`, and `fresh`; pass returned
`continuation` as `cursor` with the same filters and limit. Keep earlier chunks. A cursor
is single-use, expires after five minutes, and is bound to the caller and credential
generation. Do not combine `fresh` and `cursor`. Results are limited to 16 KiB across both
interfaces; lists may continue before reaching `limit`. A single course that exceeds the
result budget fails with `CANVAS_BUDGET_EXHAUSTED` instead of returning truncated facts.

Results retain source coverage, timestamps, cache age, warnings and source links. An empty
list establishes empty enrollments only when coverage is complete. Membership is reread
even when course metadata comes from cache or continuation. An inaccessible or incomplete
membership read fails closed. Course metadata preserves the upstream timezone and reports
the effective timezone and its source; `CANVAS_TIME_ZONE` supplies the fallback and defaults
to `America/Phoenix`.

Build dependencies with `pnpm exec turbo run --concurrency=1 build --filter=@unimatrix/canvas-app...`,
then run `pnpm --filter @unimatrix/canvas-app start` with environment supplied by the operator.
The process does not load `.env` files. Keep credentials out of command arguments and shell history.

Required boot settings:

| Setting | Value |
| --- | --- |
| `CANVAS_USER_ID` | Exact positive decimal Canvas user ID, independent of the Clerk subject; preserve it as a string |
| `SECRETS_BASE_URL` | HTTPS origin of the private secrets service |
| `SECRETS_CANVAS_READ_TOKEN` | Dedicated store token with `read` capability scoped to `integrations/canvas/` |
| `SECRETS_TLS_CERT_BASE64` | Base64 PEM certificate pinned for the secrets service, with matching hostname |
| `CANVAS_OWNER_USER_ID` | Stable Clerk `user_…` subject |
| `CANVAS_RESOURCE_URL` | Canonical external HTTPS URL ending in `/mcp` |
| `CANVAS_ALLOWED_HOSTS` | Comma-separated hostnames, including the resource hostname |
| `CANVAS_ALLOWED_ORIGINS` | Comma-separated browser origin hostnames, without scheme or port |
| `CLERK_ISSUER` | Exact signed OAuth issuer, including any trailing slash |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY` | Matching instance credentials and JWT verification key |

`HOST` defaults to loopback and `PORT` to 3020. TLS termination must preserve an allowlisted
raw Host. Forwarded headers are not trusted. Clients without Origin are supported.

HTTP and MCP share an in-memory limit of 60 requests per peer IP per minute, enforced before
authentication and body parsing. Behind a proxy, its traffic shares that budget because
forwarded IPs are not trusted. Liveness is exempt. Exhaustion returns a safe `RATE_LIMITED`
429 response with `Retry-After` and request correlation.

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

## Connection access and replacement

Provision and rotate `integrations/canvas/access-token` through Admin Secrets, in the
Integrations tier. Preserve the existing entry's name. Issue the bootstrap store token
using the secrets service's `service-token issue` command with a distinct operator name,
`--scope integrations/canvas/ --capability read`; deliver its output through deployment
secret configuration. Never use an Admin management token or the API's integration-read
token here. Token scope is enforced by the store; Canvas requests only the declared name.
The bootstrap token, Clerk caller credentials and Canvas access token have separate
revocation paths.

Every connection operation reads the current value and calls the fixed HTTPS
`https://learn.maricopa.edu/api/v1/users/self` endpoint, requesting string IDs and rejecting
redirects. The returned ID must equal `CANVAS_USER_ID`. No Canvas credential or account
verification is cached between operations. The domain connection retains only a keyed
in-memory fingerprint to invalidate future content caches when the value changes; neither
the fingerprint nor credential is returned. Cache callbacks run after current store access
and account verification, including on content-cache hits. Operations share serial admission
and a ten-second deadline, including queue time.

`/health` reports process liveness independently. Caller authentication failures remain
401/403. A course outside verified student memberships returns `CANVAS_COURSE_FORBIDDEN`
(403). Connection errors use safe codes: `CREDENTIAL_DENIED`, `CREDENTIAL_MISSING` and
`CREDENTIAL_UNAVAILABLE` (503), `CANVAS_ACCOUNT_MISMATCH` (409), and upstream rejection,
unavailability or malformed-response errors (502). MCP tool errors carry the same codes.
A store 404 can mean either absence or an out-of-scope name. Neither response bodies nor
nested causes from the store or Canvas are exposed. Recovery requires repairing the scoped
store token, rotating the Canvas entry, or correcting the configured account binding;
there is no second token-entry UI.

Local synthetic responses exercise replacement, mismatched accounts, expiry/revocation,
store denial and serialization. Actual Canvas permissions remain unverified until authorized
representative live reads and comparison with the owner's Canvas UI. Deployment and school
API requests require their separate release task.

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
