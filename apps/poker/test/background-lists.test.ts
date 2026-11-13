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
