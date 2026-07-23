import { describe, expect, it, vi } from "vitest";

import type { AccountFetch, AccountFetchResponse } from "../src/account-store.js";
import { createAccountUserStore } from "../src/account-store.js";

function createResponse(options: {
  blob?: () => Promise<Blob>;
  json?: () => Promise<unknown>;
  ok: boolean;
  status: number;
}): AccountFetchResponse {
  return {
    json: options.json ?? (() => Promise.resolve({})),
    ok: options.ok,
    status: options.status,
    text: () => Promise.resolve(""),
    blob: options.blob ?? (() => Promise.resolve(new Blob([]))),
  };
}

/** `vi.fn<AccountFetch>(...)` types `.mock.calls` as `[url, init?][]` instead of `[]`. */
function fetchMockOf(response: AccountFetchResponse) {
  return vi.fn<AccountFetch>(() => Promise.resolve(response));
}

const NAMESPACE = "cube-trainer";
const BASE_URL = "https://api.example.test";

describe("createAccountUserStore", () => {
  it("throws for an invalid namespace", () => {
    expect(() =>
      createAccountUserStore({
        namespace: "Not Valid",
        baseUrl: BASE_URL,
        getToken: () => "token",
      }),
    ).toThrow();
  });

  describe("settings", () => {
    it("resolves undefined when getDocument 404s", async () => {
      const fetchMock = fetchMockOf(
        createResponse({
          json: () => Promise.resolve({ error: { code: "NOT_FOUND", message: "Document not found." } }),
          ok: false,
          status: 404,
        }),
      );
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "token",
        fetch: fetchMock,
      });

      await expect(store.settings.get("progress")).resolves.toBeUndefined();
    });

    it("propagates non-404 errors from getDocument", async () => {
      const fetchMock = fetchMockOf(createResponse({ ok: false, status: 500 }));
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "token",
        fetch: fetchMock,
      });

      await expect(store.settings.get("progress")).rejects.toThrow();
    });

    it("round-trips a document via get/put and attaches the bearer token", async () => {
      const fetchMock = fetchMockOf(
        createResponse({
          json: () =>
            Promise.resolve({
              namespace: NAMESPACE,
              key: "progress",
              value: { streak: 4 },
              updatedAt: "2026-07-01T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      );
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "test-token",
        fetch: fetchMock,
      });

      await store.settings.set("progress", { streak: 4 });
      const result = await store.settings.get("progress");

      expect(result).toEqual({ streak: 4 });

      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(putCall?.[0]).toBe(`${BASE_URL}/me/data`);
      expect(putCall?.[1]?.headers?.authorization).toBe("Bearer test-token");

      const getCall = fetchMock.mock.calls.find(([, init]) => init?.method === "GET");
      expect(getCall?.[0]).toBe(`${BASE_URL}/me/data?namespace=${NAMESPACE}&key=progress`);
    });

    it("omits the Authorization header when getToken resolves null", async () => {
      const fetchMock = fetchMockOf(
        createResponse({ json: () => Promise.resolve({ documents: [] }), ok: true, status: 200 }),
      );
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => null,
        fetch: fetchMock,
      });

      await store.settings.list();

      const [, init] = fetchMock.mock.calls[0] ?? [];
      expect(init?.headers?.authorization).toBeUndefined();
    });
  });

  describe("files", () => {
    it("uploads a blob as multipart form data with the bearer header", async () => {
      const fetchMock = fetchMockOf(
        createResponse({
          json: () =>
            Promise.resolve({
              namespace: NAMESPACE,
              key: "avatar.png",
              contentType: "image/png",
              size: 5,
              updatedAt: "2026-07-01T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      );
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "test-token",
        fetch: fetchMock,
      });

      const metadata = await store.files.upload("avatar.png", new Blob(["12345"], { type: "image/png" }));

      expect(metadata.key).toBe("avatar.png");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE_URL}/me/files?namespace=${NAMESPACE}&key=avatar.png`);
      expect(init?.method).toBe("POST");
      expect(init?.headers?.authorization).toBe("Bearer test-token");
      expect(init?.body).toBeInstanceOf(FormData);
    });

    it("resolves undefined from getBlob on a 404", async () => {
      const fetchMock = fetchMockOf(createResponse({ ok: false, status: 404 }));
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "test-token",
        fetch: fetchMock,
      });

      await expect(store.files.getBlob("missing.png")).resolves.toBeUndefined();
    });

    it("returns the blob body from getBlob on success", async () => {
      const fakeBlob = new Blob(["file-bytes"], { type: "image/png" });
      const fetchMock = fetchMockOf(createResponse({ ok: true, status: 200, blob: () => Promise.resolve(fakeBlob) }));
      const store = createAccountUserStore({
        namespace: NAMESPACE,
        baseUrl: BASE_URL,
        getToken: () => "test-token",
        fetch: fetchMock,
      });

      const blob = await store.files.getBlob("avatar.png");
      expect(blob).toBe(fakeBlob);
    });
  });
});
