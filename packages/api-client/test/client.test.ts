import type { ApiClientFetch } from "../src/config.js";

import { adminDeployDeclarationsContract, healthContract } from "@unimatrix/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, createApiClient } from "../src/client.js";

function createResponse(options: { json?: () => Promise<unknown>; ok: boolean; status: number }) {
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
  it("reads deployment declarations through the authenticated admin contract", async () => {
    const fetchMock = vi.fn<ApiClientFetch>(() =>
      Promise.resolve(
        createResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ apps: [] }),
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      getAuthToken: () => "admin-session",
    });
    expect(
      await client.request(adminDeployDeclarationsContract, { query: { app: "api" } }),
    ).toEqual({ apps: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/deployment/admin/declarations?app=api",
    );
  });

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

  it.each([
    ["https://api.example.test", "no trailing slash"],
    ["https://api.example.test/", "one trailing slash"],
    ["https://api.example.test///", "several trailing slashes"],
  ])("collapses %s (%s) to a single separator", async (baseUrl) => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({ baseUrl, fetch: fetchMock });

    await client.request(healthContract);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/health",
      expect.objectContaining({ method: "GET" }),
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

  it("attaches an Authorization header when getAuthToken returns a token", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      getAuthToken: () => "test-token",
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

  it("awaits an async getAuthToken provider", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      getAuthToken: () => Promise.resolve("async-token"),
    });

    await client.request(healthContract);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/health",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer async-token",
        },
      }),
    );
  });

  it.each([null, undefined, ""])(
    "omits the Authorization header when getAuthToken resolves to %j",
    async (tokenValue) => {
      const fetchMock = vi.fn(() => Promise.resolve(createResponse({ ok: true, status: 200 })));
      const client = createApiClient({
        baseUrl: "https://api.example.test",
        fetch: fetchMock,
        getAuthToken: () => tokenValue,
      });

      await client.request(healthContract);

      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string> },
      ];

      expect(init.headers).not.toHaveProperty("authorization");
    },
  );

  it("throws an ApiClientError carrying status and the parsed envelope on a 401", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() =>
        Promise.resolve(
          createResponse({
            json: () =>
              Promise.resolve({
                error: {
                  code: "UNAUTHORIZED",
                  message: "Sign in required.",
                  statusCode: 401,
                },
                requestId: "req_1",
              }),
            ok: false,
            status: 401,
          }),
        ),
      ),
    });

    const rejection = client.request(healthContract);

    await expect(rejection).rejects.toBeInstanceOf(ApiClientError);
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiClientError);
      const apiError = error as ApiClientError;
      expect(apiError.status).toBe(401);
      expect(apiError.code).toBe("UNAUTHORIZED");
      expect(apiError.message).toBe("Sign in required.");
      expect(apiError.requestId).toBe("req_1");
    });
  });

  it("throws an ApiClientError carrying status and the parsed envelope on a 403", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() =>
        Promise.resolve(
          createResponse({
            json: () =>
              Promise.resolve({
                error: {
                  code: "FORBIDDEN",
                  message: "Not allowed.",
                  statusCode: 403,
                },
                requestId: "req_2",
              }),
            ok: false,
            status: 403,
          }),
        ),
      ),
    });

    await client.request(healthContract).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiClientError);
      const apiError = error as ApiClientError;
      expect(apiError.status).toBe(403);
      expect(apiError.code).toBe("FORBIDDEN");
      expect(apiError.requestId).toBe("req_2");
    });
  });

  it("falls back to a descriptive message when a non-ok response has no error envelope", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() => Promise.resolve(createResponse({ ok: false, status: 503 }))),
    });

    await expect(client.request(healthContract)).rejects.toThrow(
      "GET /health failed with status 503.",
    );
    await client.request(healthContract).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiClientError);
      expect((error as ApiClientError).status).toBe(503);
      expect((error as ApiClientError).code).toBeUndefined();
    });
  });

  it("gets a document via getDocument", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              namespace: "cflop",
              key: "progress",
              value: { streak: 3 },
              updatedAt: "2026-07-01T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.getDocument({ namespace: "cflop", key: "progress" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data?namespace=cflop&key=progress",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({
      namespace: "cflop",
      key: "progress",
      value: { streak: 3 },
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("throws an ApiClientError with status 404 from getDocument when the document is absent", async () => {
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() =>
        Promise.resolve(
          createResponse({
            json: () =>
              Promise.resolve({
                error: {
                  code: "NOT_FOUND",
                  message: "Document not found.",
                  statusCode: 404,
                },
                requestId: "req_3",
              }),
            ok: false,
            status: 404,
          }),
        ),
      ),
    });

    const rejection = client.getDocument({ namespace: "cflop", key: "missing" });

    await expect(rejection).rejects.toBeInstanceOf(ApiClientError);
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiClientError);
      const apiError = error as ApiClientError;
      expect(apiError.status).toBe(404);
      expect(apiError.code).toBe("NOT_FOUND");
    });
  });

  it("puts a document via putDocument", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              namespace: "cflop",
              key: "progress",
              value: { streak: 4 },
              updatedAt: "2026-07-02T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.putDocument({
      namespace: "cflop",
      key: "progress",
      value: { streak: 4 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          namespace: "cflop",
          key: "progress",
          value: { streak: 4 },
        }),
      }),
    );
    expect(result.value).toEqual({ streak: 4 });
  });

  it("lists documents via listDocuments", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              documents: [
                {
                  namespace: "cflop",
                  key: "progress",
                  value: { streak: 4 },
                  updatedAt: "2026-07-02T00:00:00.000Z",
                },
              ],
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.listDocuments({ namespace: "cflop" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data/list?namespace=cflop",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.documents).toHaveLength(1);
  });

  it("deletes a document via deleteDocument", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () => Promise.resolve({ deleted: true }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.deleteDocument({ namespace: "cflop", key: "progress" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ namespace: "cflop", key: "progress" }),
      }),
    );
    expect(result).toEqual({ deleted: true });
  });

  it("lists file metadata via listFiles", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              files: [
                {
                  namespace: "cflop",
                  key: "avatar.png",
                  contentType: "image/png",
                  size: 1024,
                  updatedAt: "2026-07-02T00:00:00.000Z",
                },
              ],
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.listFiles({ namespace: "cflop" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/files?namespace=cflop",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.key).toBe("avatar.png");
  });

  it("deletes a file via deleteFile", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () => Promise.resolve({ deleted: true }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.deleteFile({ namespace: "cflop", key: "avatar.png" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/files",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ namespace: "cflop", key: "avatar.png" }),
      }),
    );
    expect(result).toEqual({ deleted: true });
  });

  it("lists secrets via adminListSecrets", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              secrets: [
                {
                  name: "integrations/github/token",
                  tier: "integration",
                  metadata: {
                    name: "integrations/github/token",
                    maskedPrefix: "ghp_",
                    kekVersion: 1,
                    createdAt: "2026-07-01T00:00:00.000Z",
                    rotatedAt: "2026-07-01T00:00:00.000Z",
                  },
                  consumedBy: null,
                },
                {
                  name: "platform/clerk-secret-key",
                  tier: "platform",
                  metadata: null,
                  consumedBy: "apps/api's Clerk backend calls.",
                },
              ],
              activeKekVersion: 1,
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.adminListSecrets();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/secrets/admin",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.secrets).toHaveLength(2);
    expect(result.secrets[1]?.metadata).toBeNull();
  });

  it("refreshes integration credentials via refreshIntegrationCredentials", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              loaded: ["integrations/github/token"],
              denied: [],
              failed: [],
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.refreshIntegrationCredentials();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/integrations/admin/credentials/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ loaded: ["integrations/github/token"], denied: [], failed: [] });
  });

  it("creates a secret via adminCreateSecret", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              name: "github/api-token",
              maskedPrefix: "ghp_",
              kekVersion: 1,
              createdAt: "2026-07-01T00:00:00.000Z",
              rotatedAt: "2026-07-01T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.adminCreateSecret({
      name: "github/api-token",
      value: "ghp_secretvalue",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/secrets/admin",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "github/api-token", value: "ghp_secretvalue" }),
      }),
    );
    expect(result.name).toBe("github/api-token");
  });

  it("rotates a secret via adminRotateSecret", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              name: "github/api-token",
              maskedPrefix: "ghp_",
              kekVersion: 2,
              createdAt: "2026-07-01T00:00:00.000Z",
              rotatedAt: "2026-07-05T00:00:00.000Z",
            }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.adminRotateSecret({
      name: "github/api-token",
      value: "ghp_newvalue",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/secrets/admin/rotate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "github/api-token", value: "ghp_newvalue" }),
      }),
    );
    expect(result.kekVersion).toBe(2);
  });

  it("deletes a secret via adminDeleteSecret", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () => Promise.resolve({ deleted: true }),
          ok: true,
          status: 200,
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const result = await client.adminDeleteSecret({ name: "github/api-token" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/secrets/admin",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ name: "github/api-token" }),
      }),
    );
    expect(result).toEqual({ deleted: true });
  });
});
