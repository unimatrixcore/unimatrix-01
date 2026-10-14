/* Unimatrix-TV Requests presentation. Native Seerr owns authentication and request actions. */
(() => {
  "use strict";
  document.documentElement.classList.add("um-seerr-boot");
  const bootDeadline = setTimeout(
    () => document.documentElement.classList.remove("um-seerr-boot"),
    15000,
  );

  const posterTitles = new Map();
  function rememberMedia(data) {
    if (!data || typeof data !== "object") return;
    if (Array.isArray(data)) {
      data.forEach(rememberMedia);
      return;
    }
    if (data.posterPath && (data.title || data.name))
      posterTitles.set(data.posterPath.split("/").at(-1), data.title || data.name);
    for (const key of ["results", "media", "items"]) if (data[key]) rememberMedia(data[key]);
  }
  function getAudioPreference() {
    try {
      return localStorage.getItem("um-seerr-audio-preference") || "original";
    } catch {
      return "original";
    }
  }

  function setAudioPreference(pref) {
    try {
      localStorage.setItem("um-seerr-audio-preference", pref);
    } catch {}
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._umMethod = String(method).toUpperCase();
    this._umUrl = String(url);
    if (this._umUrl.startsWith("/api/v1/"))
      this.addEventListener(
        "load",
        () => {
          try {
            rememberMedia(
              this.responseType === "json" ? this.response : JSON.parse(this.responseText),
            );
            setTimeout(nativeAccessibility, 0);
          } catch {}
        },
        { once: true },
      );
    return nativeOpen.call(this, method, url, ...rest);
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (data) {
    if (
      this._umMethod === "POST" &&
      /^\/api\/v1\/request(?:\?|$)/.test(this._umUrl) &&
      typeof data === "string"
    ) {
      try {
        const payload = JSON.parse(data);
        const pref = getAudioPreference();
        if (pref === "dubbed") {
          payload.profileId = 8;
          payload.tags = Array.from(new Set([...(payload.tags || []), 1]));
          payload.languageProfileId = 1;
          data = JSON.stringify(payload);
        }
      } catch {}
    }
    return nativeSend.call(this, data);
  };

  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (
        init &&
        init.method &&
        String(init.method).toUpperCase() === "POST" &&
        /^\/api\/v1\/request(?:\?|$)/.test(String(url))
      ) {
        try {
          if (typeof init.body === "string") {
            const payload = JSON.parse(init.body);
            const pref = getAudioPreference();
            if (pref === "dubbed") {
              payload.profileId = 8;
              payload.tags = Array.from(new Set([...(payload.tags || []), 1]));
              payload.languageProfileId = 1;
              init.body = JSON.stringify(payload);
            }
          }
        } catch {}
      }
      return nativeFetch.call(this, input, init);
    };
  }

  let pendingDeadline,
    featureGeneration = 0;
  function finishPending() {
    clearTimeout(pendingDeadline);
    document.documentElement.classList.remove("um-seerr-pending");
    const gate = document.getElementById("um-page-loading");
    if (!gate) return;
    gate.style.transition = "opacity 250ms ease-out";
    gate.style.opacity = "0";
    gate.style.pointerEvents = "none";
    setTimeout(() => gate.remove(), 250);
  }
  if (location.pathname === "/") {
    document.documentElement.classList.add("um-seerr-pending");
    const gate = document.createElement("div");
    gate.id = "um-page-loading";
    gate.setAttribute("role", "status");
    gate.setAttribute("aria-live", "polite");

    const card = document.createElement("div");
    card.className = "utv-boot-card";

    const logo = document.createElement("img");
    logo.className = "utv-boot-logo";
    logo.src = "/unimatrix-theme/logo.png";
    logo.alt = "Unimatrix-TV";

    const spinner = document.createElement("div");
    spinner.className = "utv-boot-spinner";
    spinner.setAttribute("aria-hidden", "true");

    const text = document.createElement("div");
    text.className = "utv-boot-text";
    text.textContent = "Loading";

    card.append(logo, spinner, text);
    gate.append(card);

    function attach() {
      if (document.body && !gate.isConnected) {
        document.body.prepend(gate);
      }
    }
    if (document.body) attach();
    else {
      const obs = new MutationObserver(() => {
        if (document.body) {
          attach();
          obs.disconnect();
        }
      });
      obs.observe(document.documentElement, { childList: true });
    }
    pendingDeadline = setTimeout(finishPending, 19000);
  }
  const $ = (s, r = document) => r.querySelector(s);
  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    library: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
  };
  function icon(name, label, fn) {
    const b = node("button", "um-icon");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
      icons[name] +
      "</svg>";
    if (fn) b.addEventListener("click", fn);
    return b;
  }
  const networks = [
    ["Netflix", 213],
    ["HBO", 49],
    ["Apple TV+", 2552],
    ["Prime Video", 1024],
    ["Disney+", 2739],
    ["Hulu", 453],
    ["Paramount+", 4330],
    ["Peacock", 3353],
    ["AMC", 174],
    ["BBC One", 4],
    ["FX", 88],
    ["Showtime", 67],
    ["Adult Swim", 80],
    ["Starz", 318],
    ["NBC", 6],
    ["CBS", 16],
    ["ABC", 2],
    ["FOX", 19],
    ["The CW", 71],
    ["Cartoon Network", 56],
    ["Nickelodeon", 13],
    ["Discovery+", 4353],
    ["Cinemax", 359],
  ];
  let usage = {};
  try {
    usage = JSON.parse(localStorage.getItem("um-network-usage") || "{}");
  } catch {}
  function link(text, href, cls) {
    const a = node("a", cls, text);
    a.href = href;
    return a;
  }
  const networkLogos = {
    213: "wwemzKWzjKYJFfCeiB57q3r4Bcm.png",
    2739: "gJ8VX6JSu3ciXHuC2dDGAo2lvwM.png",
    1024: "ifhbNuuVnlwYy5oXA5VIb2YR8AZ.png",
    2552: "4KAy34EHvRM25Ih8wb82AuGU7zJ.png",
    453: "pqUTCleNUiTLAVlelGxUgWn1ELh.png",
    49: "tuomPhY2UtuPTqqFnKMVHvSb724.png",
    4353: "1D1bS3Dyw4ScYnFWTlBOvJXC3nb.png",
    2: "ndAvF4JLsliGreX87jAc9GdjmJY.png",
    19: "1DSpHrWyOORkL9N2QHX7Adt31mQ.png",
    359: "6mSHSquNpfLgDdv6VnOOvC5Uz2h.png",
    174: "pmvRmATOCaDykE6JrVoeYxlFHw3.png",
    67: "Allse9kbjiP6ExaQrnSpIhkurEi.png",
    318: "8GJjw3HHsAJYwIWKIPBPfqMxlEa.png",
    71: "ge9hzeaU7nMtQ4PjkFlc68dGAJ9.png",
    6: "o3OedEP0f9mfZr33jz2BfXOUK5.png",
    16: "nm8d7P7MJNiBLdgIzUK0gkuEA4r.png",
    4330: "fi83B1oztoS47xxcemFdPMhIzK.png",
    4: "mVn7xESaTNmjBUyUtGNvDQd3CT1.png",
    56: "c5OC6oVCg6QP4eqzW6XIq17CQjI.png",
    80: "9AKyspxVzywuaMuZ1Bvilu8sXly.png",
    13: "ikZXxg6GnwpzqiZbRPhJGaZapqB.png",
    3353: "gIAcGTjKKr0KOHL5s4O36roJ8p7.png",
  };
  function networkLink(x) {
    const a = link(x[0], "/discover/tv/network/" + x[1]);
    a.title = x[0];
    a.setAttribute("aria-label", x[0]);
    if (networkLogos[x[1]]) {
      const img = node("img");
      img.alt = x[0];
      img.onerror = () => {
        a.replaceChildren(node("span", "um-network-wordmark", x[0]));
      };
      img.src =
        "https://image.tmdb.org/t/p/w300_filter(duotone,ffffff,bababa)/" + networkLogos[x[1]];
      a.replaceChildren(img);
    }
    a.addEventListener("click", () => {
      usage[x[1]] = (usage[x[1]] || 0) + 1;
      try {
        localStorage.setItem("um-network-usage", JSON.stringify(usage));
      } catch {}
    });
    return a;
  }
  function rankedNetworks() {
    return networks
      .map((x, i) => ({ x, i, n: usage[x[1]] || 0 }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((x) => x.x);
  }
  const networkPageUrl = "/discover/tv?view=networks";
  const isNetworkPage = () =>
    location.pathname === "/discover/tv" &&
    new URLSearchParams(location.search).get("view") === "networks";
  function orderNetworks(rail) {
    const pins = node("div", "um-network-pins");
    rankedNetworks()
      .slice(0, 8)
      .forEach((x) => pins.append(networkLink(x)));
    const picker = link("", networkPageUrl, "um-network-picker");
    picker.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>Networks</span>';
    rail.append(pins, picker);
  }
  function renderNetworks(main) {
    document.body.classList.add("um-catalog-active");
    catalog = node("section", "um-catalog um-networks-page");
    catalog.setAttribute("aria-label", "Networks");
    const heading = node("div", "um-networks-page-heading");
    heading.append(node("h1", null, "Networks"));
    const search = node("input", "um-network-search");
    search.type = "search";
    search.placeholder = "Find a network";
    search.setAttribute("aria-label", "Find a network");
    heading.append(search);
    const grid = node("div", "um-network-page-grid");
    rankedNetworks().forEach((x) => {
      const a = networkLink(x);
      a.dataset.networkName = x[0].toLowerCase();
      grid.append(a);
    });
    const empty = node("p", "um-network-no-results", "No matching networks");
    empty.hidden = true;
    search.addEventListener("input", () => {
      const text = search.value.trim().toLowerCase();
      let count = 0;
      for (const a of grid.children) {
        a.hidden = !a.dataset.networkName.includes(text);
        if (!a.hidden) count++;
      }
      empty.hidden = count > 0;
    });
    catalog.append(heading, grid, empty);
    main.prepend(catalog);
    finishPending();
  }

  let header,
    catalog,
    original = [],
    routePath = "",
    path = "",
    loadController,
    items = [],
    index = 0,
    routeTimer,
    featuredLabel = "Trending now";
  const api = async (url, signal) => {
    const r = await fetch("/api/v1" + url, {
      credentials: "same-origin",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error("Requests data unavailable");
    const data = await r.json();
    rememberMedia(data);
    return data;
  };
  function enhanceRequestDialog(dialog) {
    if (!dialog || dialog.querySelector(".um-audio-preference-card")) return;
    const isRequest =
      dialog.querySelector("[data-testid=modal-cancel-button]") ||
      Array.from(dialog.querySelectorAll("button")).some((b) => /request/i.test(b.textContent || ""));
    if (!isRequest) return;

    const pref = getAudioPreference();
    const card = document.createElement("div");
    card.className = "um-audio-preference-card";
    card.innerHTML =
      '<div class="um-audio-header">' +
      '<span class="um-audio-title">Audio Language Target</span>' +
      `<span class="um-audio-badge ${pref === "dubbed" ? "is-dubbed" : ""}">${pref === "dubbed" ? "English Dubbed" : "Original Audio"}</span>` +
      "</div>" +
      '<div class="um-audio-toggle-group" role="radiogroup">' +
      `<button type="button" class="um-audio-btn ${pref === "original" ? "is-active" : ""}" data-pref="original"><span class="um-audio-icon">🌐</span> Original Audio</button>` +
      `<button type="button" class="um-audio-btn ${pref === "dubbed" ? "is-active" : ""}" data-pref="dubbed"><span class="um-audio-icon">🎙️</span> English Dubbed</button>` +
      "</div>" +
      '<p class="um-audio-description">' +
      (pref === "dubbed"
        ? "Prioritizes English audio tracks using Radarr/Sonarr English Dub profile & tag."
        : "Downloads media in original language of release.") +
      "</p>";

    card.querySelectorAll(".um-audio-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute("data-pref") || "original";
        setAudioPreference(next);
        card.querySelectorAll(".um-audio-btn").forEach((b) => {
          b.classList.toggle("is-active", b.getAttribute("data-pref") === next);
        });
        const badge = card.querySelector(".um-audio-badge");
        if (badge) {
          badge.textContent = next === "dubbed" ? "English Dubbed" : "Original Audio";
          badge.classList.toggle("is-dubbed", next === "dubbed");
        }
        const desc = card.querySelector(".um-audio-description");
        if (desc) {
          desc.textContent =
            next === "dubbed"
              ? "Prioritizes English audio tracks using Radarr/Sonarr English Dub profile & tag."
              : "Downloads media in original language of release.";
        }
      });
    });

    const target =
      dialog.querySelector(".form-action, .modal-actions, [data-testid=modal-cancel-button]")
        ?.parentElement ||
      dialog.querySelector("form") ||
      dialog.querySelector(".p-6") ||
      dialog;
    if (target && target !== dialog && target.parentElement) {
      target.parentElement.insertBefore(card, target);
    } else {
      dialog.appendChild(card);
    }
  }

  function enhanceDetailPageAudio() {
    if (!/^\/(?:movie|tv)\/\d+/.test(location.pathname)) return;
    if (document.querySelector(".um-detail-audio-toggle")) return;
    const actions = document.querySelector(".media-actions, .media-header .flex.items-center");
    if (!actions) return;

    const pref = getAudioPreference();
    const toggle = document.createElement("div");
    toggle.className = "um-detail-audio-toggle";
    toggle.innerHTML =
      `<button type="button" class="um-detail-audio-btn ${pref === "dubbed" ? "is-dubbed" : ""}" title="Click to toggle Audio Preference (Original vs English Dubbed)">` +
      `<span class="um-detail-audio-icon">${pref === "dubbed" ? "🎙️" : "🌐"}</span>` +
      `<span>${pref === "dubbed" ? "English Dub" : "Original Audio"}</span>` +
      "</button>";
    const btn = toggle.querySelector("button");
    btn?.addEventListener("click", (e) => {
      e.preventDefault();
      const next = getAudioPreference() === "dubbed" ? "original" : "dubbed";
      setAudioPreference(next);
      btn.classList.toggle("is-dubbed", next === "dubbed");
      const icon = btn.querySelector(".um-detail-audio-icon");
      if (icon) icon.textContent = next === "dubbed" ? "🎙️" : "🌐";
      const text = btn.querySelector("span:last-child");
      if (text) text.textContent = next === "dubbed" ? "English Dub" : "Original Audio";
    });
    actions.appendChild(toggle);
  }

  let activeDialog,
    lastDialogFocus,
    inertRoots = [];
  function nativeAccessibility() {
    if (location.pathname === "/login") {
      const shell = $("div.min-h-screen");
      if (shell) {
        shell.classList.add("um-login-shell");
        const logo = shell.querySelector('img[src*="logo_stacked"]');
        const brand = logo?.closest(".z-40");
        if (brand && !brand.classList.contains("um-login-brand")) {
          brand.classList.add("um-login-brand");
          const a = link("", "/", "um-brand");
          const img = node("img");
          img.src = "/unimatrix-theme/logo.png";
          img.alt = "";
          const copy = node("span", null, "Unimatrix-TV");
          copy.append(node("small", null, "Requests"));
          a.append(img, copy);
          a.setAttribute("aria-label", "Unimatrix-TV Requests");
          brand.replaceChildren(a);
        }
      }
    }
    document.querySelectorAll("span[role=checkbox][tabindex]").forEach((e) => {
      const checked = !!e.querySelector(".translate-x-5");
      if (e.getAttribute("aria-checked") !== String(checked))
        e.setAttribute("aria-checked", String(checked));
    });
    document.querySelectorAll("label[for=localLogin]").forEach((e) => {
      const input = e.closest(".relative.flex.items-start")?.querySelector("input[type=checkbox]");
      if (input?.id) e.htmlFor = input.id;
    });
    const clear = $("#search_field")?.parentElement?.querySelector("button");
    if (clear && !clear.getAttribute("aria-label"))
      clear.setAttribute("aria-label", "Clear search");
    document.querySelectorAll(".slideover").forEach((e) => {
      e.setAttribute("role", "dialog");
      e.setAttribute("aria-modal", "true");
      e.setAttribute("aria-label", e.querySelector("h2")?.textContent || "Manage request");
    });
    const isMoviesPage = /^\/(?:discover\/)?movies/.test(location.pathname);
    const isTvPage = /^\/(?:discover\/)?tv/.test(location.pathname);
    document.querySelectorAll("[data-testid=title-card]").forEach((card) => {
      const image = card.querySelector("img");
      let src = image?.currentSrc || image?.src || "";
      try {
        src = decodeURIComponent(src);
      } catch {}
      const name =
        card.querySelector("[data-testid=title-card-title],h1,h2")?.textContent ||
        [...posterTitles].find(([key]) => src.includes(key))?.[1];
      const entry = card.querySelector("[role=link]");
      if (name) {
        entry?.setAttribute("aria-label", name);
      } else entry?.setAttribute("aria-label", "View title details");
      card.querySelector(".um-native-card-caption")?.remove();
      const shelf =
        card.closest(".slider-header, .slider-title")?.parentElement ||
        card.closest("section") ||
        card.closest(".um-shelf");
      const heading =
        shelf?.querySelector("h2, .slider-title, [data-testid=page-header]")?.textContent || "";
      const isHomogeneous =
        isMoviesPage ||
        isTvPage ||
        /movies?|films?/i.test(heading) ||
        /series|tv\s*shows?|shows?/i.test(heading);
      if (isHomogeneous) {
        const typeBadge = card.querySelector(".pointer-events-none.rounded-full");
        if (typeBadge) typeBadge.style.display = "none";
      }
      card.querySelectorAll("button").forEach((b) => {
        if (!b.textContent.trim() && !b.getAttribute("aria-label")) {
          const paths = [...b.querySelectorAll("path")]
            .map((p) => p.getAttribute("d") || "")
            .join(" ");
          const icon = b.querySelector("svg");
          const label = icon?.classList.contains("text-amber-300")
            ? "Add to watchlist"
            : paths.includes("M15 12H9")
              ? "Remove from watchlist"
              : paths.includes("3.98 8.223") || paths.includes("M3 3")
                ? "Hide title"
                : paths.includes("2.036 12.322") || paths.includes("3.75 12")
                  ? "Show title"
                  : "Manage title visibility";
          b.setAttribute("aria-label", label);
        }
      });
    });
    const account = $(".searchbar button[id^=headlessui-menu-button]");
    if (account) account.setAttribute("aria-label", "User menu");
    const dialog = $("[role=dialog][aria-modal=true]");
    if (dialog && dialog !== activeDialog) {
      activeDialog = dialog;
      lastDialogFocus = document.activeElement;
      inertRoots = [...document.body.children].filter(
        (e) => !e.contains(dialog) && !["SCRIPT", "STYLE", "LINK"].includes(e.tagName) && !e.inert,
      );
      inertRoots.forEach((e) => (e.inert = true));
      enhanceRequestDialog(dialog);
      (
        dialog.querySelector("[data-testid=modal-cancel-button]") ||
        dialog.querySelector('button:not([disabled]),input,select,[tabindex="0"]')
      )?.focus();
    } else if (dialog) {
      enhanceRequestDialog(dialog);
    } else if (!dialog && activeDialog) {
      activeDialog = null;
      inertRoots.forEach((e) => (e.inert = false));
      inertRoots = [];
      if (lastDialogFocus?.isConnected) lastDialogFocus.focus();
    }
    enhanceDetailPageAudio();
    if (matchMedia("(prefers-reduced-motion:reduce)").matches)
      document.querySelectorAll("svg animateTransform").forEach((e) => {
        e.ownerSVGElement?.pauseAnimations?.();
        e.remove();
      });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      const checkbox = e.target.closest?.("[role=checkbox][tabindex]");
      if (e.key === " " && checkbox && checkbox.tagName !== "INPUT") {
        e.preventDefault();
        e.stopImmediatePropagation();
        checkbox.click();
        setTimeout(nativeAccessibility, 0);
        return;
      }
      if (e.key === "Enter" && checkbox && checkbox.tagName !== "INPUT")
        setTimeout(nativeAccessibility, 0);
      if (!activeDialog) return;
      if (e.key === "Escape") {
        const cancel = activeDialog.querySelector(
          '[data-testid=modal-cancel-button],button[aria-label="Close panel"]',
        );
        if (cancel) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel.click();
        }
        return;
      }
      if (e.key === "Tab") {
        const focusable = [
          ...activeDialog.querySelectorAll(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]',
          ),
        ].filter((e) => e.getBoundingClientRect().height > 0);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    },
    true,
  );
  function syncSurfaceState() {
    header
      ?.querySelector(".um-menu-button")
      ?.setAttribute("aria-expanded", String(document.body.classList.contains("um-mobile-menu")));
    header
      ?.querySelector('button[aria-label="Search movies and series"]')
      ?.setAttribute("aria-expanded", String(document.body.classList.contains("um-search-open")));
    header
      ?.querySelector('button[aria-label="More"]')
      ?.setAttribute("aria-expanded", String(!header.querySelector(".um-tools").hidden));
  }
  document.addEventListener("click", () =>
    setTimeout(() => {
      syncSurfaceState();
      nativeAccessibility();
    }, 0),
  );
  function syncSearchSurface() {
    const searchPage = location.pathname === "/search";
    if (searchPage && !document.body.classList.contains("um-mobile-menu"))
      document.body.classList.add("um-search-open");
    document.body.classList.toggle("um-search-page", searchPage);
    syncSurfaceState();
  }
  function retireRoute() {
    const current = location.pathname + location.search;
    if (current === routePath) return;
    if (routePath) {
      loadController?.abort();
      featureGeneration++;
      catalog?.remove();
      catalog = null;
      items = [];
      original.forEach((e) => (e.hidden = false));
      original = [];
      document.body.classList.remove("um-catalog-active");
      if (location.pathname !== "/search") document.body.classList.remove("um-search-open");
      finishPending();
      path = "";
    }
    routePath = current;
    syncSearchSurface();
  }
  function setup() {
    retireRoute();
    syncSearchSurface();
    if (isNetworkPage() && document.title !== "Networks - Unimatrix-TV Requests")
      document.title = "Networks - Unimatrix-TV Requests";
    nativeAccessibility();
    const main = $("main");
    const sidebar = $("nav.mt-8");
    if (!main || !sidebar) {
      if (location.pathname === "/login") {
        clearTimeout(bootDeadline);
        document.documentElement.classList.remove("um-seerr-boot");
        finishPending();
      }
      return;
    }
    clearTimeout(bootDeadline);
    document.documentElement.classList.remove("um-seerr-boot");
    sidebar.closest(".sidebar")?.parentElement?.classList.add("um-native-sidebar");
    if (!header) {
      let wrap = sidebar;
      while (wrap.parentElement && wrap.parentElement.parentElement !== $("#__next>div.flex"))
        wrap = wrap.parentElement;
      wrap.classList.add("um-native-sidebar");
      const nativeMobile = [...document.querySelectorAll("#__next>div.flex>div")].find((e) =>
        e.classList.contains("sm:hidden"),
      );
      if (nativeMobile) nativeMobile.classList.add("um-native-mobile");
      header = node("header", "um-header");
      const top = node("div", "um-header-main");
      const menu = icon("menu", "Menu", () => {
        if (location.pathname !== "/search") document.body.classList.remove("um-search-open");
        header?.querySelector(".um-tools")?.setAttribute("hidden", "");
        header?.querySelector(".um-network-panel")?.setAttribute("hidden", "");
        const open = document.body.classList.toggle("um-mobile-menu");
        menu.setAttribute("aria-expanded", String(open));
        if (location.pathname === "/search")
          document.body.classList.toggle("um-search-open", !open);
        if (open) header.querySelector(".um-primary a")?.focus();
      });
      menu.classList.add("um-menu-button");
      menu.prepend(document.createTextNode("Menu"));
      menu.setAttribute("aria-expanded", "false");
      const brand = link("", "/", "um-brand");
      const img = node("img");
      img.src = "/unimatrix-theme/logo.png";
      img.alt = "";
      const text = node("span", null, "Unimatrix-TV");
      text.append(node("small", null, "Requests"));
      brand.append(img, text);
      const primary = node("nav", "um-primary");
      primary.setAttribute("aria-label", "Primary");
      primary.id = "um-primary";
      menu.setAttribute("aria-controls", primary.id);
      [
        ["Home", "/"],
        ["Movies", "/discover/movies"],
        ["Series", "/discover/tv"],
        ["Requests", "/requests"],
      ].forEach((x) => primary.append(link(x[0], x[1])));
      const tools = node("div", "um-tools");
      tools.hidden = true;
      tools.id = "um-tools";
      [...sidebar.querySelectorAll("a")]
        .filter(
          (a) =>
            !["/", "/discover/movies", "/discover/tv", "/requests"].includes(
              a.getAttribute("href"),
            ),
        )
        .forEach((a) => {
          const href = a.getAttribute("href");
          tools.append(link(a.textContent.trim(), href));
          const copy = link(a.textContent.trim(), href, "um-mobile-tools");
          primary.append(copy);
        });
      primary.append(link("Networks", networkPageUrl, "um-mobile-network-link"));
      primary.append(
        link("Watch on Unimatrix-TV", "https://streaming.unimatrix-01.dev/web/", "um-mobile-tools"),
      );
      const more = icon("more", "More", () => {
        document.body.classList.remove("um-mobile-menu");
        if (location.pathname !== "/search") document.body.classList.remove("um-search-open");
        const opened = tools.hidden;
        tools.hidden = !opened;
        if (opened) tools.querySelector("a")?.focus();
        more.setAttribute("aria-expanded", String(!tools.hidden));
      });
      more.classList.add("um-more");
      more.setAttribute("aria-controls", "um-tools");
      more.setAttribute("aria-expanded", "false");
      const search = icon("search", "Search movies and series", () => {
        document.body.classList.remove("um-mobile-menu");
        tools.hidden = true;
        const open =
          location.pathname === "/search" || document.body.classList.toggle("um-search-open");
        if (open) document.body.classList.add("um-search-open");
        search.setAttribute("aria-expanded", String(open));
        if (open) $("#search_field")?.focus();
      });
      search.setAttribute("aria-expanded", "false");
      const watch = link("", "https://streaming.unimatrix-01.dev/web/", "um-icon");
      watch.title = "Watch on Unimatrix-TV";
      watch.setAttribute("aria-label", watch.title);
      watch.innerHTML = icon("library", "Watch").innerHTML;
      const rail = node("nav", "um-networks");
      rail.setAttribute("aria-label", "Networks");
      orderNetworks(rail);
      top.append(menu, brand, primary, rail, watch, search, more);
      header.append(top, tools);
      document.body.append(header);
      document.body.classList.add("um-seerr-ready");
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          const wasMore = !tools.hidden;
          tools.hidden = true;
          more.setAttribute("aria-expanded", "false");
          if (wasMore) more.focus();
          const wasMenu = document.body.classList.contains("um-mobile-menu"),
            wasSearch = document.body.classList.contains("um-search-open");
          document.body.classList.remove("um-mobile-menu");
          if (location.pathname !== "/search") document.body.classList.remove("um-search-open");
          if (wasMenu) menu.focus();
          else if (wasSearch && location.pathname !== "/search") search.focus();
          menu.setAttribute("aria-expanded", "false");
          search.setAttribute(
            "aria-expanded",
            String(document.body.classList.contains("um-search-open")),
          );
        }
      });
      document.addEventListener("click", (e) => {
        if (!header.contains(e.target)) {
          tools.hidden = true;
          more.setAttribute("aria-expanded", "false");
        }
      });
    }
    if (location.pathname === "/" && catalog && !catalog.isConnected) {
      catalog = null;
      path = "";
    }
    const current = location.pathname + location.search;
    if (current !== path) {
      path = current;
      header.querySelector(".um-tools").hidden = true;
      document.body.classList.remove("um-mobile-menu");
      document.body.classList.toggle("um-search-open", location.pathname === "/search");
      header.querySelector(".um-menu-button").setAttribute("aria-expanded", "false");
      header.querySelectorAll("a").forEach((a) => {
        if (
          a.getAttribute("href") === current ||
          (a.getAttribute("href") === location.pathname && !isNetworkPage())
        )
          a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      renderCatalog(main);
    }
  }
  function status(x) {
    const n = x.mediaInfo?.status;
    return n === 5
      ? "Available"
      : n === 4
        ? "Partly available"
        : n === 3
          ? "Requested"
          : n === 2
            ? "Pending approval"
            : "Not requested";
  }
  function type(x) {
    return x.mediaType || (x.title ? "movie" : "tv");
  }
  function url(x) {
    return "/" + type(x) + "/" + x.id;
  }
  function title(x) {
    return x.title || x.name || "Untitled";
  }
  function image(x, w = "w780") {
    return x.backdropPath
      ? "https://image.tmdb.org/t/p/" + w + x.backdropPath
      : x.posterPath
        ? "https://image.tmdb.org/t/p/w500" + x.posterPath
        : "/unimatrix-theme/logo.png";
  }
  function meta(x) {
    return (
      (x.releaseDate || x.firstAirDate || "").slice(0, 4) +
      " · " +
      (type(x) === "movie" ? "Movie" : "Series") +
      (x.voteAverage ? " · " + x.voteAverage.toFixed(1) + "/10" : "")
    );
  }
  function renderFeature(hero) {
    const x = items[index],
      generation = ++featureGeneration;
    if (!x) return;
    hero.setAttribute("aria-label", "Featured: " + title(x));
    const art = node("img", "um-hero-art");
    art.alt = "";
    art.style.opacity = "0";
    art.decoding = "async";
    let artTimer;
    const commit = (ok) => {
      clearTimeout(artTimer);
      if (generation !== featureGeneration) return;
      const previous = [...hero.querySelectorAll(".um-hero-art")];
      hero.classList.toggle("um-art-fallback", !ok);
      if (ok) {
        hero.prepend(art);
        requestAnimationFrame(() => (art.style.opacity = "1"));
      }
      previous.forEach((old) => {
        old.style.opacity = "0";
        setTimeout(() => old.remove(), 700);
      });
      finishPending();
    };
    art.onload = () => commit(true);
    art.onerror = () => commit(false);
    artTimer = setTimeout(() => commit(false), 6000);
    art.src = image(x, matchMedia("(max-width:600px)").matches ? "w780" : "w1280");

    const old = $(".um-hero-copy", hero);
    if (old) old.remove();
    const copy = node("div", "um-hero-copy um-catalog-enter");
    copy.append(
      node("div", "um-eyebrow", featuredLabel),
      node("h1", null, title(x)),
      node("div", "um-meta", meta(x)),
      node("p", null, x.overview || ""),
      link("View title", url(x), "um-action"),
      node("div", "um-hero-status", status(x)),
    );
    hero.append(copy);
    hero.classList.toggle("um-art-fallback", !hero.querySelector(".um-hero-art"));
    const dots = $(".um-dots", hero);
    if (!dots.children.length)
      items.forEach((m, i) => {
        const b = node("button");
        b.setAttribute("aria-label", "Feature " + title(m));
        b.setAttribute("aria-pressed", String(i === index));
        b.addEventListener("click", () => {
          index = i;
          renderFeature(hero);
        });
        dots.append(b);
      });
    [...dots.children].forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
  }
  function makeHero() {
    const hero = node("section", "um-hero");
    hero.setAttribute("aria-roledescription", "carousel");
    hero.append(node("div", "um-dots"));
    const step = (d) => {
      index = (index + d + items.length) % items.length;
      renderFeature(hero);
    };
    const prev = icon("left", "Previous featured title", () => step(-1));
    const next = icon("right", "Next featured title", () => step(1));
    prev.classList.add("um-feature-step", "prev");
    next.classList.add("um-feature-step", "next");
    hero.append(prev, next);
    hero.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    });
    let start;
    hero.addEventListener(
      "touchstart",
      (e) => {
        start = [e.touches[0].clientX, e.touches[0].clientY];
      },
      { passive: true },
    );
    hero.addEventListener(
      "touchend",
      (e) => {
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start[0],
          dy = e.changedTouches[0].clientY - start[1];
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
        start = null;
      },
      { passive: true },
    );
    renderFeature(hero);
    return hero;
  }
  function shelf(name, list, href) {
    if (!list.length) return null;
    const section = node("section", "um-shelf");
    const head = node("div", "um-shelf-heading");
    const heading = node("h2", null, name);
    const rail = node("div", "um-rail");
    const actions = node("div", "um-shelf-actions");
    actions.append(
      icon("left", "Previous " + name, () =>
        rail.scrollBy({
          left: -rail.clientWidth * 0.8,
          behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth",
        }),
      ),
      icon("right", "Next " + name, () =>
        rail.scrollBy({
          left: rail.clientWidth * 0.8,
          behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth",
        }),
      ),
    );
    head.append(heading, actions, link("See all", href));
    section.append(head, rail);
    list.slice(0, 16).forEach((x) => {
      const a = link("", url(x), "um-tile");
      a.setAttribute("aria-label", title(x) + ", " + status(x));
      const img = node("img");
      img.alt = "";
      img.onerror = () => {
        img.onerror = null;
        img.src = "/unimatrix-theme/logo.png";
        img.classList.add("um-image-fallback");
      };
      img.loading = "lazy";
      img.decoding = "async";
      img.src = image(x);
      const copy = node("div", "um-tile-copy");
      copy.append(node("h3", null, title(x)), node("p", null, meta(x)));
      a.append(img, copy);
      if (status(x) !== "Not requested") a.append(node("span", "um-status", status(x)));
      rail.append(a);
    });
    return section;
  }
  async function renderCatalog(main) {
    loadController?.abort();
    loadController = new AbortController();
    const signal = loadController.signal;
    catalog?.remove();
    catalog = null;
    original.forEach((e) => {
      e.hidden = false;
    });
    original = [];
    document.body.classList.remove("um-catalog-active");
    if (isNetworkPage()) {
      renderNetworks(main);
      return;
    }
    if (location.pathname !== "/") finishPending();
    if (location.pathname !== "/") return;
    const host = $(".max-w-8xl", main);
    if (!host) return;
    // Hide only discovery content; native account/search/dialogs remain active.
    original = [];
    document.body.classList.add("um-catalog-active");
    catalog = node("div", "um-catalog");
    catalog.append(node("div", "um-loading"));
    main.prepend(catalog);
    let responded = 0;
    try {
      const definitions = [
        ["Trending", "trending", "/discover/trending"],
        ["Popular movies", "movies", "/discover/movies"],
        ["Popular series", "tv", "/discover/tv"],
      ];
      const tasks = definitions.map(([name, key, href]) =>
        api("/discover/" + key, signal).then((data) => {
          responded++;
          return { name, key, href, data };
        }),
      );
      const populated = tasks.map((t) =>
        t.then((r) => {
          if (!r.data.results?.length) throw new Error("No titles");
          return r;
        }),
      );
      const alternative = Promise.any(populated.slice(1));
      alternative.catch(() => {});
      const preferred = populated[0].catch(() => alternative);
      const first = await Promise.race([
        preferred,
        new Promise((resolve) => setTimeout(resolve, 800)).then(() =>
          alternative.catch(() => preferred),
        ),
      ]);
      if (signal.aborted) return;
      const allItems = first.data.results || [];
      items = allItems
        .filter((x) => x.backdropPath && ["movie", "tv"].includes(type(x)))
        .slice(0, 5);
      if (!items.length)
        items = allItems.filter((x) => ["movie", "tv"].includes(type(x))).slice(0, 5);
      featuredLabel = first.name === "Trending" ? "Trending now" : first.name;
      index = 0;
      catalog.replaceChildren();
      if (items.length) catalog.append(makeHero());
      else finishPending();
      const slots = definitions.map(([name]) => {
        const section = node("section", "um-shelf um-shelf-placeholder");
        section.setAttribute("aria-label", "Loading " + name);
        const heading = node("div", "um-shelf-heading");
        heading.append(node("h2", null, name));
        const rail = node("div", "um-rail");
        for (let i = 0; i < 4; i++) {
          const card = node("div", "um-tile");
          card.append(node("div", "um-placeholder-art"), node("div", "um-placeholder-copy"));
          rail.append(card);
        }
        section.append(heading, rail);
        catalog.append(section);
        return section;
      });
      tasks.forEach((task, i) =>
        task
          .then((r) => {
            if (signal.aborted) return;
            const row = shelf(r.name, r.data.results || [], r.href);
            if (row) slots[i].replaceWith(row);
            else {
              slots[i].className = "um-shelf";
              slots[i].replaceChildren(node("div", "um-empty", "No titles found."));
            }
          })
          .catch(() => {
            if (signal.aborted) return;
            slots[i].className = "um-shelf";
            const notice = node("div", "um-empty", definitions[i][0] + " could not load. ");
            const retry = node("button", "um-retry", "Retry");
            retry.addEventListener("click", () => renderCatalog(main));
            notice.append(retry);
            slots[i].replaceChildren(notice);
          }),
      );
      catalog.classList.add("um-catalog-enter");
      await Promise.allSettled(tasks);
      if (signal.aborted) return;
      const requests = await api("/request?take=12&sort=added&filter=all", signal).catch(() => ({
        results: [],
      }));
      const reqItems = await Promise.all(
        (requests.results || []).slice(0, 10).map(async (r) => {
          try {
            const d = await api("/" + r.media.mediaType + "/" + r.media.tmdbId, signal);
            return { ...d, mediaType: r.media.mediaType };
          } catch {
            return null;
          }
        }),
      );
      if (signal.aborted) return;
      const recent = shelf(
        "Recent requests",
        reqItems.filter((x) => x?.digitalReleaseEligible === true),
        "/requests",
      );
      if (recent) catalog.append(recent);
    } catch (e) {
      if (signal.aborted) return;
      finishPending();
      document.body.classList.remove("um-catalog-active");
      original.forEach((e) => (e.hidden = false));
      original = [];
      catalog.className = "um-discovery-notice";
      catalog.setAttribute("role", "alert");
      catalog.replaceChildren(
        node("p", null, responded ? "No discovery titles found." : "Discovery is unavailable."),
      );
      const retry = node("button", "um-retry", "Retry");
      retry.addEventListener("click", () => renderCatalog(main));
      catalog.append(retry);
    }
  }
  const routeChanged = () => {
    retireRoute();
    clearTimeout(routeTimer);
    routeTimer = setTimeout(setup, 0);
  };
  for (const method of ["pushState", "replaceState"]) {
    const originalHistory = history[method];
    history[method] = function (...args) {
      const result = originalHistory.apply(this, args);
      routeChanged();
      return result;
    };
  }
  window.addEventListener("popstate", routeChanged);
  const observer = new MutationObserver(() => {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(setup, 50);
  });
  function start() {
    setTimeout(() => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setup();
    }, 350);
  }
  if (document.readyState !== "loading") start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();

/* Request activity. Stable nodes preserve disclosures, selection, and focus during polling. */
(() => {
  "use strict";
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const put = (n, text) => {
    if (n.textContent !== String(text)) n.textContent = String(text);
  };
  const bytes = (n) => {
    if (n == null) return "—";
    if (n < 1000) return Math.round(n) + " B";
    const units = ["kB", "MB", "GB", "TB"];
    let i = -1;
    do {
      n /= 1000;
      i++;
    } while (n >= 1000 && i < 3);
    return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + " " + units[i];
  };
  const date = (v) => {
    const d = new Date(v);
    return Number.isFinite(d.valueOf())
      ? d.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "—";
  };
  const duration = (n) =>
    n == null
      ? "—"
      : n < 60
        ? "<1 min"
        : n < 3600
          ? Math.ceil(n / 60) + " min"
          : Math.floor(n / 3600) + "h " + Math.ceil((n % 3600) / 60) + "m";
  const svg = {
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    warning:
      '<path d="M10.3 4.2a2 2 0 0 1 3.4 0l8 13.8A2 2 0 0 1 20 21H4a2 2 0 0 1-1.7-3z"/><path d="M12 9v4m0 3v.1"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  };
  function action(text, fn, cls = "um-request-button") {
    const b = make("button", cls, text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }
  function iconButton(name, label, fn) {
    const b = action("", fn, "um-request-icon");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
      svg[name] +
      "</svg>";
    return b;
  }
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem("um-request-disclosures") || "{}");
  } catch {}
  function save(id, key, value) {
    saved[id] ??= {};
    saved[id][key] = value;
    try {
      sessionStorage.setItem("um-request-disclosures", JSON.stringify(saved));
    } catch {}
  }
  function disclosure(id, key, label, cls) {
    const d = make("details", cls);
    d.dataset.disclosure = key;
    d.append(make("summary", null, label));
    d.open = !!saved[id]?.[key];
    d.addEventListener("toggle", () => save(id, key, d.open));
    return d;
  }
  const shortWarning = (w) =>
    w
      .replace(
        "Indexers unavailable due to failures for more than 6 hours: ",
        "Indexer unavailable: ",
      )
      .replace("All indexers are unavailable due to failures", "Indexers unavailable");
  let issueDialog,
    issueDialogTitle,
    issueDialogBody,
    serviceIssues,
    serviceIssueText,
    serviceIssueButton,
    serviceSignature = "";
  function openPanel(title, body) {
    if (!issueDialog) {
      issueDialog = make("dialog", "um-request-issue-dialog");
      issueDialog.setAttribute("role", "dialog");
      issueDialog.setAttribute("aria-labelledby", "um-request-issue-title");
      const header = make("div", "um-request-issue-header");
      issueDialogTitle = make("h2", null, title);
      issueDialogTitle.id = "um-request-issue-title";
      header.append(
        issueDialogTitle,
        iconButton("close", "Close", () => issueDialog.close()),
      );
      issueDialogBody = make("div", "um-request-issue-content");
      issueDialog.append(header, issueDialogBody);
      issueDialog.addEventListener("click", (e) => {
        if (e.target === issueDialog) {
          const b = issueDialog.getBoundingClientRect();
          if (
            e.clientX < b.left ||
            e.clientX > b.right ||
            e.clientY < b.top ||
            e.clientY > b.bottom
          )
            issueDialog.close();
        }
      });
      document.body.append(issueDialog);
    }
    put(issueDialogTitle, title);
    issueDialogBody.replaceChildren(body);
    if (!issueDialog.open) issueDialog.showModal();
  }
  function warningList(warnings) {
    const list = make("ul", "um-request-issue-list");
    warnings.forEach((w) => {
      const li = make("li");
      li.append(make("span", "um-request-issue-marker", "!"), make("p", null, shortWarning(w)));
      list.append(li);
    });
    return list;
  }
  function serviceChrome(host) {
    const warnings = [...new Set(records.flatMap((r) => r.pipeline?.warnings || []))];
    if (!serviceIssues?.isConnected) {
      serviceIssues = make("section", "um-request-service-issues");
      serviceIssues.setAttribute("aria-label", "Service issues");
      const marker = make("span", "um-request-issue-marker", "!");
      serviceIssueText = make("p");
      serviceIssueButton = action(
        "View issues",
        () =>
          openPanel(
            "Service issues",
            warningList([...new Set(records.flatMap((r) => r.pipeline?.warnings || []))]),
          ),
        "um-request-issue-link",
      );
      serviceIssues.append(marker, serviceIssueText, serviceIssueButton);
      host.querySelector(".um-request-toolbar")?.after(serviceIssues);
    }
    serviceIssues.hidden = !warnings.length;
    const signature = JSON.stringify(warnings);
    if (signature !== serviceSignature) {
      serviceSignature = signature;
      put(
        serviceIssueText,
        warnings.length === 1 ? shortWarning(warnings[0]) : warnings.length + " service issues",
      );
      serviceIssueText.title = warnings.map(shortWarning).join("\n");
      if (issueDialog?.open && issueDialogTitle.textContent === "Service issues")
        issueDialogBody.replaceChildren(
          warnings.length ? warningList(warnings) : make("p", null, "No service issues"),
        );
    }
  }
  let records = [],
    payload,
    url = "/api/v1/request?take=10&skip=0&filter=all&sort=added",
    lastChecked,
    inflight = false,
    active = false,
    timer,
    observerTimer,
    pageRefresh;
  const views = new WeakMap(),
    checks = new Map(),
    busy = new Set();
  let latestRequest = 0;
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, address, ...args) {
    if (method.toUpperCase() === "GET" && /^\/api\/v1\/request(?:\?|$)/.test(String(address))) {
      const sequence = ++latestRequest;
      this.addEventListener(
        "load",
        () => {
          if (
            location.pathname !== "/requests" ||
            this.status !== 200 ||
            sequence !== latestRequest
          )
            return;
          try {
            const p = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            if (Array.isArray(p.results)) {
              url = String(address);
              receive(p);
            }
          } catch {}
        },
        { once: true },
      );
    }
    return nativeOpen.call(this, method, address, ...args);
  };
  function receive(p) {
    payload = p;
    records = p.results;
    lastChecked = new Date();
    draw();
  }
  function cardFor(r, claimed = new Set()) {
    const href = "/" + r.type + "/" + r.media.tmdbId,
      cards = [
        ...new Set(
          [...document.querySelectorAll("main a[href]")]
            .filter((a) => a.getAttribute("href") === href && a.textContent.trim())
            .map((a) => a.closest("div.rounded-xl"))
            .filter(Boolean),
        ),
      ].filter((c) => !claimed.has(c));
    return (
      cards.find((c) => c.dataset.requestId === String(r.id)) ||
      cards.find((c) => !c.dataset.requestId) ||
      cards[0]
    );
  }
  function init(card, r) {
    const body = card.children[1];
    if (!body) return null;
    body.classList.add("um-request-native-body");
    body.children[0]?.classList.add("um-request-identity");
    body.children[1]?.classList.add("um-request-native-fields");
    const actions = [...card.children].find((c) => c.classList.contains("space-y-2"));
    if (actions) {
      actions.classList.add("um-request-native-actions");
      actions.id = "um-request-actions-" + r.id;
    }
    const meta = make("p", "um-request-meta");
    body.children[0]?.append(meta);
    const panel = make("section", "um-request-pipeline");
    const state = make("div", "um-request-state");
    const stateLabel = make("h3");
    state.append(make("span", "um-request-state-dot"), stateLabel);
    const download = make("div", "um-request-download");
    const progressTitle = make("div", "um-request-progress-title"),
      percent = make("strong"),
      size = make("span");
    progressTitle.append(percent, size);
    const progress = make("div", "um-request-progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Download progress");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const fill = make("div");
    progress.append(fill);
    const stats = make("div", "um-request-transfer-stats");
    const metrics = {};
    for (const [key, label] of [
      ["speed", "Speed"],
      ["eta", "Time left"],
      ["seeds", "Seeds"],
      ["peers", "Peers"],
    ]) {
      const cell = make("div", "um-request-stat"),
        value = make("strong");
      cell.append(make("span", null, label), value);
      stats.append(cell);
      metrics[key] = { cell, value };
    }
    download.append(progressTitle, progress, stats);
    const track = make("ol", "um-request-track");
    track.setAttribute("aria-label", "Request stages");
    ["Approval", "Find release", "Download", "Import", "Ready"].forEach((text) =>
      track.append(make("li", null, text)),
    );
    const footer = make("div", "um-request-controls");
    const why = make("div", "um-request-issue");
    const reason = make("p"),
      fullReason = make("p");
    const reasonDetails = action(
      "Details",
      () => openPanel("Request issue", fullReason),
      "um-request-issue-link",
    );
    why.append(make("span", "um-request-issue-marker", "!"), reason, reasonDetails);
    const activityBody = make("div");
    const activity = action(
      "Activity",
      () => openPanel("Request activity", activityBody),
      "um-request-activity-button",
    );
    const diagnostic = make("div", "um-request-diagnostic");
    diagnostic.id = "um-request-diagnostic-" + r.id;
    diagnostic.hidden = !saved[r.id]?.sources;
    const check = action("Check sources", async () => {
      if (!diagnostic.hidden) {
        diagnostic.hidden = true;
        save(r.id, "sources", false);
        updateCheck();
        return;
      }
      diagnostic.hidden = false;
      save(r.id, "sources", true);
      updateCheck();
      await diagnose(r, view);
    });
    const updateCheck = () => {
      put(
        check,
        busy.has(r.id) ? "Checking…" : diagnostic.hidden ? "Check sources" : "Hide results",
      );
      check.disabled = busy.has(r.id);
      check.setAttribute("aria-expanded", String(!diagnostic.hidden));
    };
    check.setAttribute("aria-controls", diagnostic.id);
    const watch = make("a", "um-request-button um-request-watch", "Watch");
    let manage;
    if (actions) {
      manage = iconButton("more", "Manage request", () => {
        const opened = card.classList.toggle("um-request-management-open");
        save(r.id, "manage", opened);
        manage.setAttribute("aria-expanded", String(opened));
      });
      manage.setAttribute("aria-controls", actions.id);
      manage.setAttribute("aria-expanded", String(!!saved[r.id]?.manage));
      card.classList.toggle("um-request-management-open", !!saved[r.id]?.manage);
    }
    footer.append(watch, check, activity);
    if (manage) footer.append(manage);
    panel.append(state, download, track, why, footer, diagnostic);
    card.append(panel);
    const view = {
      meta,
      panel,
      stateLabel,
      download,
      progress,
      fill,
      percent,
      size,
      stats,
      metrics,
      track,
      activity,
      activityBody,
      why,
      reason,
      fullReason,
      reasonDetails,
      footer,
      check,
      watch,
      diagnostic,
      manage,
      updateCheck,
      request: r,
      signature: "",
      diagnosticSignature: "",
    };
    views.set(card, view);
    return view;
  }
  function diagnostic(d, view) {
    const signature = JSON.stringify(d);
    if (view.diagnosticSignature === signature) return;
    view.diagnosticSignature = signature;
    const region = view.diagnostic;
    region.replaceChildren();
    const headline = make("div", "um-request-source-stats");
    for (const [label, n] of [
      ["Found", d.total],
      ["Passed", d.accepted],
      ["Rejected", d.rejected],
    ]) {
      const cell = make("div");
      cell.append(make("strong", null, n), make("span", null, label));
      headline.append(cell);
    }
    region.append(headline);
    if (!d.total) region.append(make("p", "um-request-check-error", "No releases found"));
    const reasons = make("ul", "um-request-rejections");
    d.reasons.forEach((x) => {
      const li = make("li");
      li.append(make("span", null, x.reason), make("span", null, x.count));
      reasons.append(li);
    });
    region.append(reasons);
    if (d.warnings.length) {
      const issues = make("div", "um-request-source-issues");
      issues.append(
        make("span", "um-request-issue-marker", "!"),
        make(
          "span",
          null,
          d.warnings.length === 1
            ? shortWarning(d.warnings[0])
            : d.warnings.length + " indexer issues",
        ),
      );
      if (d.warnings.length > 1)
        issues.append(
          action(
            "View issues",
            () => openPanel("Indexer issues", warningList(d.warnings)),
            "um-request-issue-link",
          ),
        );
      region.append(issues);
    }
    if (d.releases.length) {
      const list = disclosure(view.request.id, "releases", "Releases", "um-request-source-details");
      d.releases.forEach((x) => {
        const row = make("div", "um-request-release");
        row.append(
          make("strong", null, x.title),
          make(
            "p",
            null,
            x.source + " · " + x.quality + " · " + (x.approved ? "Passed" : "Rejected"),
          ),
        );
        x.reasons.forEach((why) => row.append(make("p", "um-request-muted", why)));
        list.append(row);
      });
      region.append(list);
    }
    const checked = make(
      "span",
      "um-request-source-time",
      date(d.checkedAt) + (d.scope === "Requested title" ? "" : " · " + d.scope),
    );
    checked.title = "Read-only source check; results cached for five minutes";
    region.append(checked);
  }
  async function diagnose(r, view) {
    if (busy.has(r.id)) return;
    busy.add(r.id);
    view.updateCheck();
    try {
      const response = await fetch("/api/v1/unimatrix/requests/" + r.id + "/diagnostics", {
          credentials: "same-origin",
          signal: AbortSignal.timeout(28000),
        }),
        d = await response.json();
      if (!response.ok) throw new Error(d.message || "Source check failed");
      checks.set(r.id, d);
      diagnostic(d, view);
    } catch (e) {
      view.diagnostic.replaceChildren(
        make(
          "p",
          "um-request-check-error",
          e.name === "TimeoutError" ? "Source check timed out" : e.message,
        ),
      );
    } finally {
      busy.delete(r.id);
      view.updateCheck();
    }
  }
  function update(card, r) {
    card.classList.add("um-request-card");
    card.dataset.requestId = r.id;
    const view = views.get(card) || init(card, r);
    if (!view) return;
    // Native React can reset class props without replacing the element.
    const body = card.children[1];
    body?.classList.add("um-request-native-body");
    body?.children[0]?.classList.add("um-request-identity");
    body?.children[1]?.classList.add("um-request-native-fields");
    view.request = r;
    const p = r.pipeline || {
      phase: "unknown",
      label: "Status unavailable",
      reason: "The download service could not be reached.",
      stage: null,
      tone: "warning",
      transfers: [],
      warnings: [],
    };
    card.dataset.phase = p.phase;
    card.dataset.tone = p.tone;
    put(view.stateLabel, p.label === "Updating library" ? "Adding to library" : p.label);
    [...view.track.children].forEach((li, i) => {
      li.className =
        p.phase === "available"
          ? "complete"
          : p.stage === null
            ? ""
            : i < p.stage
              ? "complete"
              : i === p.stage
                ? "current"
                : "";
      if (i === p.stage) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    const year = body?.children[0]?.children[1]?.querySelector("div")?.textContent.trim();
    const seasons = r.seasons?.length
      ? " · S" + r.seasons.map((x) => x.seasonNumber).join(", ")
      : "";
    put(
      view.meta,
      [year, r.is4k ? "4K" : r.profileName || "Requested quality"].filter(Boolean).join(" · ") +
        seasons,
    );
    view.meta.title =
      "Requested " +
      date(r.createdAt) +
      (r.requestedBy?.displayName ? " by " + r.requestedBy.displayName : "");
    const known = p.transfers.filter((t) => t.totalBytes > 0 && t.downloadedBytes !== null);
    view.download.hidden = !known.length;
    if (known.length) {
      const total = known.reduce((n, t) => n + t.totalBytes, 0),
        done = known.reduce((n, t) => n + t.downloadedBytes, 0),
        percent = (100 * done) / total;
      put(view.percent, percent.toFixed(1) + "%");
      put(view.size, bytes(done) + " / " + bytes(total));
      view.fill.style.width = Math.min(100, percent) + "%";
      view.progress.setAttribute("aria-valuenow", percent.toFixed(1));
      const values = p.transfers;
      const speeds = values.filter((t) => t.speedBytes != null),
        etas = values.filter((t) => t.etaSeconds != null),
        seeds = values.filter((t) => t.seeds != null),
        peers = values.filter((t) => t.peers != null);
      const clock = values[0].etaText?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/),
        seconds = clock
          ? Number(clock[1] || 0) * 86400 +
            Number(clock[2]) * 3600 +
            Number(clock[3]) * 60 +
            Number(clock[4])
          : null;
      const waiting = [
        "paused",
        "stalled",
        "queued",
        "download_error",
        "import_blocked",
        "client_unavailable",
      ].includes(p.phase);
      view.metrics.speed.cell.hidden = !speeds.length;
      put(
        view.metrics.speed.value,
        speeds.length ? bytes(speeds.reduce((n, t) => n + t.speedBytes, 0)) + "/s" : "—",
      );
      put(
        view.metrics.eta.value,
        waiting
          ? "—"
          : p.stage === 3
            ? "Complete"
            : duration(etas.length ? Math.max(...etas.map((t) => t.etaSeconds)) : seconds),
      );
      view.metrics.seeds.cell.hidden = !seeds.length;
      put(
        view.metrics.seeds.value,
        seeds.reduce((n, t) => n + t.seeds, 0),
      );
      view.metrics.peers.cell.hidden = !peers.length;
      put(
        view.metrics.peers.value,
        peers.reduce((n, t) => n + t.peers, 0),
      );
    }
    const blocker = [
      "request_failed",
      "not_connected",
      "unmonitored",
      "release_wait",
      "airing_wait",
      "download_failed",
      "untracked",
      "search_failed",
      "import_blocked",
      "download_error",
      "download_warning",
      "client_unavailable",
      "unknown",
      "stalled",
      "paused",
      "recovery_exhausted",
    ].includes(p.phase);
    view.why.hidden = !blocker;
    const compactReason = (p.reason || "").split(/(?<=\.)\s/)[0];
    put(view.reason, compactReason);
    put(view.fullReason, p.reason || compactReason);
    view.reasonDetails.hidden = (p.reason || "") === compactReason;
    view.check.hidden =
      ![
        "waiting",
        "searching",
        "recovering",
        "recovery_exhausted",
        "search_failed",
        "download_failed",
        "not_connected",
        "unmonitored",
        "release_wait",
        "airing_wait",
        "untracked",
      ].includes(p.phase) && view.diagnostic.hidden;
    view.watch.hidden = !(p.phase === "available" || p.partialAvailable);
    put(view.watch, p.partialAvailable ? "Watch episodes" : "Watch");
    const jfId = r.media?.[r.is4k ? "jellyfinMediaId4k" : "jellyfinMediaId"];
    view.watch.href =
      "https://streaming.unimatrix-01.dev/web/#/" +
      (jfId ? "details?id=" + encodeURIComponent(jfId) : "home");
    const activity = [
      p.transfers.find((t) => t.source)?.source,
      p.transfers.find((t) => t.quality)?.quality,
    ]
      .filter(Boolean)
      .join(" · ");
    const summary =
        activity +
        (p.episodes
          ? ` · ${p.episodes.available}/${p.episodes.aired} aired episodes imported`
          : ""),
      signature =
        summary +
        "|" +
        p.stage +
        "|" +
        JSON.stringify(p.recovery) +
        "|" +
        p.lastSearchAt +
        "|" +
        JSON.stringify(p.transfers.map((t) => [t.episode, t.percent]));
    if (view.signature !== signature) {
      view.signature = signature;
      view.activityBody.replaceChildren();
      view.activityBody.append(
        make(
          "p",
          "um-request-muted",
          "Requested " +
            date(r.createdAt) +
            (r.requestedBy?.displayName ? " · " + r.requestedBy.displayName : ""),
        ),
      );
      if (summary) view.activityBody.append(make("p", null, summary));
      if (p.recovery)
        view.activityBody.append(make("p", null, "Source retries · " + p.recovery.attempts));
      if (p.lastSearchAt)
        view.activityBody.append(
          make("p", "um-request-muted", "Last search " + date(p.lastSearchAt)),
        );
      if (p.transfers.length > 1)
        p.transfers.forEach((t) =>
          view.activityBody.append(
            make(
              "p",
              null,
              (t.episode || "Season pack") +
                " · " +
                (t.percent == null ? "—" : t.percent.toFixed(1) + "%"),
            ),
          ),
        );
    }
    if (checks.has(r.id)) diagnostic(checks.get(r.id), view);
    view.updateCheck();
  }
  function chrome(host) {
    const toolbar = host.querySelector(":scope > .mb-4.flex.flex-col");
    toolbar?.classList.add("um-request-toolbar");
    const title = toolbar?.querySelector("[data-testid=page-header]");
    if (title) {
      title.classList.add("um-request-page-title");
      title.setAttribute("aria-level", "1");
    }
    for (const [id, label] of [
      ["mediaType", "Type"],
      ["filter", "Status"],
      ["sort", "Sort"],
    ]) {
      const select = document.getElementById(id);
      if (!select) continue;
      const group = select.parentElement;
      group.classList.add("um-request-filter");
      select.setAttribute("aria-label", label);
      group.querySelector("span")?.setAttribute("hidden", "");
      if (id === "mediaType") select.options[0].textContent = "All titles";
      if (id === "filter") {
        const labels = {
          all: "All statuses",
          pending: "Awaiting approval",
          processing: "In progress",
          failed: "Request failed",
          available: "Ready to watch",
          deleted: "Removed",
        };
        for (const option of select.options) {
          option.hidden = !labels[option.value];
          if (labels[option.value]) option.textContent = labels[option.value];
        }
      }
    }
    const sortButton = document.getElementById("sort")?.parentElement.querySelector("button");
    if (sortButton) {
      sortButton.title = "Reverse sort order";
      sortButton.setAttribute("aria-label", "Reverse sort order");
    }
    if (!pageRefresh?.isConnected) {
      pageRefresh = iconButton("refresh", "Refresh statuses", poll);
      toolbar?.querySelector(":scope > div:last-child")?.append(pageRefresh);
    }
    pageRefresh.disabled = inflight;
    pageRefresh.classList.toggle("um-refreshing", inflight);
    pageRefresh.title = "Refresh · updated " + date(lastChecked);
    const pager = host.querySelector("[aria-label=Pagination]");
    if (pager) {
      pager.classList.add("um-request-pagination");
      pager.hidden = (payload?.pageInfo?.pages || 1) <= 1;
    }
    const empty = [...host.querySelectorAll("p,span,div")].find(
      (n) => !n.children.length && n.textContent.trim() === "No results.",
    );
    if (empty)
      put(
        empty,
        document.getElementById("mediaType")?.value === "all" &&
          document.getElementById("filter")?.value === "all"
          ? "No requests yet"
          : "No matching requests",
      );
  }
  function draw() {
    if (location.pathname !== "/requests" || !lastChecked) return;
    const host = document.querySelector("main .max-w-8xl");
    if (!host) return;
    document.body.classList.add("um-requests-page");
    chrome(host);
    serviceChrome(host);
    const claimed = new Set();
    records.forEach((r) => {
      const card = cardFor(r, claimed);
      if (card) {
        claimed.add(card);
        update(card, r);
      }
    });
  }
  async function poll() {
    if (inflight || !active || document.hidden || !lastChecked) return;
    inflight = true;
    const sequence = latestRequest,
      address = url;
    if (pageRefresh) {
      pageRefresh.disabled = true;
      pageRefresh.classList.add("um-refreshing");
    }
    try {
      const response = await fetch(address, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(16000),
      });
      if (!response.ok) throw new Error();
      const p = await response.json();
      if (location.pathname === "/requests" && sequence === latestRequest && url === address)
        receive(p);
    } catch {
      if (pageRefresh) {
        pageRefresh.classList.add("um-request-stale");
        pageRefresh.title = "Update failed · showing last known status";
      }
    } finally {
      inflight = false;
      if (pageRefresh) {
        pageRefresh.disabled = false;
        pageRefresh.classList.remove("um-refreshing");
      }
    }
  }
  function route() {
    const current = location.pathname === "/requests";
    if (current && !active) {
      active = true;
      timer = setInterval(poll, 15000);
    }
    if (!current && active) {
      if (issueDialog?.open) issueDialog.close();
      active = false;
      clearInterval(timer);
      document.body.classList.remove("um-requests-page");
      records = [];
      lastChecked = null;
      pageRefresh = null;
      checks.clear();
      latestRequest++;
    }
    if (current && lastChecked) {
      const missing = records.some((r) => {
        const c = cardFor(r);
        return (c && !views.has(c)) || (c && !c.classList.contains("um-request-card"));
      });
      if (
        missing ||
        !document.querySelector(".um-request-page-title") ||
        !document.getElementById("filter")?.parentElement.classList.contains("um-request-filter")
      )
        draw();
    }
  }
  const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(route, 100);
  });
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    route();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
