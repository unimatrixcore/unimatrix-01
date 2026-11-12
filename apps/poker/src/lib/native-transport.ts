import { clearLabPageHandoff } from "./lab-page-handoff";
import { labQueryClient } from "./background-lists";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  pokerLabRequestSchema,
  pokerLabResponseSchema,
  type PokerLabRequest,
  type PokerLabResponse,
} from "@unimatrix/shared";

export type LabInvoker = (request: PokerLabRequest) => Promise<unknown>;
declare global {
  interface Window {
    __POKER_LAB_TEST_INVOKE__?: LabInvoker;
    CollectorNativeTransport: { mediaUrl: (url: string) => string };
    SERVER_START_TIME: number;
    OCR_CONTRACT: unknown;
    OCR_CONTRACT_SHA256: string;
  }
}
const desktopRequired =
  "Open Poker Lab in its desktop window to use its local dataset and capture services.";
export function createLabFetch(
  invoker: LabInvoker,
  originalFetch: typeof fetch,
  baseUrl: string,
): typeof fetch {
  return async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), baseUrl);
    if (
      !url.pathname.startsWith("/api/") ||
      (url.origin !== new URL(baseUrl).origin && url.protocol !== "pokerlab:")
    )
      return originalFetch(input, options);
    const original = input instanceof Request ? input : null;
    const signal = options?.signal ?? original?.signal;
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const body =
      options?.body ??
      (original && original.method !== "GET" ? await original.clone().text() : null);
    let parsedBody: unknown = null;
    if (body !== null && body !== undefined) {
      const text = typeof body === "string" ? body : await new Response(body).text();
      parsedBody = text ? JSON.parse(text) : null;
    }
    const headers = new Headers(options?.headers ?? original?.headers);
    const request = pokerLabRequestSchema.parse({
      method: options?.method ?? original?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(headers),
      body: parsedBody,
    });
    if (
      request.method !== "GET" &&
      /^\/api\/(?:gameplay|queue|capture|watch|review_label|db_|add_to_db|clear_session|sync)/.test(
        request.path,
      )
    ) {
      clearLabPageHandoff();
      labQueryClient.removeQueries({
        type: "inactive",
        predicate: (query) =>
          query.queryKey[0] === "lab-list" &&
          (query.queryKey[1] === "/api/queue" || query.queryKey[1] === "/api/gameplay"),
      });
    }
    const response = pokerLabResponseSchema.parse(await invoker(request));
    if (
      response.status >= 200 &&
      response.status < 300 &&
      request.method !== "GET" &&
      ["/api/review_label", "/api/model_suggestion"].includes(request.path) &&
      request.headers["x-dataset-id"]
    ) {
      void labQueryClient.resetQueries({
        queryKey: ["lab-list", "/api/label_history", request.headers["x-dataset-id"]],
      });
    }
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    return labResponse(response);
  };
}
export function labResponse(response: PokerLabResponse): Response {
  const body =
    response.bodyBase64 === undefined
      ? JSON.stringify(response.body)
      : Uint8Array.from(atob(response.bodyBase64), (value) => value.charCodeAt(0));
  return new Response(
    response.status === 204 || response.status === 205 || response.status === 304 ? null : body,
    { status: response.status, headers: response.headers },
  );
}
export function mediaUrl(url: string): string {
  if (!isTauri()) return url;
  const parsed = new URL(url, window.location.href);
  if (!parsed.pathname.startsWith("/api/") || parsed.origin !== window.location.origin) return url;
  const prefix = convertFileSrc("", "pokerlab").replace(/\/$/, "");
  return `${prefix}${parsed.pathname}${parsed.search}`;
}
function installMediaUrls() {
  const attribute = Reflect.get(Element.prototype, "setAttribute");
  Element.prototype.setAttribute = function (name, value) {
    const media =
      (name === "src" || name === "data-full-res") &&
      (this instanceof HTMLImageElement ||
        this instanceof HTMLMediaElement ||
        this instanceof HTMLSourceElement);
    const link = name === "href" && this instanceof HTMLAnchorElement;
    attribute.call(this, name, media || link ? mediaUrl(value) : value);
  };
  for (const [prototype, name] of [
    [HTMLImageElement.prototype, "src"],
    [HTMLMediaElement.prototype, "src"],
    [HTMLSourceElement.prototype, "src"],
    [HTMLAnchorElement.prototype, "href"],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set(this: Element, value: string) {
        descriptor.set?.call(this, mediaUrl(value));
      },
    });
  }
}
export function installLabTransport(): void {
  const native = isTauri();
  const test =
    import.meta.env.MODE === "test-browser" ? window.__POKER_LAB_TEST_INVOKE__ : undefined;
  const invoker: LabInvoker =
    test ??
    (async (request) => {
      if (!native) throw new Error(desktopRequired);
      return invoke("lab_request", { request });
    });
  const original = window.fetch.bind(window);
  window.fetch = createLabFetch(invoker, original, window.location.href);
  if (native) {
    installMediaUrls();
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      const parsed = new URL(url, window.location.href);
      if (!parsed.pathname.startsWith("/api/")) return beacon(url, data);
      void window
        .fetch(parsed, { method: "POST", body: data ?? null, keepalive: true })
        .catch(() => {});
      return true;
    };
  }
  window.CollectorNativeTransport = { mediaUrl };
}
