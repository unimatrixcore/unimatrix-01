"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(require.resolve("./seerr.js"), "utf8");
const discoveryShell =
  '<div id="__next"><div class="flex"><div class="sidebar"><nav class="mt-8"><a href="/">Home</a><a href="/discover/movies">Movies</a><a href="/discover/tv">Series</a><a href="/requests">Requests</a></nav></div><main><div class="max-w-8xl"><h1>Discover</h1></div></main></div></div><div class="searchbar"><div><div><input id="search_field" aria-label="Search"></div><div>Account</div></div></div>';
const controls =
  '<div class="mb-4 flex flex-col"><div><h1 data-testid="page-header">Requests</h1></div><div><div><select id="mediaType"><option value="all">All</option></select></div><div><select id="filter"><option value="all">All</option><option value="processing">Processing</option></select></div><div><select id="sort"><option>Recent</option></select><button>Sort</button></div></div></div>';
const nativeCard = () =>
  '<div class="rounded-xl"><div class="absolute"></div><div><div><a href="/movie/399566">Poster</a><div><div>2021</div><a href="/movie/399566">Godzilla vs. Kong</a></div></div><div>Native status</div></div><div class="space-y-2"><button>Manage</button></div></div>';
function request(id, phase, is4k = false) {
  return {
    id,
    type: "movie",
    is4k,
    profileName: "WEB 1080p",
    createdAt: "2026-10-13T06:00:00Z",
    media: { tmdbId: 399566 },
    pipeline: {
      phase,
      label: phase === "available" ? "Ready to watch" : "Downloading",
      reason: "Native request state.",
      stage: phase === "available" ? 4 : 2,
      tone: "active",
      transfers: [],
      warnings: [],
    },
  };
}
function fixture(html, url = "https://requests.example/requests", prepare = () => {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.AbortSignal = AbortSignal;
  window.AbortController = AbortController;
  class XHR extends window.EventTarget {
    open(method, url) {
      this.url = url;
      this.method = method;
    }
    send(data) {
      this.sentData = data;
    }
    respond(payload, status = 200) {
      this.status = status;
      this.responseType = "json";
      this.response = payload;
      this.dispatchEvent(new window.Event("load"));
    }
  }
  window.XMLHttpRequest = XHR;
  window.fetch = async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes("/discover/")
        ? {
            results: [
              {
                id: 1,
                title: "Test title",
                mediaType: "movie",
                backdropPath: "/test.jpg",
                releaseDate: "2020-01-01",
              },
            ],
          }
        : { results: [] },
  });
  prepare(window);
  window.eval(source);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const send = (payload, url = "/api/v1/request?filter=all") => {
    const xhr = new XHR();
    xhr.open("GET", url);
    xhr.respond(payload);
    return xhr;
  };
  return { dom, window, send, XHR, close: () => window.close() };
}
test("same-title 1080p and4K requests keep separate status cards through reordering", () => {
  const f = fixture(
    '<main><div class="max-w-8xl">' + controls + nativeCard() + nativeCard() + "</div></main>",
  );
  try {
    f.send({ results: [request(4, "available"), request(9, "downloading", true)] });
    const cards = Array.from(f.window.document.querySelectorAll(".um-request-card"));
    assert.equal(cards.length, 2);
    assert.equal(cards[0].dataset.requestId, "4");
    assert.equal(cards[0].dataset.phase, "available");
    assert.equal(cards[1].dataset.requestId, "9");
    assert.equal(cards[1].dataset.phase, "downloading");
    f.send({ results: [request(9, "available", true), request(4, "downloading")] });
    assert.equal(cards[0].dataset.phase, "downloading");
    assert.equal(cards[1].dataset.phase, "available");
    assert.match(cards[1].querySelector(".um-request-meta").textContent, /4K/);
  } finally {
    f.close();
  }
});
test("newer native filter responses win and unauthorized responses cannot replace them", () => {
  const f = fixture('<main><div class="max-w-8xl">' + controls + nativeCard() + "</div></main>");
  try {
    const old = new f.XHR();
    old.open("GET", "/api/v1/request?filter=all");
    const current = new f.XHR();
    current.open("GET", "/api/v1/request?filter=processing");
    current.respond({ results: [request(4, "downloading")] });
    old.respond({ results: [request(4, "available")] });
    assert.equal(f.window.document.querySelector(".um-request-card").dataset.phase, "downloading");
    const denied = new f.XHR();
    denied.open("GET", "/api/v1/request?filter=all");
    denied.respond({ results: [request(4, "available")] }, 403);
    assert.equal(f.window.document.querySelector(".um-request-card").dataset.phase, "downloading");
  } finally {
    f.close();
  }
});
test("an in-flight status poll cannot overwrite a newly selected filter", async () => {
  const f = fixture('<main><div class="max-w-8xl">' + controls + nativeCard() + "</div></main>");
  try {
    f.send({ results: [request(4, "available")] });
    let resolveFetch;
    f.window.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    f.window.document.querySelector('button[aria-label="Refresh statuses"]').click();
    f.send({ results: [request(4, "downloading")] }, "/api/v1/request?filter=processing");
    resolveFetch({ ok: true, json: async () => ({ results: [request(4, "available")] }) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.window.document.querySelector(".um-request-card").dataset.phase, "downloading");
  } finally {
    f.close();
  }
});
test("search retires discover immediately and keeps its native query editable across query/history changes", async () => {
  const html = discoveryShell;
  const f = fixture(html, "https://requests.example/");
  try {
    await new Promise((resolve) => f.window.setTimeout(resolve, 450));
    assert.ok(f.window.document.querySelector(".um-catalog"));
    const input = f.window.document.querySelector("#search_field");
    input.value = "Godzilla";
    f.window.history.pushState({}, "", "/search?query=Godzilla");
    assert.equal(f.window.document.querySelector(".um-catalog"), null);
    assert.equal(f.window.document.body.classList.contains("um-catalog-active"), false);
    assert.ok(f.window.document.body.classList.contains("um-search-open"));
    assert.equal(input.value, "Godzilla");
    input.value = "Star Wars";
    f.window.history.replaceState({}, "", "/search?query=Star%20Wars");
    assert.ok(f.window.document.body.classList.contains("um-search-open"));
    assert.equal(input.value, "Star Wars");
    f.window.document.dispatchEvent(
      new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.ok(f.window.document.body.classList.contains("um-search-open"));
    input.value = "";
    f.window.history.pushState({}, "", "/search?query=");
    assert.equal(input.value, "");
    assert.ok(f.window.document.body.classList.contains("um-search-page"));
    const previous = new Promise((resolve) =>
      f.window.addEventListener("popstate", resolve, { once: true }),
    );
    f.window.history.back();
    await previous;
    assert.equal(new URL(f.window.location.href).searchParams.get("query"), "Star Wars");
    assert.ok(f.window.document.body.classList.contains("um-search-open"));
    const following = new Promise((resolve) =>
      f.window.addEventListener("popstate", resolve, { once: true }),
    );
    f.window.history.forward();
    await following;
    assert.equal(new URL(f.window.location.href).searchParams.get("query"), "");
    assert.ok(f.window.document.body.classList.contains("um-search-open"));
    f.window.history.pushState({}, "", "/requests");
    f.window.dispatchEvent(new f.window.PopStateEvent("popstate"));
    assert.equal(f.window.document.body.classList.contains("um-search-page"), false);
    assert.equal(f.window.document.body.classList.contains("um-search-open"), false);
  } finally {
    f.close();
  }
});

test("home loading screen mounts matching boot gate with logo and spinner", async () => {
  const f = fixture(
    '<!doctype html><html><head></head><body><div id="__next"><main></main></div></body></html>',
    "https://requests.example/",
  );
  try {
    const gate = f.window.document.getElementById("um-page-loading");
    assert.ok(gate, "um-page-loading should exist");
    assert.equal(gate.getAttribute("role"), "status");
    assert.equal(gate.getAttribute("aria-live"), "polite");
    const logo = gate.querySelector(".utv-boot-logo");
    assert.ok(logo, "utv-boot-logo should exist");
    assert.equal(logo.getAttribute("src"), "/unimatrix-theme/logo.png");
    const spinner = gate.querySelector(".utv-boot-spinner");
    assert.ok(spinner, "utv-boot-spinner should exist");
    const text = gate.querySelector(".utv-boot-text");
    assert.equal(text?.textContent, "Loading");
  } finally {
    f.close();
  }
});

test("cards do not render captions beneath poster", async () => {
  const f = fixture(
    '<!doctype html><html><head></head><body><div id="__next"><main><div data-testid="title-card"><div role="link"><img src="/poster.jpg"></div><div data-testid="title-card-title">Test Movie</div></div></main></div></body></html>',
    "https://requests.example/movies",
  );
  try {
    const card = f.window.document.querySelector('[data-testid="title-card"]');
    assert.ok(card);
    const caption = card.querySelector(".um-native-card-caption");
    assert.equal(caption, null, "captions should not be created under cards");
  } finally {
    f.close();
  }
});

const requestDialog = (
  options = '<option value="7">WEB 1080p (Default)</option><option value="83">WEB 1080p (English Dub)</option>',
  heading = "Request Movie",
) =>
  '<main></main><div role="dialog" aria-modal="true"><h2>' +
  heading +
  '</h2><div class="rounded-md"><label for="profile">Quality Profile</label><select id="profile">' +
  options +
  '</select></div><button data-testid="modal-cancel-button">Cancel</button><button data-testid="modal-ok-button">Request</button></div>';
const settle = (f) => new Promise((resolve) => f.window.setTimeout(resolve, 450));

test("audio buttons select actual native profile values and restore the corresponding standard profile", async () => {
  const f = fixture(requestDialog());
  try {
    await settle(f);
    const select = f.window.document.querySelector("#profile");
    const changed = [];
    select.addEventListener("change", () => changed.push(select.value));
    const card = f.window.document.querySelector(".um-audio-preference-card");
    const dubbed = card.querySelector('[data-pref="dubbed"]');
    const original = card.querySelector('[data-pref="original"]');
    dubbed.click();
    assert.equal(select.value, "83");
    assert.equal(dubbed.getAttribute("aria-checked"), "true");
    assert.equal(f.window.localStorage.getItem("um-seerr-audio-preference"), "dubbed");
    dubbed.dispatchEvent(
      new f.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    assert.equal(select.value, "7");
    assert.equal(original.getAttribute("aria-checked"), "true");
    assert.deepEqual(changed, ["83", "7"]);
  } finally {
    f.close();
  }
});

test("remembered audio preference uses the selected server's actual matching profiles", async () => {
  const f = fixture(
    requestDialog(
      '<option value="104">WEB-1080p (Default)</option><option value="205">WEB-1080p (English Dub)</option>',
    ),
    undefined,
    (window) => window.localStorage.setItem("um-seerr-audio-preference", "dubbed"),
  );
  try {
    await settle(f);
    assert.equal(f.window.document.querySelector("#profile").value, "205");
  } finally {
    f.close();
  }
});

test("unsupported 4K and server profiles keep native settings and disable the dub control", async () => {
  const f = fixture(
    requestDialog(
      '<option value="55">Ultra-HD (Default)</option><option value="83">WEB 1080p (English Dub)</option>',
    ),
    undefined,
    (window) => window.localStorage.setItem("um-seerr-audio-preference", "dubbed"),
  );
  try {
    await settle(f);
    const select = f.window.document.querySelector("#profile");
    const dubbed = f.window.document.querySelector('[data-pref="dubbed"]');
    assert.equal(select.value, "55");
    assert.equal(dubbed.disabled, true);
    dubbed.click();
    assert.equal(select.value, "55");
    select.innerHTML =
      '<option value="12">Other 1080p</option><option value="19">Other 1080p (English Dub)</option>';
    select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    dubbed.click();
    assert.equal(select.value, "19");
  } finally {
    f.close();
  }
});

test("audio preference never rewrites native movie, series, 4K, fetch, or unrelated request payloads", async () => {
  let fetchInit;
  const f = fixture("<main></main>", undefined, (window) => {
    window.localStorage.setItem("um-seerr-audio-preference", "dubbed");
    window.fetch = async (_url, init) => {
      fetchInit = init;
      return { ok: true };
    };
  });
  try {
    for (const mediaType of ["movie", "tv"]) {
      const body = JSON.stringify({
        mediaId: 101,
        mediaType,
        is4k: true,
        serverId: 12,
        profileId: 33,
        tags: [44],
        languageProfileId: 55,
      });
      const xhr = new f.XHR();
      xhr.open("POST", "/api/v1/request");
      xhr.send(body);
      assert.equal(xhr.sentData, body);
      const init = Object.freeze({ method: "POST", body });
      await f.window.fetch("/api/v1/request", init);
      assert.equal(fetchInit, init);
      assert.equal(fetchInit.body, body);
    }
  } finally {
    f.close();
  }
});

test("unrelated dialogs and users without native profile access get no ineffective audio controls", async () => {
  const f = fixture(
    '<main></main><div role="dialog" aria-modal="true"><h2>Delete request</h2><button data-testid="modal-cancel-button">Cancel</button><button data-testid="modal-ok-button">Delete</button></div>',
  );
  try {
    await settle(f);
    assert.equal(f.window.document.querySelector(".um-audio-preference-card"), null);
    const dialog = f.window.document.querySelector('[role="dialog"]');
    dialog.querySelector('[data-testid="modal-ok-button"]').textContent = "Request";
    await settle(f);
    assert.equal(f.window.document.querySelector(".um-audio-preference-card"), null);
  } finally {
    f.close();
  }
});

test("invalid saved audio values safely fall back and profile changes preserve manual choices", async () => {
  const f = fixture(
    requestDialog(
      '<option value="7">WEB 1080p (Default)</option><option value="83">WEB 1080p (English Dub)</option><option value="5">Ultra-HD</option>',
    ),
    undefined,
    (window) => window.localStorage.setItem("um-seerr-audio-preference", "invalid"),
  );
  try {
    await settle(f);
    const select = f.window.document.querySelector("#profile");
    assert.equal(select.value, "7");
    select.value = "5";
    select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    f.window.document.body.appendChild(f.window.document.createElement("div"));
    await settle(f);
    assert.equal(select.value, "5");
    assert.equal(f.window.document.querySelector('[data-pref="dubbed"]').disabled, true);
  } finally {
    f.close();
  }
});

test("cards suppress type pill on homogeneous movie or tv pages", async () => {
  const f = fixture(
    '<!doctype html><html><head></head><body><div id="__next"><main><div data-testid="title-card"><div role="link"><div class="pointer-events-none rounded-full">MOVIE</div><img src="/poster.jpg"></div></div></main></div></body></html>',
    "https://requests.example/movies",
  );
  try {
    await new Promise((resolve) => f.window.setTimeout(resolve, 450));
    const badge = f.window.document.querySelector(".pointer-events-none.rounded-full");
    assert.ok(badge);
    assert.equal(badge.style.display, "none", "movie badge should be hidden on movies page");
  } finally {
    f.close();
  }
});

test("reused title cards restore type badges when returning to mixed search results", async () => {
  const f = fixture(
    '<main><div data-testid="title-card"><div role="link"><div class="pointer-events-none rounded-full">MOVIE</div><div class="pointer-events-none rounded-full">Available</div><img src="/poster.jpg"></div></div></main>',
    "https://requests.example/discover/movies",
  );
  try {
    await settle(f);
    const badges = f.window.document.querySelectorAll(".pointer-events-none.rounded-full");
    assert.equal(badges[0].style.display, "none");
    assert.equal(badges[1].style.display, "");
    f.window.history.pushState({}, "", "/search?query=movie");
    await settle(f);
    assert.equal(badges[0].style.display, "");
  } finally {
    f.close();
  }
});

test("saved preference cannot override an explicit native quality profile or a server's default without a preference", async () => {
  for (const saved of [null, "original"]) {
    const f = fixture(
      requestDialog(
        '<option value="83">WEB 1080p (English Dub)</option><option value="7">WEB 1080p (Default)</option>',
      ),
      undefined,
      (window) => {
        if (saved) window.localStorage.setItem("um-seerr-audio-preference", saved);
      },
    );
    try {
      await settle(f);
      assert.equal(f.window.document.querySelector("#profile").value, "83");
    } finally {
      f.close();
    }
  }
});

test("series request labels composed of adjacent spans retain audio controls", async () => {
  const f = fixture(requestDialog(undefined, "Request Series"));
  try {
    const submit = f.window.document.querySelector('[data-testid="modal-ok-button"]');
    submit.innerHTML = "<span>Request</span><span>1 Season</span>";
    await settle(f);
    const dub = f.window.document.querySelector('[role="radio"][data-pref="dubbed"]');
    assert.ok(dub);
    dub.click();
    assert.equal(f.window.document.querySelector("#profile").value, "83");
  } finally {
    f.close();
  }
});

test("detail audio preference remains usable after native cloning and unavailable storage", async () => {
  const f = fixture(
    '<main><div class="media-actions"></div></main>',
    "https://requests.example/tv/123542",
    (window) => {
      window.Storage.prototype.setItem = () => {
        throw new Error("storage unavailable");
      };
    },
  );
  try {
    await settle(f);
    const original = f.window.document.querySelector(".um-detail-audio-btn");
    assert.ok(original);
    original.click();
    assert.equal(original.textContent, "Request audio: English dub");
    assert.equal(original.getAttribute("aria-pressed"), "true");
    f.window.document.body.insertAdjacentHTML("beforeend", requestDialog());
    await settle(f);
    assert.equal(f.window.document.querySelector("#profile").value, "83");
    f.window.document.querySelector('[role="dialog"]')?.remove();
    await settle(f);
    const clone = original.cloneNode(true);
    original.replaceWith(clone);
    await settle(f);
    clone.click();
    assert.equal(clone.textContent, "Request audio: Default");
    assert.equal(clone.getAttribute("aria-pressed"), "false");
  } finally {
    f.close();
  }
});

test("series audio profiles work before seasons are selected without enabling request submission", async () => {
  const f = fixture(requestDialog(undefined, "Request Series"));
  try {
    const submit = f.window.document.querySelector('[data-testid="modal-ok-button"]');
    submit.textContent = "Select Season(s)";
    submit.disabled = true;
    await settle(f);
    const dub = f.window.document.querySelector('[role="radio"][data-pref="dubbed"]');
    assert.ok(dub);
    dub.click();
    assert.equal(f.window.document.querySelector("#profile").value, "83");
    assert.equal(submit.disabled, true);
  } finally {
    f.close();
  }
});

test("Networks recovers after native rendering replaces main content without changing the URL", async () => {
  const f = fixture(discoveryShell, "https://requests.example/discover/tv?view=networks");
  try {
    await settle(f);
    assert.ok(f.window.document.querySelector(".um-networks-page"));
    const oldMain = f.window.document.querySelector("main");
    const newMain = f.window.document.createElement("main");
    newMain.innerHTML = '<div class="max-w-8xl"><h1>Native series discovery</h1></div>';
    oldMain.replaceWith(newMain);
    await settle(f);
    const page = newMain.querySelector(".um-networks-page");
    assert.ok(page);
    const search = page.querySelector(".um-network-search");
    search.value = "netflix";
    search.dispatchEvent(new f.window.Event("input", { bubbles: true }));
    assert.deepEqual(
      [...page.querySelectorAll(".um-network-page-grid a:not([hidden])")].map((a) =>
        a.getAttribute("aria-label"),
      ),
      ["Netflix"],
    );
    f.window.history.pushState({}, "", "/requests");
    await settle(f);
    assert.equal(f.window.document.querySelector(".um-networks-page"), null);
    assert.equal(f.window.document.body.classList.contains("um-catalog-active"), false);
  } finally {
    f.close();
  }
});

test("Home retries when native content arrives after its initial empty main", async () => {
  const f = fixture(
    discoveryShell.replace('<div class="max-w-8xl"><h1>Discover</h1></div>', ""),
    "https://requests.example/",
  );
  try {
    await settle(f);
    assert.equal(f.window.document.querySelector(".um-catalog"), null);
    const host = f.window.document.createElement("div");
    host.className = "max-w-8xl";
    f.window.document.querySelector("main").append(host);
    await settle(f);
    assert.ok(f.window.document.querySelector(".um-catalog"));
    assert.ok(f.window.document.querySelector(".um-hero"));
  } finally {
    f.close();
  }
});

test("episode source identity and individual stall state stay visible after status refresh", () => {
  const f = fixture('<main><div class="max-w-8xl">' + controls + nativeCard() + "</div></main>");
  try {
    const r = request(4, "stalled");
    r.pipeline.episodes = { available: 17, aired: 22, active: 3, missing: ["S01E01", "S01E05"] };
    r.pipeline.transfers = [
      {
        episodes: ["S01E03"],
        release: "Dead.City.S01E03.1080p",
        state: "stalledDL",
        percent: 9.1,
        seeds: 0,
        speedBytes: 0,
      },
    ];
    f.send({ results: [r] });
    assert.match(
      f.window.document.querySelector(".um-request-scope").textContent,
      /17 of 22 episodes ready.*3 in downloads.*2 awaiting sources/,
    );
    const rows = f.window.document.querySelector(".um-request-releases");
    assert.match(rows.textContent, /S01E03/);
    assert.match(rows.textContent, /Awaiting sources: S01E01, S01E05/);
    r.pipeline.transfers[0].state = "downloading";
    r.pipeline.transfers[0].percent = 22;
    f.send({ results: [r] });
    assert.match(rows.textContent, /S01E03/);
    assert.doesNotMatch(rows.textContent, /Dead.City.S01E03.1080p/);
    assert.match(
      f.window.document.querySelector(".um-request-activity-button").textContent,
      /Details/,
    );
    assert.equal(f.window.document.querySelector(".um-request-track"), null);
    assert.doesNotMatch(rows.textContent, /Waiting for seeds/);
  } finally {
    f.close();
  }
});

test("service warning text survives native request-page reconstruction", () => {
  const f = fixture('<main><div class="max-w-8xl">' + controls + nativeCard() + "</div></main>");
  try {
    const record = request(4, "available");
    record.pipeline.warnings = ["Indexer unavailable: Internet Archive"];
    f.send({ results: [record] });
    const original = f.window.document.querySelector(".um-request-service-issues p").textContent;
    assert.ok(original.length > 0);
    f.window.document.querySelector(".um-request-service-issues").remove();
    f.send({ results: [record] });
    assert.equal(
      f.window.document.querySelector(".um-request-service-issues p").textContent,
      original,
    );
  } finally {
    f.close();
  }
});
