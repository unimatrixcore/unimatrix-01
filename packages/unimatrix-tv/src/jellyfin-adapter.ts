import { z } from "zod";
import { createCardMenu } from "./card-menu.js";
import type { BootGate } from "./loading-gate.js";
import { isPlaybackRoute } from "./playback.js";
import { createSynopsisDialog } from "./synopsis-dialog.js";

const configSchema = z.object({
  enabled: z.boolean().catch(true),
  bootGate: z.boolean().catch(true),
  requestsUrl: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
    .catch("https://requests.unimatrix-01.dev/"),
  assetsBase: z
    .string()
    .refine(
      (value) =>
        value.startsWith("/") &&
        !value.startsWith("//") &&
        new URL(value, location.origin).origin === location.origin,
    )
    .catch("/UnimatrixTV/assets/"),
});

export function getClientConfig(): z.infer<typeof configSchema> {
  const value: unknown = (window as Window & { __unimatrixTVConfig?: unknown }).__unimatrixTVConfig;
  const parsed = configSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : configSchema.parse({});
}

const itemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string(),
  Type: z.string(),
  SeriesId: z.string().optional(),
  IndexNumber: z.number().optional(),
  ParentIndexNumber: z.number().optional(),
  CollectionType: z.string().optional(),
  Path: z.string().optional(),
  IsVirtualItem: z.boolean().optional(),
  Overview: z.string().optional(),
  Genres: z.array(z.string()).optional(),
  ProductionYear: z.number().optional(),
  RunTimeTicks: z.number().optional(),
  OfficialRating: z.string().optional(),
  CommunityRating: z.number().optional(),
  CriticRating: z.number().optional(),
  MediaSources: z.array(z.unknown()).optional(),
  ImageTags: z.record(z.string(), z.string()).optional(),
  BackdropImageTags: z.array(z.string()).optional(),
  ParentBackdropItemId: z.string().optional(),
  ParentBackdropImageTags: z.array(z.string()).optional(),
  UserData: z
    .object({
      PlaybackPositionTicks: z.number().optional(),
      Played: z.boolean().optional(),
      IsFavorite: z.boolean().optional(),
    })
    .optional(),
  People: z.array(z.object({ Id: z.string(), Name: z.string(), Type: z.string() })).optional(),
});

const itemsSchema = z.object({ Items: z.array(itemSchema).default([]) });
type Item = z.infer<typeof itemSchema>;
type Query = Record<string, string | number | boolean>;

interface JellyfinClient {
  getCurrentUserId(): string | undefined;
  serverId(): string;
  getItems(user: string, query: Query): Promise<unknown>;
  getItem(user: string, id: string): Promise<unknown>;
  getUserViews(query: Query, user: string): Promise<unknown>;
  getImageUrl(id: string, options: Query): string;
  updateFavoriteStatus?(user: string, id: string, favorite: boolean): Promise<unknown>;
}

const callable = <T extends (...args: never[]) => unknown>() =>
  z.custom<T>((value) => typeof value === "function");
const clientSchema = z.object({
  getCurrentUserId: callable<JellyfinClient["getCurrentUserId"]>(),
  serverId: callable<JellyfinClient["serverId"]>(),
  getItems: callable<JellyfinClient["getItems"]>(),
  getItem: callable<JellyfinClient["getItem"]>(),
  getUserViews: callable<JellyfinClient["getUserViews"]>(),
  getImageUrl: callable<JellyfinClient["getImageUrl"]>(),
  updateFavoriteStatus: callable<NonNullable<JellyfinClient["updateFavoriteStatus"]>>().optional(),
});

function client(): JellyfinClient | undefined {
  const value: unknown = (window as Window & { ApiClient?: unknown }).ApiClient;
  return clientSchema.safeParse(value).success ? (value as JellyfinClient) : undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function owned<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = element(tag, className, text);
  node.dataset.utvOwned = "true";
  return node;
}

function link(text: string, href: string, className = ""): HTMLAnchorElement {
  const node = element("a", className, text);
  node.href = href;
  return node;
}

function formatDuration(ticks?: number): string | undefined {
  if (!ticks) return undefined;
  const totalMinutes = Math.round(ticks / 600000000);
  if (totalMinutes <= 0) return undefined;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function visible(node: Element | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    !node.closest('.hide,[hidden],[aria-hidden="true"]') &&
    node.getBoundingClientRect().height > 0
  );
}

function visiblePage(selector: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll(selector)).find(visible);
}

function icon(name: "play" | "request" | "details" | "check"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");

  if (name === "play") {
    path.setAttribute("d", "M8 5v14l11-7z");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "none");
  } else if (name === "request") {
    path.setAttribute(
      "d",
      "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2M12 7v10M7 12h10",
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
  } else if (name === "check") {
    path.setAttribute("d", "M5 13l4 4L19 7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.setAttribute("d", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 10v7M12 7v1");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
  }

  svg.append(path);
  return svg;
}

function itemHref(item: Item, api: JellyfinClient): string {
  const server = api.serverId();
  return (
    "#/details?" +
    new URLSearchParams({
      id: item.Id,
      ...(server && server !== "undefined" ? { serverId: server } : {}),
    }).toString()
  );
}

function route(): { path: string; params: URLSearchParams } {
  const [path = "/home", query = ""] = location.hash.replace(/^#!?/, "").split("?");
  return { path: path || "/home", params: new URLSearchParams(query) };
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => {
          reject(new Error("Jellyfin adaptation cancelled"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          reject(new Error("Jellyfin response timed out"));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function decode(url: string, signal: AbortSignal): Promise<void> {
  const image = new Image();
  image.src = url;
  await bounded(image.decode(), signal, 8000);
}

function hasMedia(item: Item): boolean {
  return item.IsVirtualItem !== true && Boolean(item.Path || item.MediaSources?.length);
}

export function installJellyfinAdapter(gate: BootGate): () => void {
  const config = getClientConfig();
  if (!config.enabled) return () => {};
  const synopsisDialog = createSynopsisDialog();
  const ASSETS = config.assetsBase.endsWith("/") ? config.assetsBase : config.assetsBase + "/";
  const REQUESTS = config.requestsUrl;
  let disposed = false;
  let failed = false;
  let controller = new AbortController();
  const bindings = new Set<() => void>();
  function listen(
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: boolean,
  ): void {
    target.addEventListener(type, handler, options);
    bindings.add(() => {
      target.removeEventListener(type, handler, options);
    });
  }
  let generation = 0;
  let heroGeneration = 0;
  let currentHero = 0;
  let heroItems: Item[] = [];
  let homeUser = "";
  let viewUser = "";
  let imageUser = "";
  let homeWork = false;
  let viewWork = false;
  let imageWork = false;
  let detailWork = false;
  let viewRoutes: Partial<Record<"movies" | "tvshows", string>> = {};
  const images = new Map<string, Item | null>();
  const availableSeries = new Set<string>();
  const toolCleanup = new Map<HTMLDetailsElement, () => void>();
  const folderDisplays = new Map<HTMLElement, { value: string; priority: string }>();
  let observer: MutationObserver | undefined;
  let observationTarget: Element | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let started = 0;
  let settling = false;
  let adaptationReady = false;

  function stop(): void {
    observer?.disconnect();
    observer = undefined;
    observationTarget = undefined;
    clearTimeout(refreshTimer);
    clearTimeout(settleTimer);
    clearTimeout(deadline);
    settling = false;
  }

  function fail(stamp: number): void {
    if (disposed || failed || stamp !== generation) return;
    failed = true;
    stop();
    controller.abort();
    gate.fail();
  }

  function kick(): void {
    if (disposed || failed || isPlaybackRoute()) return;
    clearTimeout(refreshTimer);
    clearTimeout(settleTimer);
    refreshTimer = setTimeout(reconcile, 80);
  }

  function complete(stamp: number): void {
    if (
      stamp !== generation ||
      !settling ||
      !adaptationReady ||
      homeWork ||
      viewWork ||
      imageWork ||
      detailWork
    )
      return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(
      () => {
        if (
          stamp !== generation ||
          !settling ||
          !adaptationReady ||
          homeWork ||
          viewWork ||
          imageWork ||
          detailWork
        )
          return;
        const page = activePage();
        if (
          Array.from(
            page?.querySelectorAll('.loadingSpinner,.mdl-spinner.is-active,[aria-busy="true"]') ??
              [],
          ).some(visible)
        ) {
          kick();
          return;
        }
        clearTimeout(deadline);
        settling = false;
        gate.ready();
      },
      Math.max(500, 1000 - (Date.now() - started)),
    );
  }

  function activePage(): HTMLElement | undefined {
    const current = route();
    if (current.path === "/home" || current.path === "/") return visiblePage("#homeTab");
    if (current.path === "/details") return visiblePage("#itemDetailPage");
    if (current.path.includes("login")) return visiblePage("#loginPage");
    return visiblePage(
      ".mainAnimatedPages .page,.viewContainer .page,.page:not(.hide),.mainAnimatedPage:not(.hide)",
    );
  }

  function observe(): void {
    if (isPlaybackRoute()) {
      stop();
      gate.ready();
      return;
    }
    const page = activePage();
    const target =
      document.querySelector("#reactRoot") ??
      page?.parentElement ??
      document.querySelector(".mainAnimatedPages,.viewContainer");
    if (!target || target === observationTarget) return;
    observer?.disconnect();
    observationTarget = target;
    observer = new MutationObserver((records) => {
      if (isPlaybackRoute()) {
        stop();
        gate.ready();
        return;
      }
      const changed = records.some((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target || target.closest("[data-utv-owned]")) return false;
        if (record.type === "characterData") return true;
        if (record.type === "attributes")
          return record.oldValue !== target.getAttribute(record.attributeName ?? "");
        return Array.from(record.addedNodes)
          .concat(Array.from(record.removedNodes))
          .some(
            (node) =>
              node instanceof Element &&
              !node.matches("[data-utv-owned]") &&
              !node.closest("[data-utv-owned]"),
          );
      });
      if (changed) {
        if (settling) adaptationReady = false;
        kick();
      }
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class", "hidden", "aria-busy", "data-id", "data-type"],
      attributeOldValue: true,
    });
  }

  function begin(): void {
    if (disposed) return;
    cardMenu.close();
    failed = false;
    controller.abort();
    controller = new AbortController();
    homeWork = viewWork = imageWork = detailWork = false;
    for (const [id, item] of images) if (item === null) images.delete(id);
    generation++;
    heroGeneration++;
    if (isPlaybackRoute()) {
      stop();
      gate.ready();
      return;
    }
    stop();
    started = Date.now();
    settling = true;
    adaptationReady = false;
    gate.begin();
    document.body.classList.remove("utv-mobile-menu-open");
    const stamp = generation;
    deadline = setTimeout(() => {
      fail(stamp);
    }, 20000);
    observe();
    reconcile();
  }

  function navigation(): boolean {
    const api = client();
    const bar = document.querySelector("header.MuiAppBar-root");
    const row = bar?.querySelector<HTMLElement>(".MuiToolbar-root");
    const stack = bar?.querySelector<HTMLElement>(".MuiStack-root") ?? row;
    if (!api?.getCurrentUserId() || !row || !stack) return false;

    const movieRoute =
      stack.querySelector<HTMLAnchorElement>('a[href*="#/movies"]')?.getAttribute("href") ??
      viewRoutes.movies;
    const tvRoute =
      stack.querySelector<HTMLAnchorElement>('a[href*="#/tv"]')?.getAttribute("href") ??
      viewRoutes.tvshows;
    if (!movieRoute && !tvRoute) return false;

    if (stack === row && !row.querySelector(".utv-mobile-brand")) {
      const brand = owned("a", "utv-mobile-brand");
      brand.href = "#/home";
      const logo = element("img");
      logo.src = ASSETS + "logo.png";
      logo.alt = "";
      brand.append(logo, element("span", "", "Unimatrix-TV"));
      row.querySelector('button[aria-label="Open Menu"]')?.insertAdjacentElement("afterend", brand);
    }

    if (stack !== row) row.querySelector(".utv-mobile-brand")?.remove();
    let nav = row.querySelector<HTMLElement>(".utv-main-nav");
    if (!nav) {
      nav = owned("nav", "utv-main-nav");
      nav.id = "utv-main-navigation";
      nav.setAttribute("aria-label", "Main navigation");
    }
    if (nav.parentElement !== stack) stack.append(nav);
    row.querySelectorAll(".utv-main-nav").forEach((other) => {
      if (other !== nav) other.remove();
    });

    const entries: [string, string][] = [
      ["Home", "#/home"],
      ...(movieRoute ? [["Movies", movieRoute] as [string, string]] : []),
      ...(tvRoute ? [["Series", tvRoute] as [string, string]] : []),
      ["Favorites", "#/home?tab=1"],
      ["Search", "#/search"],
      ["Requests ↗", REQUESTS],
    ];

    const signature = JSON.stringify(entries);
    if (nav.dataset.signature !== signature) {
      nav.dataset.signature = signature;
      nav.replaceChildren(
        ...entries.map(([text, href]) => {
          const node = link(text, href, href === REQUESTS ? "utv-request-link" : "");
          if (href === REQUESTS) {
            node.target = "_blank";
            node.rel = "noopener";
            node.setAttribute("aria-label", "Open Unimatrix-TV Requests");
          }
          return node;
        }),
      );
    }

    if (!row.querySelector(".utv-header-requests")) {
      const utility = owned("a", "utv-header-requests");
      utility.href = REQUESTS;
      utility.append(icon("request"));
      utility.target = "_blank";
      utility.rel = "noopener";
      utility.title = "Requests";
      utility.setAttribute("aria-label", "Open Unimatrix-TV Requests");
      const tools = Array.from(row.children).find((node) =>
        node.querySelector('a[aria-label="Search"]'),
      );
      if (tools) row.insertBefore(utility, tools);
      else row.append(utility);
    }

    const menu = row.querySelector<HTMLButtonElement>('button[aria-label="Open Menu"]');
    if (menu && !menu.dataset.utvBound) {
      menu.dataset.utvBound = "true";
      const handler: EventListener = (event) => {
        if (!matchMedia("(max-width:600px)").matches) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const open = document.body.classList.toggle("utv-mobile-menu-open");
        menu.setAttribute("aria-expanded", String(open));
        if (open) nav?.querySelector<HTMLAnchorElement>("a")?.focus();
      };
      listen(menu, "click", handler, true);
      bindings.add(() => {
        delete menu.dataset.utvBound;
        menu.removeAttribute("aria-controls");
        menu.removeAttribute("aria-expanded");
      });
    }

    menu?.setAttribute("aria-controls", "utv-main-navigation");
    menu?.setAttribute(
      "aria-expanded",
      String(document.body.classList.contains("utv-mobile-menu-open")),
    );

    if (!nav.dataset.utvBound) {
      nav.dataset.utvBound = "true";
      listen(nav, "click", (event) => {
        if (event.target instanceof Element && event.target.closest("a")) {
          document.body.classList.remove("utv-mobile-menu-open");
          menu?.setAttribute("aria-expanded", "false");
        }
      });
    }

    const current = route();
    for (const node of Array.from(nav.querySelectorAll("a"))) {
      const href = node.getAttribute("href") ?? "";
      const active =
        href === "#/home"
          ? ["/home", "/"].includes(current.path) && current.params.get("tab") !== "1"
          : href === "#/home?tab=1"
            ? current.path === "/home" && current.params.get("tab") === "1"
            : href.startsWith("#/movies")
              ? current.path === "/movies"
              : href.startsWith("#/tv")
                ? current.path === "/tv"
                : href === "#/search" && current.path === "/search";

      if (active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    }

    return true;
  }

  async function loadRoutes(): Promise<void> {
    const api = client();
    const user = api?.getCurrentUserId();
    if (!api || !user || viewWork) return;
    const key = api.serverId() + ":" + user;
    if (key === viewUser) return;
    viewRoutes = {};
    viewWork = true;
    const stamp = generation;
    const signal = controller.signal;
    try {
      const response = itemsSchema.parse(await bounded(api.getUserViews({}, user), signal));
      if (disposed || stamp !== generation || api.getCurrentUserId() !== user) return;
      viewRoutes = {};
      for (const item of response.Items) {
        if (item.CollectionType === "movies" || item.CollectionType === "tvshows") {
          viewRoutes[item.CollectionType] =
            "#/" +
            (item.CollectionType === "movies" ? "movies" : "tv") +
            "?" +
            new URLSearchParams({
              topParentId: item.Id,
              collectionType: item.CollectionType,
            }).toString();
        }
      }
      viewUser = key;
    } catch {
      if (!disposed && stamp === generation && api.getCurrentUserId() === user) viewUser = key;
    } finally {
      if (stamp === generation) viewWork = false;
      kick();
    }
  }

  function shortcuts(): void {
    const nav = visiblePage("#homeTab")?.querySelector(".utv-library-shortcuts");
    const header = document.querySelector("header.MuiAppBar-root");
    if (!nav || !header) return;

    const entries: [string, string][] = [];
    const targets = [
      ['a[href*="#/movies"]', "Movies"],
      ['a[href*="#/tv"]', "Series"],
      ['a[href*="tab=1"]', "Favorites"],
      ['a[href*="#/search"]', "Search"],
    ] as const;

    for (const [selector, name] of targets) {
      const node = header.querySelector(selector);
      if (node instanceof HTMLAnchorElement) entries.push([name, node.href]);
    }

    const current = Array.from(nav.querySelectorAll("a")).map((node) => [
      node.textContent,
      node.href,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(entries)) {
      nav.replaceChildren(...entries.map(([text, href]) => link(text, href)));
    }
  }

  function login(): boolean {
    const page = visiblePage("#loginPage");
    if (!page) return false;
    const heading = page.querySelector(".manualLoginForm h1");
    if (heading && heading.textContent !== "Sign in") heading.textContent = "Sign in";

    const disclaimer = page.querySelector<HTMLElement>(".loginDisclaimer");
    if (disclaimer && !disclaimer.dataset.utvSimple) {
      disclaimer.dataset.utvSimple = "true";
      disclaimer.replaceChildren(link("Unimatrix-TV Requests ↗", REQUESTS));
    }

    if (!page.querySelector("#utv-login-scene")) {
      const aside = owned("aside");
      aside.id = "utv-login-scene";
      const logo = element("img");
      logo.src = ASSETS + "logo.png";
      logo.alt = "Unimatrix-TV";
      aside.append(logo, element("h2", "", "Unimatrix-TV"));
      page.prepend(aside);
    }

    return Boolean(page.querySelector("form,input"));
  }

  function nativePlay(item: Item): HTMLElement | undefined {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.card[data-id="' +
          CSS.escape(item.Id) +
          '"] [data-action="resume"],.card[data-id="' +
          CSS.escape(item.Id) +
          '"] [data-action="play"]',
      ),
    ).find((node) => !node.closest(".hide,[hidden]"));
  }

  function isPartiallyPlayed(item: Item, card?: HTMLElement | null): boolean {
    if (item.UserData?.PlaybackPositionTicks && item.UserData.PlaybackPositionTicks > 0)
      return true;
    if (card?.querySelector(".itemProgressBar")) return true;
    return false;
  }

  async function renderHero(shell: HTMLElement, api: JellyfinClient, stamp: number): Promise<void> {
    const item = heroItems[currentHero];
    if (!item) return;

    const rendering = ++heroGeneration;
    const user = api.getCurrentUserId();
    const focusedNode = shell.contains(document.activeElement) ? document.activeElement : null;
    const focused = focusedNode?.getAttribute("aria-label");
    const signal = controller.signal;
    const previous = shell.querySelector(".utv-featured-art.is-loaded");

    const art = element("div", "utv-featured-art");
    const copy = element("div", "utv-featured-copy");
    const heading = element("h1", "", item.Name);
    copy.append(heading);

    if (item.ImageTags?.Logo) {
      const logo = element("img", "utv-title-logo");
      logo.alt = "";
      logo.src = api.getImageUrl(item.Id, {
        type: "Logo",
        maxWidth: 700,
        tag: item.ImageTags.Logo,
      });
      logo.addEventListener(
        "load",
        () => {
          heading.classList.add("utv-visually-hidden");
          logo.classList.add("is-loaded");
        },
        { once: true },
      );
      copy.prepend(logo);
    }

    const meta = element("div", "utv-meta");
    if (item.ProductionYear) {
      meta.append(element("span", "utv-meta-item", String(item.ProductionYear)));
    }
    const duration = formatDuration(item.RunTimeTicks);
    if (item.Type === "Series") {
      meta.append(element("span", "utv-meta-item", "Series"));
    } else if (duration) {
      meta.append(element("span", "utv-meta-item", duration));
    }
    if (item.Genres?.[0]) {
      meta.append(element("span", "utv-meta-item", item.Genres[0]));
    }
    if (typeof item.CommunityRating === "number" && item.CommunityRating > 0) {
      const star = element("span", "utv-meta-item utv-star-rating");
      const iconSpan = element("span", "starIcon", "★");
      star.append(iconSpan, document.createTextNode(" " + item.CommunityRating.toFixed(1)));
      meta.append(star);
    }
    if (item.OfficialRating) {
      meta.append(element("span", "utv-rating-badge mediaInfoOfficialRating", item.OfficialRating));
    }
    copy.append(meta);

    if (item.Overview) copy.append(element("p", "utv-summary", item.Overview));

    const actions = element("div", "utv-actions");
    const play = element("button", "utv-action");
    const native = nativePlay(item);
    play.type = "button";
    play.dataset.utvFeaturedAction = "true";
    play.append(
      icon(native ? "play" : "details"),
      element(
        "span",
        "",
        native
          ? isPartiallyPlayed(item, native.closest(".card"))
            ? "Resume"
            : "Play"
          : "View title",
      ),
    );
    play.addEventListener("click", () => {
      const action = nativePlay(item);
      if (action) action.click();
      else location.hash = itemHref(item, api).slice(1);
    });
    actions.append(play);

    if (native) actions.append(link("Details", itemHref(item, api), "utv-action secondary"));
    copy.append(actions);

    const bottom = element("div", "utv-featured-bottom");
    const controls = element("div", "utv-featured-controls");
    const dots = element("div", "utv-featured-tabs");
    dots.setAttribute("role", "group");
    dots.setAttribute("aria-label", "Featured titles");

    function choose(index: number): void {
      currentHero = (index + heroItems.length) % heroItems.length;
      const nextStamp = generation;
      void renderHero(shell, api, nextStamp).catch(() => {
        fail(nextStamp);
      });
    }

    if (heroItems.length > 1) {
      for (const [text, step, label] of [
        ["‹", -1, "Previous featured title"],
        ["›", 1, "Next featured title"],
      ] as const) {
        const button = element("button", "", text);
        button.type = "button";
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => {
          choose(currentHero + step);
        });
        controls.append(button);
      }
      heroItems.forEach((title, index) => {
        const dot = element("button");
        dot.type = "button";
        dot.setAttribute("aria-label", title.Name);
        dot.setAttribute("aria-pressed", String(index === currentHero));
        dot.addEventListener("click", () => {
          choose(index);
        });
        dot.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          choose(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? heroItems.length - 1
                : currentHero + (event.key === "ArrowRight" ? 1 : -1),
          );
        });
        dots.append(dot);
      });
    }

    const hit = link("", itemHref(item, api), "utv-featured-hit");
    hit.setAttribute("aria-label", "View " + item.Name);
    hit.addEventListener("click", (event) => {
      if (Number(shell.dataset.utvSwipedUntil ?? 0) > Date.now()) event.preventDefault();
    });

    bottom.append(dots, controls);
    delete shell.dataset.ready;
    shell.replaceChildren(...(previous ? [previous] : []), art, hit, copy, bottom);
    if (focused)
      Array.from(shell.querySelectorAll("button"))
        .find((button) => button.getAttribute("aria-label") === focused)
        ?.focus({ preventScroll: true });

    const imageId = item.BackdropImageTags?.length ? item.Id : item.ParentBackdropItemId;
    const tag = item.BackdropImageTags?.[0] ?? item.ParentBackdropImageTags?.[0];
    if (imageId) {
      const url = api.getImageUrl(imageId, {
        type: "Backdrop",
        index: 0,
        maxWidth: 1920,
        quality: 90,
        ...(tag ? { tag } : {}),
      });
      try {
        await decode(url, signal);
        art.style.backgroundImage = "url(" + JSON.stringify(url) + ")";
      } catch {
        // Artwork is optional: title details and playback remain usable.
      }
    }

    if (
      disposed ||
      rendering !== heroGeneration ||
      stamp !== generation ||
      !shell.isConnected ||
      api.getCurrentUserId() !== user
    )
      return;
    art.classList.add("is-loaded");
    shell.dataset.ready = "true";
    adaptationReady = true;
    previous?.remove();
    complete(stamp);
  }

  async function home(): Promise<void> {
    const page = visiblePage("#homeTab");
    const sections = page?.querySelector<HTMLElement>(".homeSectionsContainer,.sections");
    const api = client();
    const user = api?.getCurrentUserId();
    if (!page || !sections || !api || !user || homeWork) return;

    const existing = sections.querySelector<HTMLElement>("#utv-featured,#utv-empty");
    if (existing && homeUser === api.serverId() + ":" + user) {
      const item = heroItems[currentHero];
      const play = existing.querySelector("[data-utv-featured-action]");
      if (item && play) {
        const native = nativePlay(item);
        const text = native
          ? isPartiallyPlayed(item, native.closest(".card"))
            ? "Resume"
            : "Play"
          : "View title";
        if (play.textContent !== text)
          play.replaceChildren(icon(native ? "play" : "details"), element("span", "", text));
      }
      adaptationReady = existing.id === "utv-empty" || existing.dataset.ready === "true";
      if (!adaptationReady && !homeWork) {
        homeWork = true;
        const stamp = generation;
        void renderHero(existing, api, stamp)
          .catch(() => {
            fail(stamp);
          })
          .finally(() => {
            if (stamp === generation) homeWork = false;
            kick();
          });
      }
      return;
    }

    homeWork = true;
    const stamp = generation;
    const signal = controller.signal;
    try {
      const available = await bounded(
        (async () => {
          const response = itemsSchema.parse(
            await api.getItems(user, {
              Recursive: true,
              IncludeItemTypes: "Movie,Series",
              IsVirtualItem: false,
              Limit: 12,
              SortBy: "DateCreated",
              SortOrder: "Descending",
              Fields:
                "Overview,Genres,PrimaryImageAspectRatio,ParentId,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,CriticRating,MediaSources,RecursiveItemCount",
              EnableImageTypes: "Primary,Backdrop,Logo",
              ImageTypeLimit: 1,
            }),
          );

          const candidates = response.Items.filter(
            (item) =>
              item.IsVirtualItem !== true &&
              (item.Type === "Series" || (item.Type === "Movie" && hasMedia(item))),
          );
          return Promise.all(
            candidates.map(async (item) => {
              if (item.Type !== "Series") return item;
              try {
                const eps = itemsSchema.parse(
                  await api.getItems(user, {
                    ParentId: item.Id,
                    Recursive: true,
                    IncludeItemTypes: "Episode",
                    IsVirtualItem: false,
                    Limit: 1,
                    Fields: "MediaSources,Path",
                  }),
                );
                const exists = eps.Items.some(hasMedia);
                if (stamp === generation && exists) availableSeries.add(item.Id);
                return exists ? item : null;
              } catch {
                return null;
              }
            }),
          );
        })(),
        signal,
      );

      if (disposed || stamp !== generation || !visible(page) || api.getCurrentUserId() !== user)
        return;
      heroItems = available.filter((item): item is Item => item !== null).slice(0, 8);
      currentHero = 0;
      homeUser = api.serverId() + ":" + user;

      sections
        .querySelectorAll(
          "#utv-featured,#utv-empty,.utv-library-shortcuts,.utv-theme-footer,#utv-home-loading",
        )
        .forEach((node) => {
          node.remove();
        });

      const shell = owned("section");
      shell.id = heroItems.length ? "utv-featured" : "utv-empty";
      shell.setAttribute(
        "aria-label",
        heroItems.length ? "Featured available title" : "Your library",
      );
      sections.prepend(shell);

      let touch: { x: number; y: number } | undefined;
      shell.addEventListener("pointerdown", (event) => {
        if (
          event.pointerType === "touch" &&
          event.target instanceof Element &&
          !event.target.closest("button,a:not(.utv-featured-hit)")
        ) {
          touch = { x: event.clientX, y: event.clientY };
        }
      });
      shell.addEventListener("pointerup", (event) => {
        if (!touch) return;
        const dx = event.clientX - touch.x;
        const dy = event.clientY - touch.y;
        touch = undefined;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && heroItems.length > 1) {
          shell.dataset.utvSwipedUntil = String(Date.now() + 600);
          currentHero = (currentHero + (dx < 0 ? 1 : -1) + heroItems.length) % heroItems.length;
          const nextStamp = generation;
          void renderHero(shell, api, nextStamp).catch(() => {
            fail(nextStamp);
          });
        }
      });
      shell.addEventListener("pointercancel", () => {
        touch = undefined;
      });

      if (heroItems.length) {
        await renderHero(shell, api, stamp);
      } else {
        shell.append(element("h1", "", "No available titles"));
        const requests = link("Requests ↗", REQUESTS, "utv-action");
        requests.target = "_blank";
        requests.rel = "noopener";
        shell.append(requests);
        adaptationReady = true;
      }

      if (disposed || stamp !== generation || !shell.isConnected) return;
      const nav = owned("nav", "utv-library-shortcuts");
      nav.setAttribute("aria-label", "Browse your library");
      shell.insertAdjacentElement("afterend", nav);
      shortcuts();
    } catch {
      fail(stamp);
    } finally {
      if (stamp === generation) homeWork = false;
      kick();
    }
  }

  const favoritePending = new Set<string>();
  const cardMenu = createCardMenu();

  function openCardMenu(card: HTMLElement, trigger: HTMLButtonElement): void {
    const api = client();
    const user = api?.getCurrentUserId();
    const id = card.dataset.id;
    const type = card.dataset.type;
    if (!api || !user || !id) return;
    const identity = api.serverId() + ":" + user;
    const item = imageUser === identity ? images.get(id) : undefined;
    const key = identity + ":" + id;
    const stamp = generation;
    const valid = () =>
      !disposed &&
      stamp === generation &&
      card.isConnected &&
      card.dataset.id === id &&
      card.dataset.type === type &&
      client()?.serverId() + ":" + client()?.getCurrentUserId() === identity;
    const target = item ?? { Id: id, Name: "", Type: type ?? "Movie" };
    const href = itemHref(target, api);
    const detailsTarget =
      item?.Type === "Episode" && item.SeriesId
        ? itemHref({ ...item, Id: item.SeriesId, Type: "Series" }, api)
        : href;
    cardMenu.open(trigger, {
      label:
        (item?.Name || card.querySelector(".cardText-first")?.textContent?.trim() || "Title") +
        " actions",
      valid,
      actions: [
        {
          label:
            item?.Type === "Series" || (item?.Type === "Episode" && item.SeriesId)
              ? "Go to Show"
              : "Details",
          run: () => {
            location.hash = detailsTarget.slice(1);
          },
        },
        {
          label: item?.UserData?.IsFavorite ? "Remove favorite" : "Add favorite",
          disabled: !item || !api.updateFavoriteStatus || favoritePending.has(key),
          run: async () => {
            if (!valid() || !item || !api.updateFavoriteStatus || favoritePending.has(key)) return;
            const nextFavorite = !item.UserData?.IsFavorite;
            favoritePending.add(key);
            try {
              await api.updateFavoriteStatus(user, id, nextFavorite);
              if (
                client()?.serverId() + ":" + client()?.getCurrentUserId() === identity &&
                images.get(id) === item
              ) {
                (item.UserData ??= {}).IsFavorite = nextFavorite;
              }
            } finally {
              favoritePending.delete(key);
              if (!disposed) decorateAllCards();
            }
          },
        },
        {
          label: "Copy link",
          disabled: typeof navigator.clipboard?.writeText !== "function",
          run: async () => {
            await navigator.clipboard.writeText(new URL(href, location.href).href);
          },
        },
      ],
    });
  }

  function decorateCard(card: HTMLElement, item?: Item | null): void {
    const container = card.querySelector<HTMLElement>(".cardImageContainer");
    if (!container) return;

    const presentation =
      card.querySelector<HTMLElement>(".cardScalable") ?? container.parentElement ?? container;
    const rawType = item?.Type ?? card.dataset.type ?? "";
    if (!["Movie", "Series", "Episode"].includes(rawType)) {
      if (presentation.querySelector('.utv-card-menu-trigger[aria-expanded="true"]'))
        cardMenu.close();
      presentation.querySelectorAll(".utv-card-badges,.utv-card-menu-trigger").forEach((node) => {
        node.remove();
      });
      return;
    }

    let badges = presentation.querySelector<HTMLElement>(".utv-card-badges");
    if (!badges) {
      badges = element("div", "utv-card-badges");
      badges.dataset.utvOwned = "true";
      badges.append(element("span", "utv-card-type-badge"));
      presentation.append(badges);
    }
    let trigger = presentation.querySelector<HTMLButtonElement>(".utv-card-menu-trigger");
    if (!trigger) {
      trigger = element("button", "utv-card-menu-trigger", "•••");
      trigger.type = "button";
      trigger.dataset.utvOwned = "true";
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      const button = trigger;
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCardMenu(card, button);
      });
      presentation.append(trigger);
    }
    const targetKey =
      client()?.serverId() +
      ":" +
      client()?.getCurrentUserId() +
      ":" +
      card.dataset.id +
      ":" +
      rawType;
    if (trigger.dataset.utvMenuTarget !== targetKey) {
      if (trigger.getAttribute("aria-expanded") === "true") cardMenu.close();
      trigger.dataset.utvMenuTarget = targetKey;
    }
    const menuLabel =
      "More options for " +
      (item?.Name || card.querySelector(".cardText-first")?.textContent?.trim() || "title");
    if (trigger.getAttribute("aria-label") !== menuLabel)
      trigger.setAttribute("aria-label", menuLabel);

    // Check if section is homogeneous (only movies or only series)
    const section = card.closest<HTMLElement>(".verticalSection");
    const shelf = section?.dataset.utvShelf;
    const heading = section?.querySelector("h2.sectionTitle")?.textContent?.trim();
    const isMoviesSection =
      shelf === "movies" ||
      /movies?|films?/i.test(heading ?? "") ||
      document.body.classList.contains("type-movies") ||
      location.hash.includes("type=movies") ||
      card.closest("#moviesPage") !== null;
    const isSeriesSection =
      shelf === "series" ||
      /series|tv\s*shows?|shows?/i.test(heading ?? "") ||
      document.body.classList.contains("type-tvshows") ||
      location.hash.includes("type=tvshows") ||
      card.closest("#tvPage") !== null;
    const isHomogeneous = isMoviesSection || isSeriesSection;

    const pill = badges.querySelector<HTMLElement>(".utv-card-type-badge");
    if (pill) {
      if (isHomogeneous) {
        pill.style.display = "none";
      } else {
        pill.style.display = "";
        if (rawType === "Movie") {
          pill.textContent = "MOVIE";
          pill.className = "utv-card-type-badge utv-badge-movie";
        } else if (rawType === "Series") {
          pill.textContent = "SERIES";
          pill.className = "utv-card-type-badge utv-badge-series";
        } else {
          pill.textContent = "EPISODE";
          pill.className = "utv-card-type-badge utv-badge-episode";
        }
      }
    }
  }

  function decorateAllCards(): void {
    for (const card of Array.from(document.querySelectorAll<HTMLElement>(".card[data-id]"))) {
      const type = card.dataset.type;
      if (!type || !["Movie", "Series", "Episode"].includes(type)) {
        decorateCard(card);
        continue;
      }
      const id = card.dataset.id;
      const item = id ? images.get(id) : undefined;
      decorateCard(card, item);
    }
  }

  function shelves(): void {
    const page = activePage();
    const api = client();
    const user = api?.getCurrentUserId();
    if (!page || !api || !user) return;

    const key = api.serverId() + ":" + user;
    if (key !== imageUser) {
      cardMenu.close();
      imageUser = key;
      images.clear();
      availableSeries.clear();
    }

    for (const section of Array.from(page.querySelectorAll<HTMLElement>(".verticalSection"))) {
      // Hard guarantee: Never show generic "My Media" folder cards
      if (section.querySelector('.card[data-type="CollectionFolder"]')) {
        if (!folderDisplays.has(section))
          folderDisplays.set(section, {
            value: section.style.getPropertyValue("display"),
            priority: section.style.getPropertyPriority("display"),
          });
        section.style.setProperty("display", "none", "important");
        continue;
      }
      const heading = section.querySelector("h2.sectionTitle");
      const text = heading?.textContent?.trim();
      if (!heading) continue;
      if (text === "Continue Watching") section.dataset.utvShelf = "continue";
      if (text === "Recently Added in Movies" || section.dataset.utvShelf === "movies") {
        section.dataset.utvShelf = "movies";
        if (heading.textContent !== "Movies") heading.textContent = "Movies";
      }
      if (text === "Recently Added in TV Shows" || section.dataset.utvShelf === "series") {
        section.dataset.utvShelf = "series";
        if (heading.textContent !== "Series") heading.textContent = "Series";
      }
    }

    const cards = Array.from(page.querySelectorAll<HTMLElement>(".card[data-id]")).filter((card) =>
      ["Movie", "Series", "Episode"].includes(card.dataset.type ?? ""),
    );
    const missing = new Set<string>();

    for (const card of cards) {
      if (card.dataset.type === "Episode" && card.classList.contains("overflowPortraitCard")) {
        card.classList.replace("overflowPortraitCard", "overflowBackdropCard");
        card
          .querySelector(".cardPadder")
          ?.classList.replace("cardPadder-overflowPortrait", "cardPadder-overflowBackdrop");
      }
      const id = card.dataset.id;
      const item = id ? images.get(id) : undefined;
      decorateCard(card, item);

      if (id && !images.has(id)) {
        missing.add(id);
      }
    }

    if (!missing.size || imageWork) return;
    imageWork = true;
    const stamp = generation;
    const signal = controller.signal;

    void bounded(
      api.getItems(user, {
        Ids: Array.from(missing).join(","),
        Fields:
          "Overview,ProductionYear,OfficialRating,CommunityRating,CriticRating,RunTimeTicks,Genres,MediaSources,Path",
        EnableImageTypes: "Primary,Thumb,Backdrop",
        ImageTypeLimit: 1,
      }),
      signal,
    )
      .then(async (raw) => {
        if (api.getCurrentUserId() !== user || stamp !== generation) return;
        const response = itemsSchema.parse(raw);
        await bounded(
          Promise.all(
            response.Items.filter(
              (item) => item.Type === "Series" && !availableSeries.has(item.Id),
            ).map(async (item) => {
              try {
                const episodes = itemsSchema.parse(
                  await api.getItems(user, {
                    ParentId: item.Id,
                    Recursive: true,
                    IncludeItemTypes: "Episode",
                    IsVirtualItem: false,
                    Limit: 1,
                    Fields: "MediaSources,Path",
                  }),
                );
                if (stamp === generation && episodes.Items.some(hasMedia))
                  availableSeries.add(item.Id);
              } catch {
                /* An unverified series receives no Available badge. */
              }
            }),
          ),
          signal,
        );
        if (disposed || stamp !== generation || api.getCurrentUserId() !== user) return;
        for (const id of missing) {
          images.set(id, response.Items.find((item) => item.Id === id) ?? null);
        }
        for (const card of cards) {
          const item = images.get(card.dataset.id ?? "");
          decorateCard(card, item);
        }
      })
      .catch(() => {
        if (stamp === generation) {
          for (const id of missing) images.set(id, null);
        }
      })
      .finally(() => {
        if (stamp === generation) imageWork = false;
        kick();
      });
  }

  function clearDetail(page: HTMLElement): void {
    synopsisDialog.close();
    page.querySelector(".utv-synopsis-trigger")?.remove();
    page.classList.remove("utv-detail-ready", "utv-series-ready");
    delete page.dataset.utvDetailId;
    delete page.dataset.utvDetailExcluded;
    delete page.dataset.utvDetailUser;
    page
      .querySelectorAll(
        ":scope>.utv-detail-art,:scope>.utv-detail-genres,:scope>.utv-detail-personnel,:scope>.utv-series-shelf",
      )
      .forEach((node) => {
        node.remove();
      });
    const tools = page.querySelector<HTMLDetailsElement>(".utv-detail-tools");
    if (!tools) return;
    const parent = tools.parentElement;
    if (parent) {
      for (const button of Array.from(tools.querySelectorAll("button")))
        parent.insertBefore(button, tools);
    }
    toolCleanup.get(tools)?.();
    toolCleanup.delete(tools);
    tools.remove();
  }

  async function seriesShelf(
    page: HTMLElement,
    item: Item,
    api: JellyfinClient,
    signal: AbortSignal,
    stamp: number,
  ): Promise<void> {
    if (item.Type !== "Series" && item.Type !== "Season") return;
    const seriesId = item.Type === "Series" ? item.Id : item.SeriesId;
    const user = api.getCurrentUserId();
    if (!seriesId || !user) return;
    try {
      const data = itemsSchema.parse(
        await bounded(
          api.getItems(user, {
            ParentId: seriesId,
            Recursive: true,
            IncludeItemTypes: "Episode",
            IsMissing: false,
            Fields: "Overview,RunTimeTicks,Path,MediaSources",
            EnableUserData: true,
            SortBy: "ParentIndexNumber,IndexNumber",
            SortOrder: "Ascending",
            Limit: 1000,
          }),
          signal,
        ),
      );
      const episodes = data.Items.filter(hasMedia);
      if (
        !episodes.length ||
        disposed ||
        stamp !== generation ||
        signal.aborted ||
        api.getCurrentUserId() !== user
      )
        return;
      const seasons = [...new Set(episodes.map((e) => e.ParentIndexNumber ?? 0))].sort(
        (a, b) => a - b,
      );
      const section = owned("section", "utv-series-shelf");
      section.setAttribute("aria-label", "Episodes");
      const heading = element("div", "utv-series-heading");
      const label = element("label", "", "Season");
      const select = element("select");
      select.setAttribute("aria-label", "Season");
      for (const number of seasons) {
        const option = element("option", "", number === 0 ? "Specials" : `Season ${number}`);
        option.value = String(number);
        select.append(option);
      }
      const seasonKey = `utv:season:${api.serverId()}:${user}:${seriesId}`;
      let rememberedSeason: number | undefined;
      try {
        const saved = sessionStorage.getItem(seasonKey);
        if (saved !== null && seasons.includes(Number(saved))) rememberedSeason = Number(saved);
      } catch {
        // The selector still works when browser storage is unavailable.
      }
      select.value = String(
        item.Type === "Season" && seasons.includes(item.IndexNumber ?? -1)
          ? item.IndexNumber
          : (rememberedSeason ?? seasons.find((n) => n > 0) ?? seasons[0]),
      );
      label.append(select);
      const count = element("span", "utv-series-count");
      const controls = element("div", "utv-series-controls");
      const rail = element("div", "utv-episode-rail");
      rail.setAttribute("role", "list");
      const pageButtons: HTMLButtonElement[] = [];
      const updateControls = (): void => {
        const maximum = Math.max(0, rail.scrollWidth - rail.clientWidth);
        pageButtons[0]!.disabled = rail.scrollLeft <= 1;
        pageButtons[1]!.disabled = rail.scrollLeft >= maximum - 1;
      };
      rail.addEventListener("scroll", updateControls, { passive: true, signal });
      window.addEventListener("resize", updateControls, { passive: true, signal });
      for (const [name, direction] of [
        ["Previous episodes", -1],
        ["Next episodes", 1],
      ] as const) {
        const button = element("button", "", direction < 0 ? "‹" : "›");
        button.type = "button";
        button.setAttribute("aria-label", name);
        button.addEventListener("click", () => {
          rail.scrollBy({
            left: rail.clientWidth * direction,
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
          });
        });
        pageButtons.push(button);
        controls.append(button);
      }
      const render = (): void => {
        const selected = episodes.filter(
          (e) =>
            e.ParentIndexNumber === Number(select.value) ||
            (e.ParentIndexNumber == null && select.value === "0"),
        );
        count.textContent = `${selected.length} episode${selected.length === 1 ? "" : "s"}`;
        rail.replaceChildren();
        rail.scrollLeft = 0;
        for (const episode of selected) {
          const card = element("article", "utv-episode-card");
          card.setAttribute("role", "listitem");
          const content = link("", itemHref(episode, api), "utv-episode-link");
          content.setAttribute(
            "aria-label",
            `Episode ${episode.IndexNumber ?? ""}: ${episode.Name}`,
          );
          const art = element("div", "utv-episode-art");
          const image = element("img");
          image.loading = "lazy";
          image.alt = "";
          image.src = api.getImageUrl(episode.Id, { type: "Primary", maxWidth: 640, quality: 90 });
          art.append(image);
          const progress = episode.UserData?.PlaybackPositionTicks;
          if (episode.RunTimeTicks && progress && progress > 0) {
            const track = element("div", "utv-episode-progress");
            const fill = element("span");
            fill.style.width = Math.min(100, (100 * progress) / episode.RunTimeTicks) + "%";
            track.append(fill);
            art.append(track);
          }
          const number = element(
            "div",
            "utv-episode-number",
            `EPISODE ${episode.IndexNumber ?? ""}` + (episode.UserData?.Played ? " · WATCHED" : ""),
          );
          const title = element("span", "utv-episode-title", episode.Name);
          const overview = element("p", "utv-episode-description", episode.Overview || "");
          const runtime = element(
            "span",
            "utv-episode-runtime",
            formatDuration(episode.RunTimeTicks) || "",
          );
          content.append(art, number, title, overview, runtime);
          const more = element("button", "utv-episode-more", "⋯");
          more.type = "button";
          more.setAttribute(
            "aria-label",
            `More for episode ${episode.IndexNumber ?? ""}: ${episode.Name}`,
          );
          more.setAttribute("aria-haspopup", "menu");
          more.addEventListener("click", () => {
            const valid = () =>
              !disposed &&
              stamp === generation &&
              card.isConnected &&
              client()?.getCurrentUserId() === user &&
              client()?.serverId() === api.serverId();
            cardMenu.open(more, {
              label: episode.Name + " actions",
              valid,
              actions: [
                {
                  label: "Go to Episode",
                  run: () => {
                    location.hash = itemHref(episode, api).slice(1);
                  },
                },
                {
                  label: "Go to Show",
                  run: () => {
                    location.hash = itemHref({ ...item, Id: seriesId, Type: "Series" }, api).slice(
                      1,
                    );
                  },
                },
                {
                  label: "Copy Link",
                  run: () =>
                    navigator.clipboard.writeText(
                      new URL(itemHref(episode, api), location.href).href,
                    ),
                },
              ],
            });
          });
          card.append(content, more);
          rail.append(card);
        }
        updateControls();
      };
      select.addEventListener("change", () => {
        try {
          sessionStorage.setItem(seasonKey, select.value);
        } catch {
          // Changing seasons does not depend on browser storage.
        }
        render();
      });
      heading.append(label, count, controls);
      section.append(heading, rail);
      render();
      page.append(section);
      requestAnimationFrame(() => {
        if (section.isConnected && !signal.aborted) updateControls();
      });
      page.classList.add("utv-series-ready");
    } catch {
      // Keep native season navigation available when episode metadata cannot be loaded.
    }
  }

  async function detail(): Promise<void> {
    const page = visiblePage("#itemDetailPage");
    const api = client();
    const id = route().params.get("id");
    const user = api?.getCurrentUserId();
    if (!page || !api || !id || !user || detailWork) return;
    if (!page.querySelector(".detailPagePrimaryContainer")) return;
    if (
      page.dataset.utvDetailUser === api.serverId() + ":" + user &&
      (page.dataset.utvDetailId === id || page.dataset.utvDetailExcluded === id)
    ) {
      adaptationReady = true;
      return;
    }

    detailWork = true;
    const stamp = generation;
    const signal = controller.signal;
    try {
      const item = itemSchema.parse(await bounded(api.getItem(user, id), signal));
      if (
        disposed ||
        stamp !== generation ||
        !visible(page) ||
        route().params.get("id") !== id ||
        api.getCurrentUserId() !== user
      )
        return;
      if (!["Movie", "Series", "Season", "Episode"].includes(item.Type)) {
        clearDetail(page);
        page.dataset.utvDetailExcluded = id;
        page.dataset.utvDetailUser = api.serverId() + ":" + user;
        adaptationReady = true;
        return;
      }

      clearDetail(page);
      const art = owned("div", "utv-detail-art");
      art.setAttribute("aria-hidden", "true");
      const imageId = item.BackdropImageTags?.length ? id : item.ParentBackdropItemId;
      const tag = item.BackdropImageTags?.[0] ?? item.ParentBackdropImageTags?.[0];
      if (imageId) {
        const url = api.getImageUrl(imageId, {
          type: "Backdrop",
          index: 0,
          maxWidth: 1920,
          quality: 90,
          ...(tag ? { tag } : {}),
        });
        try {
          await decode(url, signal);
          art.style.backgroundImage = "url(" + JSON.stringify(url) + ")";
        } catch {
          // Missing optional artwork must not hide the native detail page.
        }
      }

      if (disposed || stamp !== generation || !visible(page) || route().params.get("id") !== id)
        return;

      const genres = owned("div", "utv-detail-genres");
      const brand = element("img");
      brand.src = ASSETS + "logo.png";
      brand.alt = "";
      genres.append(
        brand,
        element(
          "span",
          "",
          [item.Type === "Movie" ? "Movie" : item.Type, ...(item.Genres ?? []).slice(0, 2)].join(
            " · ",
          ),
        ),
      );

      const personnel = owned("div", "utv-detail-personnel");
      for (const [label, type, limit] of [
        ["Starring", "Actor", 3],
        ["Director", "Director", 1],
      ] as const) {
        const people = (item.People ?? []).filter((person) => person.Type === type).slice(0, limit);
        if (!people.length) continue;
        const line = element("div");
        line.append(element("span", "", label));
        people.forEach((person, index) => {
          if (index) line.append(document.createTextNode(", "));
          line.append(link(person.Name, itemHref({ ...item, Id: person.Id }, api)));
        });
        personnel.append(line);
      }

      const buttons = page.querySelector<HTMLElement>(".mainDetailButtons");
      if (buttons && !buttons.querySelector(".utv-detail-tools")) {
        const tools = owned("details", "utv-detail-tools");
        const trigger = element("summary");
        const menu = element("div");
        trigger.setAttribute("aria-label", "More actions");
        trigger.title = "More actions";
        trigger.innerHTML =
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
        for (const button of Array.from(buttons.children)) {
          if (button instanceof HTMLButtonElement && !button.matches(".btnPlay,.btnUserRating"))
            menu.append(button);
        }
        tools.append(trigger, menu);
        tools.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            tools.open = false;
            trigger.focus();
          }
        });
        menu.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest("button")) tools.open = false;
        });
        const outside = (event: PointerEvent): void => {
          if (tools.open && event.target instanceof Node && !tools.contains(event.target))
            tools.open = false;
        };
        document.addEventListener("pointerdown", outside);
        toolCleanup.set(tools, () => {
          document.removeEventListener("pointerdown", outside);
        });
        buttons.append(tools);
      }

      const overviewControls = page.querySelector<HTMLElement>(".overview-controls");
      if (overviewControls && item.Overview) {
        const more = owned("button", "utv-synopsis-trigger", "MORE");
        more.type = "button";
        more.setAttribute("aria-label", "Read full synopsis");
        more.setAttribute("aria-haspopup", "dialog");
        const identity = api.serverId() + ":" + user;
        more.addEventListener("click", () => {
          if (
            disposed ||
            !more.isConnected ||
            client()?.serverId() + ":" + client()?.getCurrentUserId() !== identity
          )
            return;
          synopsisDialog.open(more, { title: item.Name, text: item.Overview ?? "" });
        });
        overviewControls.append(more);
      }
      page.prepend(art, genres, personnel);
      page.dataset.utvDetailId = id;
      page.dataset.utvDetailUser = api.serverId() + ":" + user;
      page.classList.add("utv-detail-ready");
      await seriesShelf(page, item, api, signal, stamp);
      adaptationReady = true;
    } catch {
      fail(stamp);
    } finally {
      if (stamp === generation) detailWork = false;
      kick();
    }
  }

  function nativeLinks(): void {
    const server = client()?.serverId();
    if (!server || server === "undefined") return;
    for (const card of Array.from(document.querySelectorAll<HTMLElement>(".card"))) {
      const id =
        card.dataset.serverid && card.dataset.serverid !== "undefined"
          ? card.dataset.serverid
          : server;
      for (const node of Array.from(
        card.querySelectorAll<HTMLAnchorElement>('a[href*="serverId=undefined"]'),
      )) {
        const href = node.getAttribute("href");
        if (href)
          node.setAttribute(
            "href",
            href.replace("serverId=undefined", "serverId=" + encodeURIComponent(id)),
          );
      }
    }
  }

  function reconcile(): void {
    if (isPlaybackRoute()) {
      stop();
      gate.ready();
      return;
    }
    if (disposed || failed) return;
    observe();

    const current = route();
    const loginPage = visiblePage("#loginPage");
    const homePage = visiblePage("#homeTab");

    document.body.classList.toggle("utv-login-active", Boolean(loginPage));
    document.body.classList.toggle(
      "utv-home-active",
      Boolean(homePage) && current.params.get("tab") !== "1",
    );

    nativeLinks();
    decorateAllCards();

    if (loginPage) {
      adaptationReady = login();
    } else {
      void loadRoutes();
      const headerReady = navigation();
      shelves();
      if (homePage && current.params.get("tab") !== "1") {
        shortcuts();
        void home();
      } else if (current.path === "/details") {
        void detail();
      } else {
        adaptationReady = Boolean(activePage()) && headerReady;
      }
    }

    complete(generation);
    if (!adaptationReady && !homeWork && !detailWork) {
      refreshTimer = setTimeout(reconcile, 120);
    }
  }

  listen(window, "hashchange", () => {
    synopsisDialog.close();
    begin();
  });
  listen(document, "viewshow", begin);
  listen(document, "visibilitychange", () => {
    if (!document.hidden) begin();
  });

  listen(
    document,
    "play",
    () => {
      if (isPlaybackRoute()) begin();
    },
    true,
  );

  listen(document, "keydown", (event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      event.key !== "Escape" ||
      !document.body.classList.contains("utv-mobile-menu-open")
    )
      return;
    document.body.classList.remove("utv-mobile-menu-open");
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open Menu"]');
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.focus();
  });

  begin();
  return () => {
    if (disposed) return;
    disposed = true;
    cardMenu.dispose();
    generation++;
    heroGeneration++;
    controller.abort();
    stop();
    for (const remove of bindings) remove();
    bindings.clear();
    for (const page of document.querySelectorAll<HTMLElement>("#itemDetailPage")) clearDetail(page);
    for (const remove of toolCleanup.values()) remove();
    toolCleanup.clear();
    synopsisDialog.dispose();
    for (const [section, display] of folderDisplays) {
      if (display.value) section.style.setProperty("display", display.value, display.priority);
      else section.style.removeProperty("display");
    }
    folderDisplays.clear();
    document.querySelectorAll("[data-utv-owned]").forEach((node) => {
      node.remove();
    });
    document.body.classList.remove("utv-home-active", "utv-login-active", "utv-mobile-menu-open");
  };
}
