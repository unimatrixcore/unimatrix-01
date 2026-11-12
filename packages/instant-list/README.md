# Background lists

Import from `@unimatrix/instant-list`. Wrap the application in `InstantListProvider`,
or use `createInstantQueryClient()` with its existing `QueryClientProvider`.
The query client must outlive route changes. Keep live operational queries' own
polling and freshness settings.

`useBackgroundList<T, Cursor>(options)` consumes a required query key, ID selector,
and `fetchPage({ cursor, signal, priority, limit })`. A page returns
`{ items: readonly T[], nextCursor: Cursor | null }`; `null` starts and terminates
the cursor chain. Include every filter, sort, and authorization scope in the key.
Use a separate key from ordinary `useQuery` data: infinite-query cache data has a
different shape. Invalidate the list's key prefix after writes.

The transport must honor `limit` and return a progressing cursor. Backend paging
must happen before serialization; slicing an already-downloaded array cannot
improve the initial request or enforce a transfer-memory limit. HTTP APIs can use
`createHttpPageFetcher({ url, parse })`; existing contract clients can supply
`fetchPage` directly. Response validation belongs in `parse` or the contract
client. `createInvokePageFetcher({ invoke, command, args, parse })` sends cursor
and bounded chunk size to an injected native command. Native WebViews default
to IPC batching; set `transport: "http"` for HTTP-backed lists inside Tauri so
network-saving policy still applies. Its cancellation discards
late results; it cannot stop an already-running Rust command.

`InstantVirtualList<T>` takes `items`, `getItemId`, `renderItem`, and `rowHeight`.
Connect `onEndReached`, `hasNextPage`, and `isFetching` from the hook. Give the
scroll viewport a bounded `height`. Use deterministic heights for fixed geometry,
or `measureRows` for wrapping content. Measured content may resize when fonts,
width, or row content changes; virtualization cannot guarantee zero browser
layout work. Row IDs must be unique and stable. Pass table headers and row/cell
roles when rendering tabular content.

`usePrefetchList(options)` supplies `onMouseEnter` and `onFocus` handlers for the
same cache key and transport as the destination. It fetches the initial page;
background draining starts when the list mounts.

Memory telemetry is advisory. Item limits bound background record counts, not
bytes: one unusually large record or response can still consume substantial
memory. Unsupported browser telemetry uses a conservative device tier.
`configureListMemoryProvider()` supplies native `{ totalBytes, availableBytes }`
telemetry; an individual hook can override it through `getMemoryInfo`.
The desktop generator registers the Linux runtime's memory reader through a
validated Tauri command. There is no application `src-tauri` tree in this checkout;
the generator assertions and Rust runtime tests do not establish a compiled or
physically exercised generated Tauri application.

Do not paginate related operational snapshots independently. Preserve their
existing atomic query, metadata, polling, and error behavior, then pass the
bounded snapshot's rows to `InstantVirtualList`.

Run `pnpm verify` for workspace checks, builds, and existing browser suites.
The public web and status browser suites use HTTP fixtures. Admin interaction
verification uses the real list components with fixture transports and an auth
stub; it does not verify a signed-in backend session. Keep that separate from
backend contract tests and production authentication acceptance.
