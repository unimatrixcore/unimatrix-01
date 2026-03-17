import type { ApiClientFetch } from "../src/config.js";

import { healthContract } from "@unimatrix/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/client.js";

function createResponse(options: {
  json?: () => Promise<unknown>;
  ok: boolean;
  status: number;
}) {
  return {
    json:
      options.json ??
      (() =>
        Promise.resolve({
          service: "api",
          status: "ok",
        })),
    ok: options.ok,
    status: options.status,
    text: () => Promise.resolve(""),
  };
}

const originalFetch = (globalThis as { fetch?: ApiClientFetch }).fetch;

afterEach(() => {
  vi.restoreAllMocks();

  if (originalFetch === undefined) {
    delete (globalThis as { fetch?: ApiClientFetch }).fetch;
    return;
  }

  (globalThis as { fetch?: ApiClientFetch }).fetch = originalFetch;
});

describe("api client", () => {
  it("joins the base url and contract path correctly", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({
      baseUrl: "https://api.example.test/",
      fetch: fetchMock,
    });

    await client.request(healthContract);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/health",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("sends the default accept header and merges custom default headers", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      defaultHeaders: {
        authorization: "Bearer test-token",
      },
      fetch: fetchMock,
    });

    await client.request(healthContract);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/health",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer test-token",
        },
      }),
    );
  });

  it("throws a descriptive error for non-ok responses", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() => Promise.resolve(createResponse({ ok: false, status: 503 }))),
    });

    await expect(client.request(healthContract)).rejects.toThrow(
      "GET /health failed with status 503.",
    );
  });

  it("throws a descriptive error for non-json responses", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() =>
        Promise.resolve(
          createResponse({
            json: () => Promise.reject(new Error("invalid json")),
            ok: true,
            status: 200,
          }),
        ),
      ),
    });

    await expect(client.request(healthContract)).rejects.toThrow(
      "GET /health returned a non-JSON response.",
    );
  });

  it("falls back to globalThis.fetch when no custom fetch is provided", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    (globalThis as { fetch?: ApiClientFetch }).fetch = fetchMock;

    const client = createApiClient({
      baseUrl: "https://api.example.test",
    });

    await client.request(healthContract);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the shared health contract for getHealth", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    await expect(client.getHealth()).resolves.toEqual({
      service: "api",
      status: "ok",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/health",
      expect.objectContaining({
        method: healthContract.method,
      }),
    );
  });
});
