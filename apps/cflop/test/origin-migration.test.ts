import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMigrationUrl, handleOriginMigration, importMigration } from "@/lib/origin-migration";

const oldLocation = new URL("https://cube.unimatrix-01.dev/learn?set=pll#case");

function fragment(entries: unknown): string {
  return "#cflop-migrate=" + encodeURIComponent(JSON.stringify({ version: 1, hash: "", entries }));
}

describe("browser origin migration", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("transfers all storage families, preferring current keys, and preserves the destination", () => {
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    localStorage.setItem("cflop:progress:oll", '{"oll-2":"learning"}');
    localStorage.setItem("cflop:pool:pll", '{"pll-ua":false}');
    localStorage.setItem("cflop:pool-mode:pll", "only-learned");
    localStorage.setItem("cflop:preview-mode:drill", "hidden");
    localStorage.setItem("cflop:algorithm-set", "pll");
    localStorage.setItem("unrelated-secret", "do not transfer");
    const target = new URL(createMigrationUrl(oldLocation, localStorage));
    expect(target.origin + target.pathname + target.search).toBe("https://cflop.us/learn?set=pll");
    expect(decodeURIComponent(target.hash)).not.toContain("unrelated-secret");
    expect(localStorage.getItem("cube-trainer:progress:oll")).not.toBeNull();
    localStorage.clear();
    expect(importMigration(target.hash, localStorage)).toBe("imported");
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-2":"learning"}');
    expect(localStorage.getItem("cflop:pool:pll")).toBe('{"pll-ua":false}');
    expect(localStorage.getItem("cflop:pool-mode:pll")).toBe("only-learned");
    expect(localStorage.getItem("cflop:preview-mode:drill")).toBe("hidden");
    expect(localStorage.getItem("cflop:algorithm-set")).toBe("pll");
  });

  it.each(["cflop:preview-mode:learn", "cube-trainer:progress:oll"])(
    "never imports anything if destination contains %s, even if malformed",
    (key) => {
      localStorage.setItem(key, "malformed-but-existing");
      expect(
        importMigration(fragment([["progress:pll", '{"pll-ua":"known"}']]), localStorage),
      ).toBe("existing");
      expect(localStorage.getItem("cflop:progress:pll")).toBeNull();
      expect(localStorage.getItem(key)).toBe("malformed-but-existing");
    },
  );

  it.each(
    [
      [["unrelated-secret", "injected"]],
      [["progress:oll", '{"oll-1":"injected"}']],
      [["pool:pll", '{"pll-ua":"false"}']],
      [["preview-mode:drill", "unknown"]],
      [["progress:oll", "not json"]],
      [
        ["algorithm-set", "pll"],
        ["algorithm-set", "oll"],
      ],
    ].map((entries) => ({ entries })),
  )("rejects malformed payloads without partial writes: %j", ({ entries }) => {
    expect(importMigration(fragment(entries), localStorage)).toBe("invalid");
    expect(localStorage.length).toBe(0);
  });

  it("rejects invalid encoding and oversized payloads", () => {
    expect(importMigration("#cflop-migrate=%xx", localStorage)).toBe("invalid");
    expect(importMigration("#cflop-migrate=" + "x".repeat(33_000), localStorage)).toBe("invalid");
  });

  it("ignores corrupt source data without deleting it", () => {
    localStorage.setItem("cflop:progress:oll", "broken");
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    expect(createMigrationUrl(oldLocation, localStorage)).toBe(
      "https://cflop.us/learn?set=pll#case",
    );
    expect(localStorage.getItem("cflop:progress:oll")).toBe("broken");
  });

  it("cannot redirect to another origin through a double-slash path", () => {
    const target = new URL(
      createMigrationUrl(new URL("https://cube.unimatrix-01.dev//evil.test/x"), localStorage),
    );
    expect(target.origin).toBe("https://cflop.us");
    expect(target.pathname).toBe("//evil.test/x");
  });

  it("rolls back a partial import if storage runs out of space", () => {
    const original = Storage.prototype.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "cflop:algorithm-set")
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      original(key, value);
    });
    expect(() =>
      importMigration(
        fragment([
          ["progress:oll", '{"oll-1":"known"}'],
          ["algorithm-set", "pll"],
        ]),
        localStorage,
      ),
    ).toThrow();
    expect(localStorage.length).toBe(0);
  });

  it("refuses an unimportable source fragment before navigating away", () => {
    localStorage.setItem("cflop:progress:oll", '{"oll-1":"known"}');
    const location = new URL(oldLocation);
    location.hash = "x".repeat(2049);
    expect(() => createMigrationUrl(location, localStorage)).toThrow();
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-1":"known"}');
  });

  it("keeps destination cleanup on the same origin for double-slash paths", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://cflop.us//evil.test/path" + fragment([]) },
      localStorage,
      history: { state: null, replaceState },
    });
    try {
      expect(handleOriginMigration(document.createElement("div"))).toBe(false);
      expect(replaceState).toHaveBeenCalledWith(null, "", "https://cflop.us//evil.test/path");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function at(href: string) {
    const replace = vi.fn();
    const reload = vi.fn();
    const replaceState = vi.fn();
    const storage = localStorage;
    const session = sessionStorage;
    vi.stubGlobal("window", {
      location: { href, origin: new URL(href).origin, replace, reload },
      localStorage: storage,
      sessionStorage: session,
      history: { state: null, replaceState },
    });
    return { replace, reload, replaceState };
  }

  function markedUrl(href: string): string {
    const target = new URL(href);
    target.search = "__cflop_migrate=1" + (target.search ? "&" + target.search.slice(1) : "");
    return target.href;
  }

  function startProbe(href = "https://cflop.us/learn?set=pll#case") {
    const navigation = at(markedUrl(href));
    expect(handleOriginMigration(document.createElement("div"))).toBe(true);
    return new URL(navigation.replace.mock.calls[0]![0] as string);
  }

  function bridgeResult(bridge: URL) {
    const navigation = at(bridge.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(true);
    return new URL(navigation.replace.mock.calls[0]![0] as string);
  }

  it("checks both old origins before initializing an empty destination, then stops probing", () => {
    const original = "https://cflop.us/learn?set=pll#case";
    const first = startProbe(original);
    expect(first.origin + first.pathname).toBe("https://cflop.unimatrix-01.dev/origin-migration");
    expect(first.searchParams.get("attempt")).toMatch(/^[a-f0-9-]{36}$/);
    expect(localStorage.length).toBe(0);
    const firstResult = bridgeResult(first);
    const afterFirst = at(firstResult.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(true);
    const second = new URL(afterFirst.replace.mock.calls[0]![0] as string);
    expect(second.origin + second.pathname).toBe("https://cube.unimatrix-01.dev/origin-migration");
    const secondResult = bridgeResult(second);
    const afterSecond = at(secondResult.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    expect(afterSecond.replaceState).toHaveBeenCalledWith(null, "", original);
    expect(sessionStorage.length).toBe(0);
    at(original);
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("imports bridge progress before rendering and leaves its source copy intact", () => {
    const bridge = startProbe();
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    const result = bridgeResult(bridge);
    expect(localStorage.getItem("cube-trainer:progress:oll")).toBe('{"oll-1":"known"}');
    localStorage.clear();
    const navigation = at(result.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-1":"known"}');
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://cflop.us/learn?set=pll#case",
    );
    vi.unstubAllGlobals();
  });

  it("keeps destination values if another tab writes while a bridge is open", () => {
    const bridge = startProbe();
    localStorage.setItem("cflop:progress:oll", '{"oll-1":"known"}');
    const result = bridgeResult(bridge);
    localStorage.setItem("cflop:progress:oll", '{"oll-2":"known"}');
    at(result.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-2":"known"}');
    vi.unstubAllGlobals();
  });

  it("does not probe either old origin when destination already has data", () => {
    localStorage.setItem("cube-trainer:algorithm-set", "malformed");
    const navigation = at("https://cflop.us/drill?__cflop_migrate=1");
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.replaceState).toHaveBeenCalledWith(null, "", "https://cflop.us/drill");
    vi.unstubAllGlobals();
  });

  it("rejects unsolicited bridge results without importing their data", () => {
    const bridge = startProbe();
    localStorage.setItem("cflop:progress:oll", '{"oll-1":"known"}');
    const result = bridgeResult(bridge);
    localStorage.clear();
    sessionStorage.clear();
    at(result.href);
    const root = document.createElement("div");
    expect(handleOriginMigration(root)).toBe(true);
    expect(root.textContent).toContain("Your saved progress could not be transferred");
    expect(localStorage.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it("does not turn an interrupted probe into a navigation loop", () => {
    startProbe();
    const navigation = at("https://cflop.us/learn?__cflop_migrate=1&set=pll#case");
    const root = document.createElement("div");
    const render = vi.fn();
    expect(handleOriginMigration(root, render)).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
    root.querySelector("a")!.click();
    expect(render).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
    expect(navigation.reload).not.toHaveBeenCalled();
    root.querySelector("button")!.click();
    expect(navigation.replace).toHaveBeenCalledWith(
      expect.stringContaining("/origin-migration?attempt="),
    );
    vi.unstubAllGlobals();
  });

  it("offers a usable skip if session storage is unavailable", () => {
    at("https://cflop.us/drill?__cflop_migrate=1&set=pll#case");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const root = document.createElement("div");
    const render = vi.fn();
    expect(handleOriginMigration(root, render)).toBe(true);
    root.querySelector("a")!.click();
    expect(render).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("retains a retryable pending source when the completion marker cannot be written", () => {
    const firstResult = bridgeResult(startProbe());
    const afterFirst = at(firstResult.href);
    expect(handleOriginMigration(document.createElement("div"))).toBe(true);
    const second = new URL(afterFirst.replace.mock.calls[0]![0] as string);
    const secondResult = bridgeResult(second);
    const navigation = at(secondResult.href);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const root = document.createElement("div");
    expect(handleOriginMigration(root)).toBe(true);
    expect(sessionStorage.getItem("cflop:origin-migration-pending:v1")).not.toBeNull();
    root.querySelector("button")!.click();
    expect(navigation.replace).toHaveBeenCalledWith(second.href);
    vi.unstubAllGlobals();
  });

  it("retains the previous source if starting the next source fails", () => {
    const first = startProbe();
    const firstResult = bridgeResult(first);
    const navigation = at(firstResult.href);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const root = document.createElement("div");
    expect(handleOriginMigration(root)).toBe(true);
    root.querySelector("button")!.click();
    expect(navigation.replace).toHaveBeenCalledWith(first.href);
    vi.unstubAllGlobals();
  });

  it("does not read storage or visit old origins for a direct destination visit", () => {
    sessionStorage.setItem("cflop:origin-migration-pending:v1", "stale pending state");
    const navigation = at("https://cflop.us/learn?set=pll#case");
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.replaceState).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("strips the marker without reencoding other query parameters or fragments", () => {
    const bridge = startProbe("https://cflop.us/learn?q=a%20b&x=one+two&x=three#case");
    const probe = JSON.parse(decodeURIComponent(bridge.hash.slice("#cflop-probe=".length))) as {
      returnHref: string;
    };
    expect(probe.returnHref).toBe("https://cflop.us/learn?q=a%20b&x=one+two&x=three#case");
    vi.unstubAllGlobals();
  });

  it.each(["%xx", encodeURIComponent(JSON.stringify({ unexpected: true }))])(
    "retries the trusted pending bridge after a malformed callback %s",
    (badFragment) => {
      const bridge = startProbe();
      const navigation = at("https://cflop.us/learn?set=pll#cflop-probe-result=" + badFragment);
      const root = document.createElement("div");
      expect(handleOriginMigration(root)).toBe(true);
      root.querySelector("button")!.click();
      expect(navigation.replace).toHaveBeenCalledWith(bridge.href);
      expect(navigation.reload).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    },
  );

  it("ignores a mismatched callback return URL when choosing Retry and Continue", () => {
    const bridge = startProbe();
    const result = bridgeResult(bridge);
    const callback = JSON.parse(
      decodeURIComponent(result.hash.slice("#cflop-probe-result=".length)),
    ) as {
      probe: { nonce: string; returnHref: string };
    };
    callback.probe.nonce = crypto.randomUUID();
    callback.probe.returnHref = "https://cflop.us/untrusted-return";
    result.hash = "#cflop-probe-result=" + encodeURIComponent(JSON.stringify(callback));
    const navigation = at(result.href);
    const root = document.createElement("div");
    const render = vi.fn();
    expect(handleOriginMigration(root, render)).toBe(true);
    root.querySelector("button")!.click();
    expect(navigation.replace).toHaveBeenCalledWith(bridge.href);
    root.querySelector("a")!.click();
    expect(navigation.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://cflop.us/learn?set=pll#case",
    );
    expect(render).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it.each([null, "not JSON", '{"version":99}'])(
    "starts a fresh probe after one Retry with absent or corrupt callback state %s",
    (pending) => {
      const bridge = startProbe();
      const result = bridgeResult(bridge);
      if (pending === null) sessionStorage.removeItem("cflop:origin-migration-pending:v1");
      else sessionStorage.setItem("cflop:origin-migration-pending:v1", pending);
      const navigation = at(result.href);
      const root = document.createElement("div");
      expect(handleOriginMigration(root)).toBe(true);
      root.querySelector("button")!.click();
      const retry = navigation.replace.mock.calls[0]![0] as string;
      expect(retry).toBe("https://cflop.us/learn?__cflop_migrate=1&set=pll");
      const restarted = at(retry);
      expect(handleOriginMigration(document.createElement("div"))).toBe(true);
      expect(restarted.replace).toHaveBeenCalledWith(
        expect.stringContaining("https://cflop.unimatrix-01.dev/origin-migration?attempt="),
      );
      vi.unstubAllGlobals();
    },
  );

  it("rejects bridge metadata targeting another origin", () => {
    const hash =
      "#cflop-probe=" +
      encodeURIComponent(
        JSON.stringify({
          version: 1,
          sourceIndex: 0,
          nonce: crypto.randomUUID(),
          returnHref: "https://evil.test/",
        }),
      );
    const navigation = at("https://cflop.unimatrix-01.dev/origin-migration" + hash);
    const root = document.createElement("div");
    expect(handleOriginMigration(root)).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(root.querySelector("a")!.href).toContain("https://cflop.us/");
    vi.unstubAllGlobals();
  });

  it("does nothing on local development origins", () => {
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
  });
});
