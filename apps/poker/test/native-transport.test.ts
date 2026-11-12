import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLabFetch,
  installLabTransport,
  labResponse,
  mediaUrl,
} from "../src/lib/native-transport.js";
import type { PokerLabRequest } from "@unimatrix/shared";
const native = vi.hoisted(() => ({ enabled: false }));
afterEach(() => {
  native.enabled = false;
});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.enabled,
  invoke: vi.fn().mockResolvedValue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  }),
  convertFileSrc: (_path: string, protocol: string) => `${protocol}://localhost/`,
}));

describe("Poker Lab native request transport", () => {
  it("preserves path, query, dataset scope, JSON body and native response status", async () => {
    const requests: PokerLabRequest[] = [];
    const invoke = vi.fn(async (request: PokerLabRequest) => {
      requests.push(request);
      await Promise.resolve();
      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: { prediction_id: "p-1" },
      };
    });
    const nativeFetch = createLabFetch(invoke, vi.fn(), "http://tauri.localhost/collection");
    const response = await nativeFetch("/api/review_label?dataset_id=working&sample_key=name%3A1", {
      method: "POST",
      headers: { "X-Dataset-ID": "working", "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Player 1", action: "correct" }),
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/review_label",
        query: { dataset_id: "working", sample_key: "name:1" },
        headers: { "x-dataset-id": "working", "content-type": "application/json" },
        body: { label: "Player 1", action: "correct" },
      },
    ]);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ prediction_id: "p-1" });
  });
  it("preserves binary pixels and backend error bodies", async () => {
    const binary = labResponse({
      status: 206,
      headers: { "content-type": "image/png", "content-range": "bytes 0-2/3" },
      body: null,
      bodyBase64: "AQID",
    });
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(binary.headers.get("content-range")).toBe("bytes 0-2/3");
    const failure = labResponse({ status: 409, headers: {}, body: { error: "Dataset changed" } });
    expect(failure.ok).toBe(false);
    expect(await failure.json()).toEqual({ error: "Dataset changed" });
    expect(labResponse({ status: 204, headers: {}, body: null }).body).toBeNull();
  });
  it("does not redirect external requests or alter browser-mode media paths", async () => {
    const fallback = vi.fn().mockResolvedValue(new Response("external"));
    const invoke = vi.fn();
    const nativeFetch = createLabFetch(invoke, fallback, "http://tauri.localhost/collection");
    expect(await (await nativeFetch("https://example.com/api/read")).text()).toBe("external");
    expect(invoke).not.toHaveBeenCalled();
    expect(mediaUrl("/api/queue/image/12?dataset_id=working")).toBe(
      "/api/queue/image/12?dataset_id=working",
    );
  });
  it("rejects malformed native envelopes and supports fetch abort semantics", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn().mockResolvedValue({ status: 700, headers: {}, body: {} });
    const nativeFetch = createLabFetch(invoke, vi.fn(), "http://tauri.localhost/");
    await expect(nativeFetch("/api/stats", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(invoke).not.toHaveBeenCalled();
    await expect(nativeFetch("/api/stats")).rejects.toThrow();
  });
});

it("preserves dataset scope in native media URLs and leaves external URLs alone", () => {
  native.enabled = true;
  expect(mediaUrl("/api/queue/image/12?dataset_id=working")).toBe(
    "pokerlab://localhost/api/queue/image/12?dataset_id=working",
  );
  expect(mediaUrl("https://example.com/api/image")).toBe("https://example.com/api/image");
  expect(mediaUrl("data:image/png;base64,AQID")).toBe("data:image/png;base64,AQID");
});

it("installs native image, full-resolution magnifier and link routing without changing static assets", async () => {
  native.enabled = true;
  const originalFetch = Reflect.get(window, "fetch");
  const originalBeacon = Reflect.get(navigator, "sendBeacon");
  const prototypes = [
    [Element.prototype, "setAttribute"],
    [HTMLImageElement.prototype, "src"],
    [HTMLMediaElement.prototype, "src"],
    [HTMLSourceElement.prototype, "src"],
    [HTMLAnchorElement.prototype, "href"],
  ] as const;
  const descriptors = prototypes.map(([prototype, property]) => ({
    prototype,
    property,
    descriptor: Object.getOwnPropertyDescriptor(prototype, property),
  }));
  navigator.sendBeacon = vi.fn().mockReturnValue(true);
  try {
    installLabTransport();
    const image = document.createElement("img");
    image.src = "/api/db_image/crop.png?dataset_id=working";
    expect(image.src).toBe("pokerlab://localhost/api/db_image/crop.png?dataset_id=working");
    image.setAttribute("data-full-res", "/api/cap_image/frame.png?dataset_id=working");
    expect(image.getAttribute("data-full-res")).toBe(
      "pokerlab://localhost/api/cap_image/frame.png?dataset_id=working",
    );
    const link = document.createElement("a");
    link.href = "/api/cap_image/frame.png";
    expect(link.href).toBe("pokerlab://localhost/api/cap_image/frame.png");
    image.src = "/static/ui/poker-chip.svg";
    expect(image.src).not.toContain("pokerlab:");
    const response = await window.fetch("/api/initial_data");
    expect(await response.json()).toEqual({ ok: true });
    expect(
      navigator.sendBeacon(
        "/api/gameplay/sessions/recording/stop",
        new Blob(["{}"], { type: "application/json" }),
      ),
    ).toBe(true);
    await Promise.resolve();
  } finally {
    for (const { prototype, property, descriptor } of descriptors)
      if (descriptor) Object.defineProperty(prototype, property, descriptor);
    window.fetch = originalFetch;
    navigator.sendBeacon = originalBeacon;
  }
});
