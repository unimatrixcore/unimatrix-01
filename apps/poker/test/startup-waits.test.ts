import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../public/static/js/app.js"), "utf8");
const waits = source.slice(
  source.indexOf("let viewportReadiness = null;"),
  source.indexOf("async function init()"),
);

function fixture() {
  const target = new EventTarget();
  const location = { pathname: "/collection" };
  const pending: Array<{ signal: AbortSignal; release: () => void }> = [];
  const waitForViewport = vi.fn(
    (_host: unknown, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        pending.push({
          signal,
          release: () => {
            resolve(true);
          },
        });
        if (pending.length <= 10)
          signal.addEventListener(
            "abort",
            () => {
              resolve(false);
            },
            { once: true },
          );
      }),
  );
  const context = {
    AbortController,
    window: Object.assign(target, { location, CollectorBackgroundLists: { waitForViewport } }),
    currentView: "collection",
    frameListEl: {},
    dbListEl: {},
    sessionReviewListEl: {},
    viewLabeling: {},
    showToast: vi.fn(),
  };
  const wait = runInNewContext(`${waits}\nwaitForCurrentViewport;`, context) as () => Promise<void>;
  const navigate = (pathname: string) => {
    location.pathname = pathname;
    target.dispatchEvent(new Event("poker-workspace-change"));
  };
  return { wait, navigate, pending, waitForViewport, showToast: context.showToast };
}

describe("OCR startup waits", () => {
  it("settles a superseded wait without cancelling its successor", async () => {
    const state = fixture();
    let superseded = false;
    void state.wait().then(() => {
      superseded = true;
    });
    const current = state.wait();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(superseded).toBe(true);
    expect(state.waitForViewport).toHaveBeenCalledTimes(2);
    expect(state.pending[0]!.signal.aborted).toBe(true);
    expect(state.pending[1]!.signal.aborted).toBe(false);
    state.pending[1]!.release();
    await current;
    expect(state.showToast).not.toHaveBeenCalled();
  });

  it("retries after a workspace interruption only while it owns the wait", async () => {
    const state = fixture();
    const first = state.wait();
    state.navigate("/gameplay");
    await Promise.resolve();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    const replacement = state.wait();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(settled).toBe(true);
    state.navigate("/collection");
    await Promise.resolve();
    expect(state.waitForViewport).toHaveBeenCalledTimes(2);
    state.pending[1]!.release();
    await replacement;

    const next = state.wait();
    state.navigate("/gameplay");
    await Promise.resolve();
    state.navigate("/collection");
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(state.waitForViewport).toHaveBeenCalledTimes(4);
    state.pending[3]!.release();
    await next;
  });
});

afterEach(() => vi.useRealTimers());

it("bounds the database probe, aborts its page chain, and ignores a late result", async () => {
  vi.useFakeTimers();
  let release!: (value: { items: unknown[] }) => void;
  const readPages = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    window: { CollectorBackgroundLists: { readPages } },
    activeDatasetId: "fixture",
    dbTotal: 0,
    console: { warn: vi.fn() },
  };
  const probe = runInNewContext(
    `${waits}\nprobeDatabaseAvailability;`,
    context,
  ) as () => Promise<void>;
  let settled = false;
  const pending = probe().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(2999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  const signal = (readPages.mock.calls as unknown[][])[0]![5] as AbortSignal;
  expect(signal.aborted).toBe(true);
  expect(context.console.warn).toHaveBeenCalledOnce();
  release({ items: [{ filename: "late.png" }] });
  await Promise.resolve();
  expect(context.dbTotal).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the database probe deadline after success", async () => {
  vi.useFakeTimers();
  const readPages = vi.fn(() => Promise.resolve({ items: [{ filename: "saved.png" }] }));
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    window: { CollectorBackgroundLists: { readPages } },
    activeDatasetId: "fixture",
    dbTotal: 0,
    console: { warn: vi.fn() },
  };
  const probe = runInNewContext(
    `${waits}\nprobeDatabaseAvailability;`,
    context,
  ) as () => Promise<void>;
  await probe();
  expect(context.dbTotal).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(context.console.warn).not.toHaveBeenCalled();
});
