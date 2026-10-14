"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(require.resolve("./seerr.js"), "utf8");
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
function fixture(html, url = "https://requests.example/requests") {
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
  const html =
    '<div id="__next"><div class="flex"><div class="sidebar"><nav class="mt-8"><a href="/">Home</a><a href="/discover/movies">Movies</a><a href="/discover/tv">Series</a><a href="/requests">Requests</a></nav></div><main><div class="max-w-8xl"><h1>Discover</h1></div></main></div></div><div class="searchbar"><div><div><input id="search_field" aria-label="Search"></div><div>Account</div></div></div>';
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
    f.window.eval(source);
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
    f.window.eval(source);
    const card = f.window.document.querySelector('[data-testid="title-card"]');
    assert.ok(card);
    const caption = card.querySelector(".um-native-card-caption");
    assert.equal(caption, null, "captions should not be created under cards");
  } finally {
    f.close();
  }
});

test("request dialog mounts audio preference toggle", async () => {
  const f = fixture(
    '<!doctype html><html><head></head><body><div id="__next"><main></main></div><div role="dialog" aria-modal="true"><h2>Request Movie</h2><form><button data-testid="modal-cancel-button">Cancel</button><button type="submit">Request</button></form></div></body></html>',
    "https://requests.example/",
  );
  try {
    f.window.eval(source);
    await new Promise((resolve) => f.window.setTimeout(resolve, 450));
    const prefCard = f.window.document.querySelector(".um-audio-preference-card");
    assert.ok(prefCard, "audio preference card should be injected in request dialog");
    const dubbedBtn = prefCard.querySelector('.um-audio-btn[data-pref="dubbed"]');
    assert.ok(dubbedBtn, "dubbed button should exist");
    dubbedBtn.click();
    assert.equal(f.window.localStorage.getItem("um-seerr-audio-preference"), "dubbed");
  } finally {
    f.close();
  }
});

test("POST /api/v1/request intercepts and injects profile 8 and tag 1 for dubbed preference", async () => {
  const f = fixture(
    '<!doctype html><html><head></head><body><div id="__next"><main></main></div></body></html>',
    "https://requests.example/",
  );
  try {
    f.window.localStorage.setItem("um-seerr-audio-preference", "dubbed");
    f.window.eval(source);
    const xhr = new f.window.XMLHttpRequest();
    xhr.open("POST", "/api/v1/request");
    xhr.send(JSON.stringify({ mediaId: 101, mediaType: "movie", profileId: 1 }));
    assert.ok(xhr.sentData, "payload should be sent");
    const parsed = JSON.parse(xhr.sentData);
    assert.equal(parsed.profileId, 8, "profileId should be updated to 8 (English Dub)");
    assert.deepEqual(parsed.tags, [1], "tags should include [1] (dubbed)");
    assert.equal(parsed.languageProfileId, 1, "languageProfileId should be 1");
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
    f.window.eval(source);
    await new Promise((resolve) => f.window.setTimeout(resolve, 450));
    const badge = f.window.document.querySelector(".pointer-events-none.rounded-full");
    assert.ok(badge);
    assert.equal(badge.style.display, "none", "movie badge should be hidden on movies page");
  } finally {
    f.close();
  }
});
