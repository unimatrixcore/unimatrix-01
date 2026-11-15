import { beforeEach, expect, it, vi } from "vitest";
import { labListOptions, readLabListMeta } from "../src/lib/background-lists";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => false }));
beforeEach(() => mocks.invoke.mockReset());
it("calls the native page command with scoped request and retains metadata", async () => {
  mocks.invoke.mockResolvedValue({
    status: 200,
    headers: {},
    body: { items: [{ id: "a" }], nextCursor: "next", hasMore: true, total: 2, meta: { run: "r" } },
  });
  const options = labListOptions({
    path: "/api/queue",
    datasetId: "dataset",
    query: { order: "newest" },
    getItemId: (item: { id: string }) => item.id,
    parseItem: (value) => value as { id: string },
  });
  const page = await options.fetchPage({
    cursor: null,
    limit: 250,
    priority: "high",
    signal: new AbortController().signal,
  });
  expect(mocks.invoke).toHaveBeenCalledWith("lab_list_page", {
    request: {
      method: "GET",
      path: "/api/queue",
      body: null,
      query: { order: "newest" },
      headers: { "x-dataset-id": "dataset" },
    },
    cursor: null,
    limit: 250,
  });
  expect(page.items).toEqual([{ id: "a" }]);
  expect(readLabListMeta([page])).toEqual({ total: 2, meta: { run: "r" } });
});
it("rejects invalid pages and aborted requests", async () => {
  mocks.invoke.mockResolvedValue({
    status: 200,
    headers: {},
    body: { items: [], nextCursor: null, hasMore: true, total: 0, meta: {} },
  });
  const options = labListOptions({
    path: "/api/queue",
    getItemId: (item: string) => item,
    parseItem: String,
  });
  await expect(
    options.fetchPage({
      cursor: null,
      limit: 1,
      priority: "high",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    options.fetchPage({ cursor: null, limit: 1, priority: "high", signal: controller.signal }),
  ).rejects.toThrow();
});

const summaryConflict = {
  status: 409,
  headers: {},
  body: { error: "Frame evidence changed during summary read; retry" },
};
const gamePage = () =>
  labListOptions({
    path: "/api/gameplay/sessions/recording/frames",
    getItemId: (item: string) => item,
    parseItem: String,
  });
const pageContext = (signal = new AbortController().signal) => ({
  cursor: "page-2",
  limit: 10,
  priority: "high" as const,
  signal,
});
it("retries only a transient Gameplay summary conflict with the same page scope", async () => {
  mocks.invoke
    .mockResolvedValueOnce(summaryConflict)
    .mockResolvedValueOnce({
      ...summaryConflict,
      body: { error: "Frame profile changed during summary read; retry" },
    })
    .mockResolvedValue({
      status: 200,
      headers: {},
      body: { items: ["saved"], nextCursor: null, hasMore: false, total: 1, meta: {} },
    });
  expect((await gamePage().fetchPage(pageContext())).items).toEqual(["saved"]);
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  expect(
    mocks.invoke.mock.calls.every(
      (call) => JSON.stringify(call) === JSON.stringify(mocks.invoke.mock.calls[0]),
    ),
  ).toBe(true);
});
it("bounds summary conflict retries and does not retry other conflicts or endpoints", async () => {
  mocks.invoke.mockResolvedValue(summaryConflict);
  await expect(gamePage().fetchPage(pageContext())).rejects.toThrow();
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ ...summaryConflict, body: { error: "Cursor expired" } });
  await expect(gamePage().fetchPage(pageContext())).rejects.toThrow();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue(summaryConflict);
  const unrelated = labListOptions({ path: "/api/queue", getItemId: String, parseItem: String });
  await expect(unrelated.fetchPage(pageContext())).rejects.toThrow();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("cancels a summary retry during backoff without issuing another invocation", async () => {
  mocks.invoke.mockResolvedValue(summaryConflict);
  const controller = new AbortController();
  const pending = gamePage().fetchPage(pageContext(controller.signal));
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => {
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  controller.abort();
  await rejected;
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
