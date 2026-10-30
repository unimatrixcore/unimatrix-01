import { afterEach, expect, it, vi } from "vitest";
import { installJellyfinAdapter } from "../src/jellyfin-adapter.js";

const host = window as Window & { ApiClient?: unknown };
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  delete host.ApiClient;
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("links the whole episode, updates rail bounds, and remembers only this viewer's season", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 500,
    width: 1000,
    height: 500,
    toJSON: () => ({}),
  });
  let viewer = "gwen";
  host.ApiClient = {
    getCurrentUserId: () => viewer,
    serverId: () => "server",
    getUserViews: () => Promise.resolve({ Items: [] }),
    getImageUrl: () => "/episode.jpg",
    getItem: () => Promise.resolve({ Id: "series", Name: "A series", Type: "Series" }),
    getItems: (_user: string, query: Record<string, unknown>) =>
      Promise.resolve({
        Items:
          query.IncludeItemTypes === "Episode"
            ? [
                {
                  Id: "one",
                  Name: "First",
                  Type: "Episode",
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  Path: "/media/first.mkv",
                  Overview: "First synopsis",
                  RunTimeTicks: 30000000000,
                },
                {
                  Id: "two",
                  Name: "Second",
                  Type: "Episode",
                  ParentIndexNumber: 2,
                  IndexNumber: 1,
                  Path: "/media/second.mkv",
                },
                {
                  Id: "missing",
                  Name: "Missing",
                  Type: "Episode",
                  ParentIndexNumber: 3,
                  IsVirtualItem: true,
                },
              ]
            : [],
      }),
  };
  document.body.innerHTML =
    '<div id="itemDetailPage" class="page"><div class="detailPagePrimaryContainer"></div></div>';
  history.replaceState(null, "", "#/details?id=series");
  dispose = installJellyfinAdapter({ begin: vi.fn(), ready: vi.fn(), fail: vi.fn() });
  await vi.advanceTimersByTimeAsync(1400);
  const select = document.querySelector<HTMLSelectElement>(".utv-series-shelf select")!;
  expect([...select.options].map((option) => option.value)).toEqual(["1", "2"]);
  const content = document.querySelector<HTMLAnchorElement>(".utv-episode-link")!;
  expect(content.getAttribute("href")).toContain("id=one");
  expect(content.querySelector(".utv-episode-description")?.textContent).toBe("First synopsis");
  expect(content.querySelectorAll("a,button")).toHaveLength(0);
  expect(content.textContent).toContain("50m");
  const rail = document.querySelector<HTMLElement>(".utv-episode-rail")!;
  Object.defineProperties(rail, { clientWidth: { value: 600 }, scrollWidth: { value: 1800 } });
  const [previous, next] = document.querySelectorAll<HTMLButtonElement>(
    ".utv-series-controls button",
  );
  rail.dispatchEvent(new Event("scroll"));
  expect(previous!.disabled).toBe(true);
  expect(next!.disabled).toBe(false);
  rail.scrollLeft = 1200;
  rail.dispatchEvent(new Event("scroll"));
  expect(previous!.disabled).toBe(false);
  expect(next!.disabled).toBe(true);
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(rail.scrollLeft).toBe(0);
  expect(previous!.disabled).toBe(true);
  expect(document.querySelector(".utv-episode-title")?.textContent).toBe("Second");
  history.replaceState(null, "", "#/details?id=away");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await vi.advanceTimersByTimeAsync(1400);
  expect(document.querySelector<HTMLSelectElement>(".utv-series-shelf select")!.value).toBe("2");
  viewer = "another";
  document.dispatchEvent(new Event("viewshow"));
  await vi.advanceTimersByTimeAsync(1400);
  expect(document.querySelector<HTMLSelectElement>(".utv-series-shelf select")!.value).toBe("1");
});
