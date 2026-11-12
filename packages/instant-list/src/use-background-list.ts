import {
  infiniteQueryOptions,
  hashKey,
  QueryClient,
  QueryCache,
  useInfiniteQuery,
  useQueryClient,
  type QueryKey,
  type InfiniteData,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  runBackgroundTask,
  resolveListTransport,
  getListPolicy,
  readMemoryEnvironment,
  waitForIdle,
  type SystemMemoryInfo,
} from "./policy";
import { withListRetry, type FetchListPage, type ListPage } from "./transports";

let latestSystemMemory: SystemMemoryInfo | undefined;
let memoryProvider: (() => Promise<SystemMemoryInfo>) | undefined;
export function configureListMemoryProvider(provider: () => Promise<SystemMemoryInfo>): void {
  memoryProvider = provider;
}
export interface BackgroundListOptions<T, Cursor> {
  queryKey: QueryKey;
  fetchPage: FetchListPage<T, Cursor>;
  getItemId: (item: T) => string | number;
  transport?: "http" | "tauri";
  pageSize?: number;
  maxBackgroundItems?: number;
  backgroundDelayMs?: number;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  getMemoryInfo?: () => Promise<SystemMemoryInfo>;
}
export function createInstantQueryClient(): QueryClient {
  const queryCache = new QueryCache();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const client = new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: getListPolicy(readMemoryEnvironment()).gcTime,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  queryCache.subscribe((event) => {
    const query = event.query;
    if (query.meta?.instantList !== true) return;
    const timer = timers.get(query.queryHash);
    if (event.type === "removed" || query.getObserversCount() > 0) {
      clearTimeout(timer);
      timers.delete(query.queryHash);
      return;
    }
    const policy = getListPolicy({
      ...readMemoryEnvironment(),
      ...(latestSystemMemory ? { system: latestSystemMemory } : {}),
    });
    if (policy.gcTime > 30_000 || timer !== undefined) return;
    timers.set(
      query.queryHash,
      setTimeout(() => {
        timers.delete(query.queryHash);
        if (query.getObserversCount() === 0) queryCache.remove(query);
      }, policy.gcTime),
    );
  });
  return client;
}
export function backgroundListQueryOptions<T, Cursor>(
  options: BackgroundListOptions<T, Cursor>,
  controls?: { isForeground: () => boolean },
) {
  const transport = resolveListTransport(options.transport);
  return infiniteQueryOptions<
    ListPage<T, Cursor>,
    Error,
    InfiniteData<ListPage<T, Cursor>, Cursor | null>,
    QueryKey,
    Cursor | null
  >({
    queryKey: options.queryKey,
    meta: { instantList: true },
    initialPageParam: null as Cursor | null,
    queryFn: async ({ pageParam, signal }: QueryFunctionContext<QueryKey, Cursor | null>) => {
      const foreground = pageParam === null || controls?.isForeground() === true;
      const fetch = () =>
        withListRetry(options.fetchPage)({
          cursor: pageParam as Cursor | null,
          signal,
          priority: foreground ? "high" : "low",
          limit: Math.max(
            1,
            Math.min(
              options.pageSize ?? (transport === "tauri" ? 250 : 100),
              options.maxBackgroundItems ?? Infinity,
              getListPolicy(
                {
                  ...readMemoryEnvironment(),
                  ...(latestSystemMemory ? { system: latestSystemMemory } : {}),
                },
                transport,
              ).maxBackgroundItems,
            ),
          ),
        });
      const page = foreground
        ? await fetch()
        : await runBackgroundTask(
            fetch,
            signal,
            transport,
            options.backgroundDelayMs ?? (transport === "tauri" ? 32 : 100),
          );
      signal.throwIfAborted();
      if (pageParam !== null) await waitForIdle(signal);
      return page;
    },
    getNextPageParam: (lastPage: ListPage<T, Cursor>, _pages, _lastParam, allParams) => {
      if (
        lastPage.nextCursor !== null &&
        allParams.some((param) => hashKey([lastPage.nextCursor]) === hashKey([param]))
      )
        return null;
      return lastPage.nextCursor;
    },
    staleTime: options.staleTime ?? 5 * 60_000,
    gcTime: options.gcTime ?? getListPolicy(readMemoryEnvironment()).gcTime,
    enabled: options.enabled ?? true,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function deduplicateItems<T>(
  pages: readonly { items: readonly T[] }[],
  getItemId: (item: T) => string | number,
): T[] {
  const items = new Map<string | number, T>();
  for (const page of pages) for (const item of page.items) items.set(getItemId(item), item);
  return [...items.values()];
}
export function useBackgroundList<T, Cursor>(options: BackgroundListOptions<T, Cursor>) {
  const transport = resolveListTransport(options.transport);
  const queryClient = useQueryClient();
  const [environment, setEnvironment] = useState(readMemoryEnvironment);
  const getMemory = options.getMemoryInfo ?? memoryProvider;
  const memoryReader = useRef(getMemory);
  memoryReader.current = getMemory;
  const hasMemoryReader = getMemory !== undefined;
  const [memorySampled, setMemorySampled] = useState(!getMemory);
  const onDemand = useRef(false);
  const remaining = useRef(
    Math.min(
      options.maxBackgroundItems ?? Infinity,
      getListPolicy(readMemoryEnvironment()).maxBackgroundItems,
    ),
  );
  useEffect(() => {
    let active = true;
    const sample = async () => {
      const next = readMemoryEnvironment();
      if (memoryReader.current) {
        try {
          next.system = await memoryReader.current();
          latestSystemMemory = next.system;
        } catch {
          /* Browser telemetry remains available if native sampling fails. */
        }
      }
      if (active) {
        const policy = getListPolicy(next);
        if (policy.gcTime <= 30_000)
          queryClient.removeQueries({
            type: "inactive",
            predicate: (query) => query.meta?.instantList === true,
          });
        setEnvironment(next);
        setMemorySampled(true);
      }
    };
    void sample();
    const timer = setInterval(() => {
      void sample();
    }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [hasMemoryReader, queryClient]);
  const policy = getListPolicy(environment, transport);
  const query = useInfiniteQuery({
    ...backgroundListQueryOptions<T, Cursor>(
      {
        ...options,
        fetchPage: (context) =>
          options.fetchPage({
            ...context,
            priority: onDemand.current ? "high" : context.priority,
            limit: onDemand.current
              ? context.limit
              : Math.max(1, Math.min(context.limit, remaining.current)),
          }),
      },
      { isForeground: () => onDemand.current },
    ),
    gcTime: options.gcTime ?? policy.gcTime,
  });
  const items = useMemo(
    () => deduplicateItems(query.data?.pages ?? [], options.getItemId),
    [query.data, options.getItemId],
  );
  const limit = Math.min(options.maxBackgroundItems ?? Infinity, policy.maxBackgroundItems);
  const retainedSlots = (query.data?.pages ?? []).reduce(
    (count, page) => count + Math.max(1, page.items.length),
    0,
  );
  remaining.current = Math.max(0, limit - retainedSlots);
  const pauseReason = policy.pauseReason ?? (retainedSlots >= limit ? "limit" : null);
  const fetchNextPage = query.fetchNextPage;
  useEffect(() => {
    if (
      !memorySampled ||
      options.enabled === false ||
      !query.hasNextPage ||
      query.isFetching ||
      query.isError ||
      pauseReason
    )
      return;
    const controller = new AbortController();
    void (async () => {
      await waitForIdle(controller.signal);
      controller.signal.throwIfAborted();
      await fetchNextPage({ cancelRefetch: false });
    })().catch(() => {
      /* The query exposes transport errors; cancelled scheduling needs no UI error. */
    });
    return () => {
      controller.abort();
    };
  }, [
    memorySampled,
    options.enabled,
    options.backgroundDelayMs,
    transport,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    pauseReason,
    fetchNextPage,
    query.dataUpdatedAt,
  ]);
  const onEndReached = useCallback(async () => {
    if (options.enabled !== false && query.hasNextPage && !query.isFetching) {
      onDemand.current = true;
      try {
        await fetchNextPage({ cancelRefetch: false });
      } finally {
        onDemand.current = false;
      }
    }
  }, [options.enabled, query.hasNextPage, query.isFetching, fetchNextPage]);
  return { ...query, items, onEndReached, pauseReason, isBackgroundPaused: pauseReason !== null };
}
export function usePrefetchList<T, Cursor>(options: BackgroundListOptions<T, Cursor>) {
  const client = useQueryClient();
  const prefetch = () => {
    if (options.enabled !== false)
      void client.prefetchInfiniteQuery({ ...backgroundListQueryOptions(options), pages: 1 });
  };
  return { onMouseEnter: prefetch, onFocus: prefetch };
}
