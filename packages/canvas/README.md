# Canvas transport

Create one `createCanvasConnection` per configured account and pass that same connection to
`createCanvasTransport` for both HTTP and MCP consumers. Each operation reloads the injected
credential and verifies `users/self`, including cache hits and continuation. The origin is
fixed to `https://learn.maricopa.edu`. Endpoint selectors and wire schemas live in
`src/endpoints.ts`; callers supply selectors, never URLs or arbitrary query parameters.

`read(selector, { caller })` and `aggregate(selectors, { caller })` return source envelopes.
The adapters must supply `caller` from verified authentication, never request input.
`createCanvasCourseWorkflows(connection, { userId, timeZone })` verifies fresh own student
enrollments before listing or reading course metadata. Course IDs alone do not establish
membership. The workflow uses one verified session and request budget across membership
and course reads, and rejects incomplete enrollment coverage before accessing courses.

Course lists request active student enrollments by default. `concluded: true` combines separate
active and completed enrollment reads, deduplicated by course ID. Both selections share page
and request budgets and continuation progress; an incomplete selection prevents complete coverage.

Every source includes retrieval time, cache age, a source URL, all selection URLs in
`sourceLinks`, data, warnings and coverage:
`complete`, `partial`, `unavailable`, or `not_requested`. A source that has never been attempted
has a null retrieval time. Continuation preserves earlier source retrieval times. An empty data array only establishes
an empty upstream result when coverage is complete. Continuation returns the next chunk,
with prior items deduplicated; consumers retain earlier chunks. Prior source failures remain
visible across continuation. Authentication and cancellation failures reject the operation
using sanitized `CanvasConnectionError` codes.

The account admits one operation at a time, including body consumption, with at most 64
admitted operations. The default ten-second deadline includes queueing, credential access,
identity verification, throttling, retries and all source pages. Caller cancellation reaches
all those stages. `maxRequests` defaults to 20 and is capped at 100; identity checks and
retries consume it. `maxPages` defaults to five and is capped at 20 across all sources.
Canvas cost/remaining headers delay subsequent requests when depleted; `Retry-After` and
bounded exponential backoff with jitter apply to 429/503 responses, with at most two retries.
Pagination follows opaque page tokens while preserving original endpoint and filters,
rejecting redirects, impersonation parameters, cross-origin links and loops.

An operation accepts at most 20 sources, 1,000 returned items and 2 MiB of parsed page data;
each response is limited to 1 MiB (64 KiB for account identity). Oversized pages fail explicitly.
Continuation retains at most 5,000 item identities and 100 visited URLs per source, expires
five minutes after the first chunk, and is bound to the verified caller, operation, selectors
and credential generation. The store holds at most 64 opaque, single-use cursors. Eviction,
restart, expiry, replacement and explicit invalidation reject the affected cursors.

The content cache holds at most 64 complete results for 60 seconds, isolated by caller,
operation, selectors and credential generation. `fresh: true` removes the cached entry before
refreshing; failed refreshes never return old content. Cache results are copied on return.
`invalidate()` clears content and continuations. Credential changes invalidate both after
current account verification, and denied store/account access cannot reach either cache.

The package tests use synthetic responses. School endpoint permissions and real-account
behavior require the separately authorized live acceptance task in `canvas.todo.md`.
