# MCP hosting

Use `defineTool` from `@unimatrix/mcp` with Zod object input/output schemas,
required capabilities, MCP annotations and an in-process executor. Executors receive
the verified `ServicePrincipal` and an `AbortSignal`; return `{ data, text }` for
structured content and a readable text equivalent. Pass the signal to domain work.
The host validates results and rejects responses exceeding `maxResultBytes` (64 KiB
by default) with an explicit tool error; it does not truncate data. The bound covers
the serialized tool result, before SDK protocol envelopes. Domain workflows own
pagination and continuation.

Unexpected exceptions produce a generic tool error. Throw `ToolExecutionError`
only with a message safe for callers. Its serialized response must fit the same
limit. Tool discovery and execution expose only registrations whose capabilities
the principal holds. An empty authorized catalog leaves the SDK's tools capability
unregistered.

`registerMcpRoutes(app, options)` from `@unimatrix/mcp/fastify` mounts `/mcp` and
protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource`. Supply:

- `name`, `version`, `tools` and optional `maxResultBytes`.
- A canonical HTTPS `resource` ending in `/mcp` and HTTPS `authorizationServers`.
- Nonempty `requiredCapabilities` for connecting to the endpoint.
- `verifyOAuthCaller`, normally from `createServiceCallerVerifier` in
  `@unimatrix/auth/server`, configured for the same resource and owner.
- Nonempty `allowedHosts` and `allowedOrigins` using the official adapter's
  hostname format. Origin checks are port-agnostic; clients without Origin pass.

The verifier runs on every MCP request. API keys and resource mismatches are
rejected. Missing/invalid credentials receive an OAuth challenge; insufficient
endpoint capabilities receive a 403 scope challenge. Metadata is anonymous and
uses configured URLs, never request or forwarded headers. Metadata advertises the
endpoint and tool scope union. Configure the verifier's capability policy for those scopes.

Fastify owns JSON parsing and request limits (`maxRequestBytes` defaults to 1 MiB).
Its parsed body and the verified principal cross the official Node adapter. The SDK
serves modern per-request MCP and legacy stateless negotiation from fresh server
instances, without application sessions. Disconnect cancellation is cooperative:
executors must honor the supplied signal.

Applications own listening, proxy trust, CORS and logging policy. A reverse proxy
must preserve an allowlisted raw Host; forwarded Host does not override validation.
Use the canonical external HTTPS URL as the resource behind TLS termination. For
local development only, `allowInsecureLocalhost` admits an HTTP loopback resource;
authorization-server URLs still require HTTPS. Anonymous liveness is app-owned.

The socket tests exercise synthetic callers and both protocol generations. They do
not establish identity-provider configuration or ChatGPT/Codex interoperability;
those require the synthetic service and external caller proof in the Canvas plan.
