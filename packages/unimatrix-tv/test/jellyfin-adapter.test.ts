import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installJellyfinAdapter, getClientConfig } from "../src/jellyfin-adapter.js";

const host = window as Window & { ApiClient?: unknown };
const disposers: (() => void)[] = [];
const movie = {
  Id: "m1",
  Name: "First movie",
  Type: "Movie",
  Path: "/media/first.mp4",
  Overview: "First synopsis",
  ProductionYear: 2020,
  BackdropImageTags: ["art"],
};
const other = { Id: "m2", Name: "Second movie", Type: "Movie", Path: "/media/second.mp4" };
const series = { Id: "s1", Name: "Series", Type: "Series" };
const episode = { Id: "e1", Name: "Episode", Type: "Episode", Path: "/media/episode.mp4" };
let decode = vi.fn<() => Promise<void>>();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function api(items: unknown[] = [movie]) {
  const getItems = vi.fn(
    (
      _user: string,
      query: Record<string, string | number | boolean>,
    ): Promise<{ Items: unknown[] }> => {
      if (query.IncludeItemTypes === "Episode")
        return Promise.resolve({ Items: query.ParentId === "s1" ? [episode] : [] });
      const ids = typeof query.Ids === "string" ? query.Ids.split(",") : undefined;
      if (ids)
        return Promise.resolve({
          Items: [movie, other, series, episode].filter((item) => ids.includes(item.Id)),
        });
      return Promise.resolve({ Items: items });
    },
  );
  const result = {
    getCurrentUserId: vi.fn(() => "u1"),
    serverId: () => "srv1",
    getItems,
    getItem: vi.fn((_user: string, id: string): Promise<unknown> =>
      Promise.resolve({ ...movie, Id: id }),
    ),
    getUserViews: vi.fn(() =>
      Promise.resolve({
        Items: [
          { Id: "movies", Name: "Movies", Type: "CollectionFolder", CollectionType: "movies" },
        ],
      }),
    ),
    getImageUrl: (id: string) => "/images/" + id,
  };
  host.ApiClient = result;
  return result;
}

function markup(home = true): HTMLElement {
  document.body.innerHTML =
    '<header class="MuiAppBar-root"><div class="MuiToolbar-root"><button aria-label="Open Menu"></button><div class="MuiStack-root"><a href="#/movies">Movies</a></div></div></header>' +
    (home
      ? '<div id="homeTab" class="page"><div class="sections"></div></div>'
      : '<div id="moviesPage" class="page libraryPage"></div>');
  const page = document.querySelector<HTMLElement>(".page");
  if (!page) throw new Error("Missing page fixture");
  return page;
}

function card(id = "m1", type = "Movie", title = "Native movie"): HTMLElement {
  const node = document.createElement("div");
  node.className = "card overflowPortraitCard";
  node.dataset.id = id;
  node.dataset.type = type;
  node.innerHTML =
    '<div class="cardBox"><div class="cardImageContainer"><div class="itemProgressBar"><div style="width:42%"></div></div></div></div><div class="cardText-first">' +
    title +
    '</div><div class="cardText-secondary">2020</div><button data-action="resume">Resume</button>';
  return node;
}

function install() {
  const gate = { begin: vi.fn(), ready: vi.fn(), fail: vi.fn() };
  disposers.push(installJellyfinAdapter(gate));
  return gate;
}

function navigate(hash: string): void {
  history.replaceState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

async function settle(milliseconds = 1400): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

describe("Jellyfin adapter behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.className = "";
    document.body.innerHTML = "";
    history.replaceState(null, "", "#/home");
    decode = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = () => decode();
      },
    );
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height: this.closest(".hide,[hidden]") ? 0 : 500,
        width: 1000,
        x: 0,
        y: 0,
        top: 0,
        bottom: 500,
        left: 0,
        right: 1000,
        toJSON: () => ({}),
      };
    });
  });
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    delete host.ApiClient;
    delete window.__unimatrixTVConfig;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for first artwork but keeps native resume actions and progress intact", async () => {
    const page = markup();
    const native = card();
    page.querySelector(".sections")?.append(native);
    const progress = native.querySelector(".itemProgressBar");
    const onPlay = vi.fn();
    native.querySelector("button")?.addEventListener("click", onPlay);
    const art = deferred<void>();
    decode.mockReturnValue(art.promise);
    api();
    const gate = install();
    await settle(1200);
    expect(gate.ready).not.toHaveBeenCalled();
    expect(page.querySelector("#utv-featured")).not.toBeNull();
    art.resolve();
    await settle();
    expect(gate.ready).toHaveBeenCalledTimes(1);
    expect(gate.fail).not.toHaveBeenCalled();
    (page.querySelector("#utv-featured .utv-action") as HTMLButtonElement).click();
    expect(page.querySelector("#utv-featured .utv-action")?.textContent).toContain("Resume");
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(native.querySelector(".itemProgressBar")).toBe(progress);
    expect(progress?.firstElementChild?.getAttribute("style")).toBe("width:42%");
  });

  it("does not block browsing when cached playback DOM remains after returning home", async () => {
    markup();
    const cached = document.createElement("div");
    cached.className = "hide videoPlayerContainer";
    cached.innerHTML = '<video></video><div class="nowPlayingBar"></div>';
    document.body.append(cached);
    api();
    navigate("#/video");
    const gate = install();
    expect(gate.begin).not.toHaveBeenCalled();
    navigate("#/home");
    await settle();
    expect(gate.begin).toHaveBeenCalled();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("First movie");
    expect(gate.fail).not.toHaveBeenCalled();
  });

  it("recovers an interrupted cached hero when navigating back before artwork finishes", async () => {
    markup();
    const first = deferred<void>();
    decode.mockReturnValueOnce(first.promise);
    api();
    const gate = install();
    await settle(50);
    expect(document.querySelector("#utv-featured")?.getAttribute("data-ready")).toBeNull();
    navigate("#/video");
    navigate("#/home");
    await settle();
    expect(document.querySelector("#utv-featured")?.getAttribute("data-ready")).toBe("true");
    expect(gate.fail).not.toHaveBeenCalled();
    first.resolve();
    await settle();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("First movie");
  });

  it("degrades missing hero artwork without failing the library", async () => {
    markup();
    api();
    decode.mockRejectedValue(new Error("Image unavailable"));
    const gate = install();
    await settle();
    expect(gate.ready).toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("First movie");
    expect(document.querySelector("#utv-featured .utv-action")?.textContent).toContain(
      "View title",
    );
  });

  it("ignores stale responses from a previous user and lets the new user finish", async () => {
    markup();
    const pending = deferred<{ Items: unknown[] }>();
    const client = api();
    client.getItems.mockImplementation(async (user, query) => {
      if (query.Ids) return { Items: [] };
      return user === "u1" ? pending.promise : { Items: [other] };
    });
    const gate = install();
    await settle(10);
    client.getCurrentUserId.mockReturnValue("u2");
    document.dispatchEvent(new Event("viewshow"));
    await settle();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("Second movie");
    pending.resolve({ Items: [movie] });
    await settle();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("Second movie");
    expect(gate.fail).not.toHaveBeenCalled();
  });

  it("keeps adapting paginated cards and clears recycled synopsis and year text", async () => {
    navigate("#/movies");
    const page = markup(false);
    const client = api();
    const gate = install();
    await settle();
    expect(gate.ready).toHaveBeenCalledTimes(1);
    const native = card();
    page.append(native);
    await settle();
    expect(native.querySelector(".utv-card-overview")?.textContent).toBe("First synopsis");
    expect(native.querySelector(".utv-card-status-badge")?.getAttribute("aria-label")).toBe(
      "Available",
    );
    native.dataset.id = "missing";
    native
      .querySelector(".cardText-first")
      ?.replaceChildren(document.createTextNode("Replacement title"));
    native.querySelector(".cardText-secondary")?.replaceChildren();
    client.getItems.mockResolvedValue({ Items: [] });
    await settle();
    expect(native.querySelector(".utv-card-title")?.textContent).toBe("Replacement title");
    expect(native.querySelector(".utv-card-overview")?.textContent).toBe("");
    expect(native.querySelector(".utv-card-year")?.textContent).toBe("");
    expect(native.querySelector(".utv-card-status-badge")).toBeNull();
    expect(gate.begin).toHaveBeenCalledTimes(1);
    native.dataset.type = "Person";
    await settle();
    expect(native.querySelector(".utv-card-hover-overlay")).toBeNull();
    expect(native.querySelector(".utv-card-badges")).toBeNull();
  });

  it("features only file-backed movies and series with at least one file-backed episode", async () => {
    const page = markup();
    const virtual = { ...movie, Id: "virtual", Name: "Unavailable", IsVirtualItem: true };
    const emptySeries = { ...series, Id: "empty", Name: "Empty series" };
    api([virtual, { ...movie, Path: undefined, MediaSources: [] }, series, emptySeries]);
    const s = card("s1", "Series");
    const v = card("virtual");
    page.querySelector(".sections")?.append(s, v);
    install();
    await settle();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("Series");
    expect(document.querySelector("#utv-featured")?.textContent).not.toContain("Unavailable");
    expect(s.querySelector(".utv-card-status-badge")).not.toBeNull();
    expect(v.querySelector(".utv-card-status-badge")).toBeNull();
  });

  it("preserves keyboard focus through featured selection", async () => {
    markup();
    api([movie, other]);
    install();
    await settle();
    const next = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next featured title"]',
    );
    next?.focus();
    next?.click();
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Next featured title");
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("Second movie");
  });

  it("uninstall removes observers, event hooks, deadline timers, and restores native detail actions", async () => {
    navigate("#/details?id=m1");
    const page = markup(false);
    page.id = "itemDetailPage";
    page.innerHTML =
      '<div class="detailPagePrimaryContainer"></div><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnDelete">Delete</button></div>';
    const remove = vi.spyOn(document, "removeEventListener");
    api();
    const gate = install();
    await settle();
    const nativeDelete = page.querySelector<HTMLButtonElement>(".btnDelete");
    expect(nativeDelete?.closest("details")).not.toBeNull();
    disposers.pop()?.();
    expect(nativeDelete?.parentElement?.className).toBe("mainDetailButtons");
    expect(remove.mock.calls.some(([name]) => name === "pointerdown")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const beginCount = gate.begin.mock.calls.length;
    navigate("#/home");
    document.dispatchEvent(new Event("viewshow"));
    page.append(card());
    await settle();
    expect(gate.begin).toHaveBeenCalledTimes(beginCount);
    expect(page.querySelector(".utv-card-badges")).toBeNull();
  });

  it("uses configured requests and asset locations and rejects unsafe values", async () => {
    window.__unimatrixTVConfig = {
      enabled: true,
      bootGate: false,
      requestsUrl: "https://requests.example.test/",
      assetsBase: "/branding/",
    };
    markup();
    api();
    install();
    await settle();
    expect(document.querySelector(".utv-header-requests")?.getAttribute("href")).toBe(
      "https://requests.example.test/",
    );
    expect(getClientConfig().assetsBase).toBe("/branding/");
    window.__unimatrixTVConfig.requestsUrl = "javascript:alert(1)";
    window.__unimatrixTVConfig.assetsBase = "//evil.test/";
    expect(getClientConfig().requestsUrl).toBe("https://requests.unimatrix-01.dev/");
    expect(getClientConfig().assetsBase).toBe("/UnimatrixTV/assets/");
  });

  it("does no work when the presentation plugin is disabled", () => {
    window.__unimatrixTVConfig = {
      enabled: false,
      bootGate: true,
      requestsUrl: "https://requests.example.test/",
      assetsBase: "/branding/",
    };
    markup();
    const client = api();
    const gate = install();
    expect(client.getItems).not.toHaveBeenCalled();
    expect(gate.begin).not.toHaveBeenCalled();
    expect(document.querySelector("[data-utv-owned]")).toBeNull();
  });
  it("leaves native sign-in controls usable and applies the configured branding", async () => {
    navigate("#/login");
    document.body.innerHTML =
      '<div id="loginPage" class="page"><form class="manualLoginForm"><h1>Old heading</h1><input name="username"><input type="password"><button type="submit">Sign in</button></form><div class="loginDisclaimer">Old promotional copy</div></div>';
    window.__unimatrixTVConfig = {
      enabled: true,
      bootGate: true,
      requestsUrl: "https://requests.example.test/",
      assetsBase: "/branding/",
    };
    const submit = document.querySelector("button");
    const gate = install();
    await settle();
    expect(document.querySelector(".manualLoginForm h1")?.textContent).toBe("Sign in");
    expect(document.querySelector(".manualLoginForm button")).toBe(submit);
    expect(document.querySelector("#utv-login-scene img")?.getAttribute("src")).toBe(
      "/branding/logo.png",
    );
    expect(document.querySelector(".loginDisclaimer a")?.getAttribute("href")).toBe(
      "https://requests.example.test/",
    );
    expect(gate.ready).toHaveBeenCalledTimes(1);
  });

  it("shows the empty library state without fictional playable titles", async () => {
    const page = markup();
    const section = document.createElement("div");
    section.className = "verticalSection";
    section.innerHTML = '<div class="card" data-type="CollectionFolder"></div>';
    page.querySelector(".sections")?.append(section);
    api([]);
    const gate = install();
    await settle();
    expect(document.querySelector("#utv-empty h1")?.textContent).toBe("No available titles");
    expect(document.querySelector("#utv-empty a")?.getAttribute("href")).toBe(
      "https://requests.unimatrix-01.dev/",
    );
    expect(document.querySelector("#utv-featured")).toBeNull();
    expect(section.style.display).toBe("none");
    disposers.pop()?.();
    expect(section.style.display).toBe("");
    expect(gate.fail).not.toHaveBeenCalled();
  });

  it("opens and closes mobile navigation with honest aria state and restored focus", async () => {
    markup();
    api();
    install();
    await settle();
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="Open Menu"]');
    menu?.click();
    expect(menu?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Home");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu);
    menu?.click();
    document.querySelector<HTMLAnchorElement>(".utv-main-nav a")?.click();
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.classList.contains("utv-mobile-menu-open")).toBe(false);
  });

  it("preserves native detail actions when artwork fails and supports closing More actions", async () => {
    navigate("#/details?id=m1");
    const page = markup(false);
    page.id = "itemDetailPage";
    page.innerHTML =
      '<div class="detailPagePrimaryContainer"></div><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnUserRating">Favorite</button><button class="btnDelete">Delete</button><button class="btnDownload hide" hidden>Download</button></div>';
    const onDelete = vi.fn();
    const nativeDelete = page.querySelector<HTMLButtonElement>(".btnDelete");
    nativeDelete?.addEventListener("click", onDelete);
    const client = api();
    client.getItem.mockResolvedValue({
      ...movie,
      Genres: ["Drama"],
      People: [
        { Id: "actor", Name: "Actor name", Type: "Actor" },
        { Id: "director", Name: "Director name", Type: "Director" },
      ],
    });
    decode.mockRejectedValue(new Error("Artwork failed"));
    const gate = install();
    await settle();
    expect(gate.ready).toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
    expect(page.querySelector(".utv-detail-personnel")?.textContent).toContain("Actor name");
    const tools = page.querySelector<HTMLDetailsElement>(".utv-detail-tools");
    if (!tools) throw new Error("Missing More actions");
    tools.open = true;
    tools.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tools.open).toBe(false);
    expect(document.activeElement).toBe(tools.querySelector("summary"));
    tools.open = true;
    const outside = new Event("pointerdown", { bubbles: true });
    page.dispatchEvent(outside);
    expect(tools.open).toBe(false);
    tools.open = true;
    nativeDelete?.click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(tools.open).toBe(false);
    expect(page.querySelector(".mainDetailButtons > .btnPlay")).not.toBeNull();
    const download = page.querySelector<HTMLButtonElement>(".btnDownload");
    expect(download?.hidden).toBe(true);
    expect(download?.classList.contains("hide")).toBe(true);
  });

  it("keeps non-media detail pages native and removes stale media enhancements", async () => {
    navigate("#/details?id=m1");
    const page = markup(false);
    page.id = "itemDetailPage";
    page.innerHTML =
      '<div class="detailPagePrimaryContainer"></div><div class="mainDetailButtons"><button class="btnDelete">Delete</button></div>';
    const client = api();
    install();
    await settle();
    expect(page.querySelector(".utv-detail-art")).not.toBeNull();
    client.getItem.mockResolvedValue({ ...movie, Id: "person", Type: "Person" });
    navigate("#/details?id=person");
    await settle();
    expect(page.querySelector(".utv-detail-art")).toBeNull();
    expect(page.querySelector(".utv-detail-tools")).toBeNull();
    expect(page.querySelector(".mainDetailButtons > .btnDelete")).not.toBeNull();
    const count = client.getItem.mock.calls.length;
    document.dispatchEvent(new Event("viewshow"));
    await settle();
    expect(client.getItem).toHaveBeenCalledTimes(count);
  });

  it("corrects undefined native server links and keeps Favorites separate from featured Home", async () => {
    navigate("#/home?tab=1");
    const page = markup();
    const native = card();
    native.innerHTML += '<a href="#/details?id=m1&serverId=undefined">Details</a>';
    page.append(native);
    api();
    const gate = install();
    await settle();
    expect(native.querySelector("a")?.getAttribute("href")).toBe("#/details?id=m1&serverId=srv1");
    expect(document.querySelector("#utv-featured")).toBeNull();
    expect(document.querySelector('.utv-main-nav a[aria-current="page"]')?.textContent).toBe(
      "Favorites",
    );
    expect(gate.ready).toHaveBeenCalled();
  });

  it("degrades unavailable synopsis metadata while preserving native card titles", async () => {
    navigate("#/movies");
    const page = markup(false);
    const native = card();
    page.append(native);
    const client = api();
    client.getItems.mockRejectedValue(new Error("Metadata temporarily unavailable"));
    const gate = install();
    await settle();
    expect(native.querySelector(".utv-card-title")?.textContent).toBe("Native movie");
    expect(native.querySelector(".utv-card-status-badge")).toBeNull();
    expect(gate.ready).toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
  });

  it("times out a stalled title pipeline and cancels outstanding work on uninstall", async () => {
    markup();
    const client = api();
    const pending = deferred<{ Items: unknown[] }>();
    client.getItems.mockReturnValue(pending.promise);
    const gate = install();
    await settle(15100);
    expect(gate.fail).toHaveBeenCalledTimes(1);
    disposers.pop()?.();
    await settle(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ Items: [movie] });
    await settle();
    expect(document.querySelector("#utv-featured")).toBeNull();
  });

  it("uninstall cancels pending artwork without late DOM updates or timer leaks", async () => {
    markup();
    api();
    const image = deferred<void>();
    decode.mockReturnValue(image.promise);
    const gate = install();
    await settle(100);
    disposers.pop()?.();
    await settle(1);
    expect(vi.getTimerCount()).toBe(0);
    image.resolve();
    await settle();
    expect(gate.ready).not.toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
    expect(document.querySelector("#utv-featured")).toBeNull();
  });

  it("changes featured titles by keyboard and touch without activating the backdrop link", async () => {
    markup();
    api([movie, other]);
    install();
    await settle();
    const dot = document.querySelector<HTMLButtonElement>(".utv-featured-tabs button");
    dot?.focus();
    dot?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("Second movie");
    const shell = document.querySelector("#utv-featured");
    const hit = shell?.querySelector(".utv-featured-hit");
    for (const [type, x] of [
      ["pointerdown", 200],
      ["pointerup", 300],
    ] as const) {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerType: "touch", clientX: x, clientY: 100 });
      hit?.dispatchEvent(event);
    }
    await settle(50);
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("First movie");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    shell?.querySelector(".utv-featured-hit")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(location.hash).toBe("#/home");
  });

  it("uses native library navigation when user-view discovery fails without retrying in a loop", async () => {
    markup();
    const client = api();
    client.getUserViews.mockRejectedValue(new Error("Views unavailable"));
    const gate = install();
    await settle();
    expect(gate.ready).toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
    expect(client.getUserViews).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.utv-main-nav a[href="#/movies"]')?.textContent).toBe("Movies");
  });
  it("keeps proven movies usable when availability lookup for one series fails", async () => {
    const page = markup();
    const native = card();
    const s = card("s1", "Series");
    page.querySelector(".sections")?.append(native, s);
    const client = api([movie, series]);
    const base = client.getItems.getMockImplementation();
    if (!base) throw new Error("Missing API fixture");
    client.getItems.mockImplementation((user, query) =>
      query.IncludeItemTypes === "Episode"
        ? Promise.reject(new Error("Series unavailable"))
        : base(user, query),
    );
    const gate = install();
    await settle();
    expect(gate.fail).not.toHaveBeenCalled();
    expect(gate.ready).toHaveBeenCalled();
    expect(document.querySelector("#utv-featured h1")?.textContent).toBe("First movie");
    expect(native.querySelector(".utv-card-status-badge")).not.toBeNull();
    expect(s.querySelector(".utv-card-status-badge")).toBeNull();
  });

  it("bounds the complete title-and-episode pipeline with one deadline", async () => {
    markup();
    const first = deferred<{ Items: unknown[] }>();
    const episodes = deferred<{ Items: unknown[] }>();
    const client = api();
    client.getItems.mockImplementation((_user, query) =>
      query.IncludeItemTypes === "Episode" ? episodes.promise : first.promise,
    );
    const gate = install();
    await settle(9000);
    first.resolve({ Items: [series] });
    await settle(6100);
    expect(gate.fail).toHaveBeenCalledTimes(1);
    expect(gate.ready).not.toHaveBeenCalled();
    episodes.resolve({ Items: [episode] });
    await settle();
    expect(document.querySelector("#utv-featured")).toBeNull();
  });
});
