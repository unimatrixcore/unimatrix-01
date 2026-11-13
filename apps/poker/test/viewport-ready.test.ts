import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForViewport } from "../src/lib/viewport-ready";

function hostWithList(state: string, count: number) {
  const host = document.createElement("div");
  host.dataset.listExpected = "query";
  host.dataset.listRevision = "1";
  host.innerHTML = `<div data-list-revision="1" data-list-state="${state}" data-list-count="${count}"></div>`;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("first viewport readiness", () => {
  it("rechecks readiness when a replacement revision commits during the wait", async () => {
    vi.useFakeTimers();
    const host = hostWithList("ready", 0);
    let settled = false;
    const pending = waitForViewport(host, undefined, 1000).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    host.dataset.listRevision = "2";
    const state = host.firstElementChild as HTMLElement;
    state.dataset.listRevision = "2";
    state.dataset.listState = "pending";
    state.dataset.listCount = "1";
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);
    state.dataset.listState = "ready";
    state.dataset.listCount = "0";
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(true);
  });

  it("waits for the first list commit and image decode without waiting for another page", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON() {},
    });
    const host = hostWithList("pending", 0);
    let settled = false;
    const ready = waitForViewport(host, undefined, 1000).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    const state = host.firstElementChild as HTMLElement;
    state.dataset.listState = "ready";
    state.dataset.listCount = "1";
    const card = document.createElement("div");
    card.dataset.nativeCard = "";
    const image = document.createElement("img");
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
    let finish!: () => void;
    image.decode = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    card.append(image);
    state.append(card);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    finish();
    expect(await ready).toBe(true);
  });

  it("finishes for an empty or failed first page", async () => {
    const empty = hostWithList("ready", 0);
    expect(await waitForViewport(empty)).toBe(true);
    empty.remove();
    const error = hostWithList("error", 0);
    expect(await waitForViewport(error)).toBe(true);
  });

  it("bounds pending work and stops on cancellation or detached hosts", async () => {
    const host = hostWithList("pending", 0);
    expect(await waitForViewport(host, undefined, 30)).toBe(false);
    const controller = new AbortController();
    const pending = waitForViewport(host, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    host.remove();
    expect(await waitForViewport(host)).toBe(false);
  });
});
