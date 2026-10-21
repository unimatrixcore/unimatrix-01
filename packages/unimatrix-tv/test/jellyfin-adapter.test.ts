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
    updateFavoriteStatus: vi.fn(() => Promise.resolve()),
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
    '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"><div class="itemProgressBar"><div style="width:42%"></div></div></div></div></div><div class="cardText-first">' +
    title +
    '</div><div class="cardText-secondary">2020</div><button data-action="resume">Resume</button>';
  return node;
}

function openCardActions(card: HTMLElement): void {
  card.querySelector<HTMLButtonElement>(".utv-card-menu-trigger")?.click();
}

function menuAction(label: string): HTMLButtonElement {
  const action = [
    ...document.querySelectorAll<HTMLButtonElement>(".utv-card-menu [role=menuitem]"),
  ].find((button) => button.textContent === label);
  if (!action) throw new Error("Missing menu action: " + label);
  return action;
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
    expect(native.querySelector(".utv-card-hover-overlay")).toBeNull();
    expect(native.querySelector(".utv-card-favorite-btn")).toBeNull();
    expect(native.querySelector(".utv-card-menu-trigger")?.getAttribute("aria-label")).toContain(
      "First movie",
    );
    native.dataset.id = "missing";
    native
      .querySelector(".cardText-first")
      ?.replaceChildren(document.createTextNode("Replacement title"));
    native.querySelector(".cardText-secondary")?.replaceChildren();
    client.getItems.mockResolvedValue({ Items: [] });
    await settle();
    expect(native.querySelector(".cardText-first")?.textContent).toBe("Replacement title");
    expect(native.querySelector(".utv-card-menu-trigger")?.getAttribute("aria-label")).toContain(
      "Replacement title",
    );
    expect(native.querySelector(".utv-card-hover-overlay")).toBeNull();
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
      '<div class="detailPagePrimaryContainer"></div><div class="overview-controls"><span class="overview-expand">Show more</span></div><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnDelete">Delete</button></div>';
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

  it("renders only available episodes with an Apple-style season selector and keeps native fallback on failure", async () => {
    navigate("#/details?id=s1");
    const page = markup(false);
    page.id = "itemDetailPage";
    page.innerHTML =
      '<div class="detailPagePrimaryContainer"></div><div class="mainDetailButtons"><button class="btnPlay">Play</button></div>';
    const client = api();
    client.getItem.mockResolvedValue(series);
    client.getItems.mockImplementation((_user, query) =>
      Promise.resolve(
        query.IncludeItemTypes === "Episode"
          ? {
              Items: [
                {
                  ...episode,
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  Overview: "Episode synopsis",
                  RunTimeTicks: 12000000000,
                  UserData: { PlaybackPositionTicks: 6000000000 },
                },
                {
                  ...episode,
                  Id: "e2",
                  Name: "Second season episode",
                  ParentIndexNumber: 2,
                  IndexNumber: 1,
                  UserData: { Played: true },
                },
                {
                  Id: "missing",
                  Name: "Unavailable",
                  Type: "Episode",
                  ParentIndexNumber: 1,
                  IndexNumber: 2,
                  IsVirtualItem: true,
                },
              ],
            }
          : { Items: [] },
      ),
    );
    install();
    await settle();
    const select = page.querySelector<HTMLSelectElement>(".utv-series-shelf select");
    expect(select).not.toBeNull();
    expect(page.classList.contains("utv-series-ready")).toBe(true);
    expect(page.querySelectorAll(".utv-episode-card")).toHaveLength(1);
    expect(page.querySelector(".utv-episode-card")?.textContent).toContain("Episode synopsis");
    expect(page.querySelector<HTMLElement>(".utv-episode-progress span")?.style.width).toBe("50%");
    expect(page.querySelector("a.utv-episode-link")?.getAttribute("href")).toContain("id=e1");
    select!.value = "2";
    select!.dispatchEvent(new Event("change"));
    expect(page.querySelector(".utv-episode-card")?.textContent).toContain("Second season episode");
    expect(page.querySelector(".utv-episode-card")?.textContent).toContain("WATCHED");
    client.getItem.mockResolvedValue({
      ...series,
      Id: "season",
      Type: "Season",
      SeriesId: "s1",
      IndexNumber: 2,
    });
    navigate("#/details?id=season");
    await settle();
    expect(page.querySelector<HTMLSelectElement>(".utv-series-shelf select")?.value).toBe("2");
    client.getItems.mockRejectedValue(new Error("offline"));
    navigate("#/details?id=unavailable");
    await settle();
    expect(page.classList.contains("utv-series-ready")).toBe(false);
    expect(page.querySelector(".utv-series-shelf")).toBeNull();
  });

  it("preserves native detail actions when artwork fails and supports closing More actions", async () => {
    navigate("#/details?id=m1");
    const page = markup(false);
    page.id = "itemDetailPage";
    page.innerHTML =
      '<div class="detailPagePrimaryContainer"></div><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnUserRating">Favorite</button><button class="btnDelete">Delete</button><button class="btnDownload hide" hidden>Download</button></div>';
    page.innerHTML +=
      '<div class="overview-controls"><span class="overview-expand">Show more</span></div>';
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
    const synopsis = page.querySelector<HTMLButtonElement>(".utv-synopsis-trigger");
    synopsis?.click();
    expect(document.querySelector(".utv-synopsis-dialog p")?.textContent).toBe(movie.Overview);
    document.querySelector<HTMLButtonElement>(".utv-synopsis-close")?.click();
    expect(document.querySelector<HTMLDialogElement>(".utv-synopsis-dialog")?.hidden).toBe(true);
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
    expect(native.querySelector(".cardText-first")?.textContent).toBe("Native movie");
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

  it("reuses navigation when the responsive native header changes its stack", async () => {
    markup();
    api();
    install();
    await settle();
    const row = document.querySelector(".MuiToolbar-root")!;
    const oldStack = row.querySelector(".MuiStack-root")!;
    row.append(...Array.from(oldStack.childNodes));
    oldStack.remove();
    await settle();
    const newStack = document.createElement("div");
    newStack.className = "MuiStack-root";
    row.append(newStack);
    await settle();
    expect(row.querySelectorAll(".utv-main-nav")).toHaveLength(1);
    expect(newStack.querySelector(".utv-main-nav")).not.toBeNull();
    expect(row.querySelector(".utv-mobile-brand")).toBeNull();
  });

  it("keeps private Footage out of main navigation without intercepting its native library route", async () => {
    markup(false);
    const client = api();
    client.getUserViews.mockResolvedValue({
      Items: [
        { Id: "movies", Name: "Movies", Type: "CollectionFolder", CollectionType: "movies" },
        { Id: "footage", Name: "Footage", Type: "CollectionFolder", CollectionType: "homevideos" },
      ],
    });
    navigate("#/list?parentId=footage&serverId=srv1");
    install();
    await settle();
    expect(document.querySelector(".utv-main-nav")?.textContent).not.toContain("Footage");
    expect(document.querySelector('.utv-main-nav a[href*="parentId=footage"]')).toBeNull();
    expect(location.hash).toBe("#/list?parentId=footage&serverId=srv1");
    expect(document.querySelector("#moviesPage")).not.toBeNull();
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

  it("handles favorite menu toggles and failure retry", async () => {
    const page = markup();
    const native = card();
    page.querySelector(".sections")?.append(native);
    const client = api();
    install();
    await settle();
    openCardActions(native);
    menuAction("Add favorite").click();
    await settle();
    expect(client.updateFavoriteStatus).toHaveBeenCalledWith("u1", "m1", true);
    expect(document.querySelector<HTMLElement>(".utv-card-menu")?.hidden).toBe(true);
    client.updateFavoriteStatus.mockRejectedValueOnce(new Error("Network failed"));
    openCardActions(native);
    menuAction("Remove favorite").click();
    await settle();
    expect(document.querySelector(".utv-card-menu [role=alert]")?.textContent).toContain(
      "Try again",
    );
    expect(menuAction("Remove favorite").disabled).toBe(false);
    menuAction("Remove favorite").click();
    await settle();
    openCardActions(native);
    expect(menuAction("Add favorite").disabled).toBe(false);
  });

  it("keeps native artwork navigation and provides details and copy-link menu actions", async () => {
    const page = markup();
    const native = card();
    const artwork = document.createElement("a");
    artwork.href = "#/details?id=m1&serverId=srv1";
    native.querySelector(".cardImageContainer")?.append(artwork);
    page.querySelector(".sections")?.append(native);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    api();
    install();
    await settle();
    expect(artwork.isConnected).toBe(true);
    expect(artwork.getAttribute("href")).toContain("id=m1");
    expect(native.querySelector(".utv-card-hover-overlay")).toBeNull();
    openCardActions(native);
    menuAction("Copy link").click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("#/details?id=m1&serverId=srv1"),
    );
    openCardActions(native);
    menuAction("Details").click();
    await settle();
    expect(location.hash).toContain("id=m1");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("hides type badges on homogeneous shelves and shows on mixed shelves", async () => {
    const page = markup();
    const section = document.createElement("div");
    section.className = "verticalSection";
    section.dataset.utvShelf = "movies";
    const h2 = document.createElement("h2");
    h2.className = "sectionTitle";
    h2.textContent = "Movies";
    section.append(h2);

    const c1 = card("m1", "Movie", "Movie 1");
    c1.querySelector(".itemProgressBar")?.remove();
    section.append(c1);
    page.querySelector(".sections")?.append(section);

    api();
    install();
    await settle();

    const pill = c1.querySelector<HTMLElement>(".utv-card-type-badge");
    expect(pill?.style.display).toBe("none");
    expect(c1.querySelector(".utv-card-hover-overlay")).toBeNull();

    const mixed = document.createElement("div");
    mixed.className = "verticalSection";
    mixed.dataset.utvShelf = "mixed";
    const h2Mixed = document.createElement("h2");
    h2Mixed.className = "sectionTitle";
    h2Mixed.textContent = "Continue Watching";
    mixed.append(h2Mixed);
    const c2 = card("m2", "Movie", "Movie 2");
    mixed.append(c2);
    page.querySelector(".sections")?.append(mixed);
    await settle();

    const pillMixed = c2.querySelector<HTMLElement>(".utv-card-type-badge");
    expect(pillMixed?.style.display).toBe("");
  });
});

describe("card action regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState(null, "", "#/home");
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = () => Promise.resolve();
      },
    );
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 500,
    } as DOMRect);
  });
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });
  it("serializes favorites across copies and leaves the confirmed state after failure", async () => {
    const page = markup();
    const first = card();
    const second = card();
    page.querySelector(".sections")?.append(first, second);
    const client = api();
    const request = deferred<void>();
    client.updateFavoriteStatus.mockImplementationOnce(() => request.promise);
    install();
    await settle();
    openCardActions(first);
    menuAction("Add favorite").click();
    openCardActions(second);
    expect(menuAction("Add favorite").disabled).toBe(true);
    menuAction("Add favorite").click();
    await settle();
    expect(client.updateFavoriteStatus).toHaveBeenCalledTimes(1);
    request.reject(new Error("offline"));
    await settle();
    openCardActions(first);
    expect(menuAction("Add favorite").disabled).toBe(false);
    menuAction("Add favorite").click();
    await settle();
    expect(client.updateFavoriteStatus).toHaveBeenCalledTimes(2);
  });
  it("does not change a recycled card when an old favorite request completes", async () => {
    const page = markup();
    const c = card();
    page.querySelector(".sections")?.append(c);
    const client = api();
    const request = deferred<void>();
    client.updateFavoriteStatus.mockImplementationOnce(() => request.promise);
    install();
    await settle();
    openCardActions(c);
    menuAction("Add favorite").click();
    await settle();
    c.dataset.id = "m2";
    await settle();
    request.resolve();
    await settle();
    expect(document.querySelector<HTMLElement>(".utv-card-menu")?.hidden).toBe(true);
    openCardActions(c);
    expect(menuAction("Add favorite").disabled).toBe(false);
    expect(c.querySelector(".utv-card-hover-overlay")).toBeNull();
    expect(c.querySelector(".cardImageContainer .utv-card-actions")).toBeNull();
  });
  it("disables favorites when the native client cannot save them", async () => {
    const page = markup();
    const c = card();
    page.querySelector(".sections")?.append(c);
    const client = api();
    Reflect.deleteProperty(client, "updateFavoriteStatus");
    install();
    await settle();
    openCardActions(c);
    expect(menuAction("Add favorite").disabled).toBe(true);
  });
  it("rejects an open menu after an account change and closes on route changes", async () => {
    const page = markup();
    const c = card();
    page.querySelector(".sections")?.append(c);
    const client = api();
    install();
    await settle();
    openCardActions(c);
    client.getCurrentUserId.mockReturnValue("u2");
    menuAction("Add favorite").click();
    await settle();
    expect(client.updateFavoriteStatus).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".utv-card-menu")?.hidden).toBe(true);
    openCardActions(c);
    navigate("#/movies");
    await settle();
    expect(document.querySelector<HTMLElement>(".utv-card-menu")?.hidden).toBe(true);
  });
  it("releases the gate for native React dashboard pages without the legacy page class", async () => {
    markup(false);
    api();
    navigate("#/dashboard/plugins");
    document.body.innerHTML +=
      '<div class="mainAnimatedPages"><div id="dashboardPage" class="mainAnimatedPage type-interior">Plugins</div></div>';
    const gate = install();
    await settle();
    expect(gate.ready).toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
  });
});
