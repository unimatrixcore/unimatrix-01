# Service HTTP primitives

`createErrorEnvelope` builds the correlation-bearing error envelope from public-safe inputs.
Callers own error classification, status codes, messages and details; never pass upstream error
objects or validation diagnostics containing private input directly to it.

`setupRequestObservability` emits `x-request-id` and completion metadata: duration, method,
request ID, registered route template, status and a closed outcome. Unmatched URLs have a null
route. Supply `onResponse` only when the app deliberately owns a different logging policy.

Use `buildSafeLoggerOptions` with those default hooks for services handling private upstream data.
It omits request/response serialization, reduces errors to a constant marker and replaces free-text
log messages, including framework error messages, with `service event`. Structured application
logs and logger bindings must still contain only safe metadata; arbitrary fields are not scrubbed.
Keep Fastify's generated request IDs rather than accepting correlation IDs from caller headers.

Route registration, validation compilers, error handlers, CORS, proxy trust, rate limits and process
startup belong to the consuming app. The API supplies its own completion callback and logger
configuration to preserve its diagnostic policy.
