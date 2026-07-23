# @unimatrix/api-client

Typed transport boundary for API client code in the monorepo.

## Belongs here

- client configuration
- request helpers and transport abstractions
- typed client utilities that consume contracts from `@unimatrix/shared`

## Does not belong here

- canonical schemas or shared contract definitions
- server-only route logic
- content loading concerns

LOC-35 keeps this package intentionally minimal so LOC-41 can add real contract-aware client behavior without restructuring.

## Auth token provider

`createApiClient` never imports Clerk or any other auth library. Instead,
consumers pass an optional `getAuthToken` in `ApiClientConfig`:

```ts
export type ApiClientAuthTokenProvider = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;
```

It is called (and `await`-ed) on every request. When it resolves to a
non-empty string, the client attaches `Authorization: Bearer <token>`; when
it resolves to `null`, `undefined`, or `""`, no `Authorization` header is
sent. Nothing is cached — the provider is invoked fresh per request, so a
Clerk-backed `getToken()` (added in a later app-side phase) can rotate the
token between calls.

## Requests with a body or query

`request(contract, options?)` now honors `contract.method`, and generalizes
beyond `GET`:

- If `contract.bodySchema` is set, `options.body` is **required**, typed as
  `ApiContractBody<TContract>` (the schema's `z.input` shape). The body is
  `JSON.stringify`-ed and `content-type: application/json` is set.
- If `contract.querySchema` is set, `options.query` is **required**, typed
  as `ApiContractQuery<TContract>`. Each defined value is appended to the
  path as a querystring param via `URLSearchParams` (`undefined` values are
  skipped).
- Contracts with neither (e.g. `healthContract`) keep working with no
  second argument: `request(healthContract)`.

## Per-user data (JSON) convenience methods

Typed wrappers over `request(...)` for the `/me/data` and `/me/files`
(metadata) contracts in `@unimatrix/shared`. These cover JSON document and
file-metadata operations only — uploading/downloading file *bytes* is a
raw `multipart/form-data` POST and a raw `GET` respectively (not JSON
contracts), so they are not wrapped here; see `@unimatrix/user-data` for a
higher-level store built on top of both.

```ts
client.getDocument(query: GetDocumentQuery): Promise<UserDocument>;
client.putDocument(body: PutDocumentBody): Promise<UserDocument>;
client.deleteDocument(body: DeleteDocumentBody): Promise<DeleteResult>;
client.listDocuments(query: ListDocumentsQuery): Promise<ListDocumentsResponse>;
client.listFiles(query: ListFilesQuery): Promise<ListFilesResponse>;
client.deleteFile(body: DeleteFileBody): Promise<DeleteResult>;
```

`getDocument` throws `ApiClientError` with `status === 404` when the
document is absent (the server's `/me/data` GET is a 404, not a nullable
200) — callers that want "undefined when missing" semantics should catch
and check `error.status === 404` themselves (see how
`@unimatrix/user-data`'s account adapter does this).

## Errors

Non-2xx responses throw `ApiClientError` (exported from the package),
which always carries `status: number` and, best-effort, `code`,
`requestId`, and `details` parsed from the API's error envelope
(`{ error: { code, message, statusCode, details? }, requestId }`). Use
`error.status` (or `error.code`) to distinguish `401` (redirect to
sign-in) from `403` (forbidden) in consuming apps. A non-JSON response on
an otherwise-ok status also throws `ApiClientError`.
