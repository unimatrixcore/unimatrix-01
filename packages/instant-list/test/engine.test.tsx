import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  createHttpPageFetcher,
  createInvokePageFetcher,
  retryAfterMilliseconds,
} from "../src/transports";
import { abortableDelay, getListPolicy, waitForIdle } from "../src/policy";
import {
  createInstantQueryClient,
  deduplicateItems,
  useBackgroundList,
  usePrefetchList,
} from "../src/use-background-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={createInstantQueryClient()}>{children}</QueryClientProvider>
);
describe("background policy", () => {
  it("tiers RAM and pauses under heap, OS, or network pressure", () => {
    expect(getListPolicy({ deviceMemory: 2 })).toMatchObject({
      maxBackgroundItems: 500,
      gcTime: 30000,
    });
    expect(getListPolicy({ deviceMemory: 8 })).toMatchObject({ maxBackgroundItems: 10000 });
    expect(getListPolicy({ heapUsed: 76, heapLimit: 100 }).pauseReason).toBe("memory");
    expect(
      getListPolicy({ system: { totalBytes: 8 * 1024 ** 3, availableBytes: 100 } }).pauseReason,
    ).toBe("memory");
    expect(getListPolicy({ saveData: true }).pauseReason).toBe("network");
    expect(getListPolicy({ effectiveType: "2g" }, "tauri").pauseReason).toBeNull();
  });
  it("cancels scheduled idle work and pacing", async () => {
    const controller = new AbortController();
    const idle = waitForIdle(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(idle).rejects.toThrow("cancelled");
    await expect(abortableDelay(20, controller.signal)).rejects.toThrow("cancelled");
  });
  it("deduplicates updates without moving established ids", () => {
    expect(
      deduplicateItems(
        [
          {
            items: [
              { id: 1, n: "old" },
              { id: 2, n: "two" },
            ],
          },
          { items: [{ id: 1, n: "new" }] },
        ],
        (item) => item.id,
      ),
    ).toEqual([
      { id: 1, n: "new" },
      { id: 2, n: "two" },
    ]);
  });
});
describe("transports", () => {
  it("honors seconds and date Retry-After", () => {
    expect(retryAfterMilliseconds("2")).toBe(2000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
    expect(retryAfterMilliseconds("bad")).toBeNull();
  });
  it("retries rate limits and preserves abort signal and priority", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(Response.json({ items: [1], nextCursor: null }));
    const parse = (value: unknown) => value as { items: number[]; nextCursor: null };
    const fetchPage = createHttpPageFetcher({ url: () => "https://example.test", parse, fetch });
    const signal = new AbortController().signal;
    await expect(fetchPage({ cursor: null, signal, priority: "high", limit: 10 })).resolves.toEqual(
      { items: [1], nextCursor: null },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal, priority: "high" });
  });
  it("bounds retry attempts and sanitizes IPC failure", async () => {
    const fetchPage = createHttpPageFetcher({
      url: () => "https://example.test",
      parse: () => ({ items: [], nextCursor: null }),
      maxRetries: 0,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(
      fetchPage({
        cursor: null,
        signal: new AbortController().signal,
        priority: "low",
        limit: 100,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const invoke = vi.fn().mockRejectedValue({ code: "BUSY", secret: "private" });
    const native = createInvokePageFetcher({
      command: "records",
      invoke,
      parse: () => ({ items: [], nextCursor: null }),
    });
    await expect(
      native({ cursor: null, signal: new AbortController().signal, priority: "low", limit: 1000 }),
    ).rejects.toMatchObject({ message: "Desktop list command failed", code: "BUSY" });
    expect(invoke).toHaveBeenCalledWith("records", { cursor: null, limit: 500 });
  });
});
describe("query lifecycle", () => {
  it("paints first page, drains without scrolling and deduplicates", async () => {
    const fetchPage = vi.fn(({ cursor }: { cursor: number | null }) =>
      Promise.resolve({
        items: [{ id: cursor ?? 0 }],
        nextCursor: cursor === 2 ? null : (cursor ?? 0) + 1,
      }),
    );
    const { result } = renderHook(
      () =>
        useBackgroundList({
          queryKey: ["drain"],
          fetchPage,
          getItemId: (item: { id: number }) => item.id,
          backgroundDelayMs: 0,
        }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });
    expect(fetchPage.mock.calls.map((call) => call[0].cursor)).toEqual([null, 1, 2]);
  });
  it("stops at cap then continues on demand, retaining rows after an error", async () => {
    const fetchPage = vi.fn(async ({ cursor }: { cursor: number | null }) => {
      await Promise.resolve();
      if (cursor === 2) throw new Error("offline");
      return { items: [{ id: cursor ?? 0 }], nextCursor: (cursor ?? 0) + 1 };
    });
    const { result } = renderHook(
      () =>
        useBackgroundList({
          queryKey: ["cap"],
          fetchPage,
          getItemId: (item: { id: number }) => item.id,
          maxBackgroundItems: 1,
          backgroundDelayMs: 0,
        }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.pauseReason).toBe("limit");
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await act(() => result.current.onEndReached());
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    await act(() => result.current.onEndReached());
    await waitFor(() => {
      expect(result.current.error?.message).toBe("offline");
    });
    expect(result.current.items).toHaveLength(2);
  });
  it("reuses intent-prefetched first page and cancels an obsolete key", async () => {
    const client = createInstantQueryClient();
    const fetchPage = vi.fn(() => Promise.resolve({ items: [{ id: 1 }], nextCursor: null }));
    const options = {
      queryKey: ["intent"],
      fetchPage,
      getItemId: (item: { id: number }) => item.id,
    };
    const stableWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const intent = renderHook(() => usePrefetchList(options), { wrapper: stableWrapper });
    act(() => {
      intent.result.current.onFocus();
    });
    await waitFor(() => {
      expect(client.getQueryData(["intent"])).toBeDefined();
    });
    const list = renderHook(() => useBackgroundList(options), { wrapper: stableWrapper });
    expect(list.result.current.items).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    let signal: AbortSignal | undefined;
    const pending = renderHook(
      () =>
        useBackgroundList({
          queryKey: ["abort"],
          getItemId: (item: number) => item,
          fetchPage: (context) => {
            signal = context.signal;
            return new Promise(() => {});
          },
        }),
      { wrapper: stableWrapper },
    );
    pending.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("native safety and retries", () => {
  it("waits for native memory sampling, then pauses at OS pressure", async () => {
    let release!: (value: { totalBytes: number; availableBytes: number }) => void;
    const memory = new Promise<{ totalBytes: number; availableBytes: number }>((resolve) => {
      release = resolve;
    });
    const fetchPage = vi.fn(() => Promise.resolve({ items: [1], nextCursor: 1 }));
    const { result } = renderHook(
      () =>
        useBackgroundList({
          queryKey: ["memory"],
          fetchPage,
          getItemId: (item: number) => item,
          transport: "tauri",
          getMemoryInfo: () => memory,
          backgroundDelayMs: 0,
        }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.items).toEqual([1]);
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ totalBytes: 8 * 1024 ** 3, availableBytes: 100 });
      await memory;
    });
    await waitFor(() => {
      expect(result.current.pauseReason).toBe("memory");
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it("cancels pending IPC results without accepting stale data", async () => {
    let release!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const native = createInvokePageFetcher({
      command: "records",
      invoke,
      parse: () => ({ items: [1], nextCursor: null }),
    });
    const controller = new AbortController();
    const pending = native({
      cursor: null,
      signal: controller.signal,
      priority: "high",
      limit: 200,
    });
    controller.abort(new Error("obsolete"));
    release({});
    await expect(pending).rejects.toThrow("obsolete");
  });
});

describe("generic rate-limit handling", () => {
  it("retries custom HTTP client errors and keeps long limits explicit", async () => {
    const { withListRetry } = await import("../src/transports");
    const context = {
      cursor: null,
      signal: new AbortController().signal,
      priority: "low" as const,
      limit: 10,
    };
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, retryAfterMs: 0 })
      .mockResolvedValue({ items: [1], nextCursor: null });
    await expect(withListRetry(fetchPage)(context)).resolves.toEqual({
      items: [1],
      nextCursor: null,
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await expect(
      withListRetry(vi.fn().mockRejectedValue({ status: 503, retryAfterMs: 999999 }))(context),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      withListRetry(vi.fn().mockRejectedValue({ status: 400 }))(context),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("shared background lane", () => {
  it("serializes simultaneous list continuations and releases after failures", async () => {
    const { runBackgroundTask } = await import("../src/policy");
    const signal = new AbortController().signal;
    let active = 0,
      maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return 1;
    };
    await Promise.all([
      runBackgroundTask(task, signal, "http", 0),
      runBackgroundTask(task, signal, "http", 0),
    ]);
    expect(maxActive).toBe(1);
    await expect(
      runBackgroundTask(
        async () => {
          await Promise.resolve();
          throw new Error("offline");
        },
        signal,
        "http",
        0,
      ),
    ).rejects.toThrow("offline");
    await expect(runBackgroundTask(task, signal, "http", 0)).resolves.toBe(1);
  });
  it("skips queued cancelled work", async () => {
    const { runBackgroundTask } = await import("../src/policy");
    const controller = new AbortController();
    const task = vi.fn(() => Promise.resolve(1));
    const pending = runBackgroundTask(task, controller.signal, "tauri", 10);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(task).not.toHaveBeenCalled();
  });
});

it("never requests past the remaining background item budget", async () => {
  const limits: number[] = [];
  const fetchPage = ({ cursor, limit }: { cursor: number | null; limit: number }) => {
    limits.push(limit);
    const start = cursor ?? 0;
    return Promise.resolve({
      items: Array.from({ length: limit }, (_, index) => start + index),
      nextCursor: start + limit,
    });
  };
  const { result } = renderHook(
    () =>
      useBackgroundList({
        queryKey: ["budget"],
        fetchPage,
        getItemId: (item: number) => item,
        pageSize: 2,
        maxBackgroundItems: 3,
        backgroundDelayMs: 0,
      }),
    { wrapper },
  );
  await waitFor(() => {
    expect(result.current.pauseReason).toBe("limit");
  });
  expect(result.current.items).toEqual([0, 1, 2]);
  expect(limits).toEqual([2, 1]);
});

it("evicts low-memory inactive list caches even when their original gcTime was longer", async () => {
  const { QueryObserver } = await import("@tanstack/react-query");
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { deviceMemory: 2 });
  const client = createInstantQueryClient();
  try {
    const options = {
      queryKey: ["low-ram-gc"],
      queryFn: () => Promise.resolve(1),
      gcTime: Infinity,
      meta: { instantList: true },
    };
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getQueryData(options.queryKey)).toBe(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  } finally {
    client.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("bounds retained duplicate records and empty cursor pages", async () => {
  const client = createInstantQueryClient();
  const stableWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const fetchPage = vi.fn(({ cursor }: { cursor: number | null }) =>
    Promise.resolve({ items: [1], nextCursor: (cursor ?? 0) + 1 }),
  );
  const { result } = renderHook(
    () =>
      useBackgroundList({
        queryKey: ["duplicates"],
        fetchPage,
        getItemId: (item: number) => item,
        maxBackgroundItems: 3,
        backgroundDelayMs: 0,
      }),
    { wrapper: stableWrapper },
  );
  await waitFor(() => {
    expect(result.current.pauseReason).toBe("limit");
  });
  expect(result.current.items).toEqual([1]);
  expect(result.current.data?.pages).toHaveLength(3);
  expect(fetchPage).toHaveBeenCalledTimes(3);
  const empty = renderHook(
    () =>
      useBackgroundList({
        queryKey: ["empty-pages"],
        fetchPage: ({ cursor }: { cursor: number | null }) =>
          Promise.resolve({ items: [], nextCursor: (cursor ?? 0) + 1 }),
        getItemId: (item: number) => item,
        maxBackgroundItems: 2,
        backgroundDelayMs: 0,
      }),
    { wrapper: stableWrapper },
  );
  await waitFor(() => {
    expect(empty.result.current.pauseReason).toBe("limit");
  });
  expect(empty.result.current.data?.pages).toHaveLength(2);
});

it("stops repeated structurally equal object cursors", async () => {
  const fetchPage = vi.fn(() => Promise.resolve({ items: [1], nextCursor: { offset: 1 } }));
  const { result } = renderHook(
    () =>
      useBackgroundList({
        queryKey: ["cursor-cycle"],
        fetchPage,
        getItemId: (item: number) => item,
        backgroundDelayMs: 0,
      }),
    { wrapper },
  );
  await waitFor(() => {
    expect(result.current.data?.pages).toHaveLength(2);
  });
  expect(result.current.hasNextPage).toBe(false);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

it("applies the item budget before intent-prefetch caches its first page", async () => {
  const client = createInstantQueryClient();
  const stableWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const fetchPage = vi.fn(({ limit }: { limit: number }) =>
    Promise.resolve({ items: Array.from({ length: limit }, (_, id) => id), nextCursor: null }),
  );
  const { result } = renderHook(
    () =>
      usePrefetchList({
        queryKey: ["bounded-intent"],
        fetchPage,
        getItemId: (item: number) => item,
        maxBackgroundItems: 3,
        pageSize: 100,
      }),
    { wrapper: stableWrapper },
  );
  act(() => {
    result.current.onMouseEnter();
  });
  await waitFor(() => {
    expect(client.getQueryData(["bounded-intent"])).toBeDefined();
  });
  expect(fetchPage.mock.calls[0]?.[0].limit).toBe(3);
  client.clear();
});

it("detects Tauri while retaining an explicit HTTP override inside a WebView", async () => {
  const { resolveListTransport, getListPolicy } = await import("../src/policy");
  expect(resolveListTransport()).toBe("http");
  const nativeWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
  nativeWindow.__TAURI_INTERNALS__ = {};
  try {
    expect(resolveListTransport()).toBe("tauri");
    expect(resolveListTransport("http")).toBe("http");
    expect(getListPolicy({ saveData: true }).pauseReason).toBeNull();
    expect(getListPolicy({ saveData: true }, "http").pauseReason).toBe("network");
    const { backgroundListQueryOptions } = await import("../src/use-background-list");
    const client = createInstantQueryClient();
    const nativeFetch = vi.fn(({ limit }: { limit: number }) =>
      Promise.resolve({ items: [limit], nextCursor: null }),
    );
    await client.fetchInfiniteQuery(
      backgroundListQueryOptions({
        queryKey: ["detected-native"],
        fetchPage: nativeFetch,
        getItemId: (item: number) => item,
      }),
    );
    expect(nativeFetch.mock.calls[0]?.[0].limit).toBe(250);
    const httpFetch = vi.fn(({ limit }: { limit: number }) =>
      Promise.resolve({ items: [limit], nextCursor: null }),
    );
    await client.fetchInfiniteQuery(
      backgroundListQueryOptions({
        queryKey: ["explicit-http"],
        fetchPage: httpFetch,
        getItemId: (item: number) => item,
        transport: "http",
      }),
    );
    expect(httpFetch.mock.calls[0]?.[0].limit).toBe(100);
    client.clear();
  } finally {
    delete nativeWindow.__TAURI_INTERNALS__;
  }
});

it("replaces capped and demand-loaded pages at their cached sizes after invalidation", async () => {
  const client = createInstantQueryClient();
  const stableWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let revision = 0;
  const requests: { cursor: number | null; limit: number }[] = [];
  const fetchPage = ({ cursor, limit }: { cursor: number | null; limit: number }) => {
    requests.push({ cursor, limit });
    const start = cursor ?? revision;
    return Promise.resolve({
      items: Array.from({ length: limit }, (_, index) => ({ id: start + index, revision })),
      nextCursor: start + limit,
    });
  };
  const { result } = renderHook(
    () =>
      useBackgroundList({
        queryKey: ["replacement-budget"],
        fetchPage,
        getItemId: (item: { id: number }) => item.id,
        pageSize: 2,
        maxBackgroundItems: 3,
        backgroundDelayMs: 0,
      }),
    { wrapper: stableWrapper },
  );
  await waitFor(() => {
    expect(result.current.pauseReason).toBe("limit");
  });
  expect(result.current.items.map((item) => item.id)).toEqual([0, 1, 2]);
  requests.length = 0;
  revision = 10;
  await act(() => client.invalidateQueries({ queryKey: ["replacement-budget"] }));
  expect(requests).toEqual([
    { cursor: null, limit: 2 },
    { cursor: 12, limit: 1 },
  ]);
  await waitFor(() => {
    expect(result.current.items).toEqual([10, 11, 12].map((id) => ({ id, revision: 10 })));
  });

  await act(() => result.current.onEndReached());
  await waitFor(() => {
    expect(result.current.items.map((item) => item.id)).toEqual([10, 11, 12, 13, 14]);
  });
  requests.length = 0;
  revision = 20;
  await act(() => result.current.refetch());
  expect(requests).toEqual([
    { cursor: null, limit: 2 },
    { cursor: 22, limit: 1 },
    { cursor: 23, limit: 2 },
  ]);
  await waitFor(() => {
    expect(result.current.items).toEqual([20, 21, 22, 23, 24].map((id) => ({ id, revision: 20 })));
  });
  expect(result.current.pauseReason).toBe("limit");
  client.clear();
});
