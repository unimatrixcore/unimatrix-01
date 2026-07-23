import type { ApiClientFetch } from "../src/config.js";

import { healthContract } from "@unimatrix/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, createApiClient } from "../src/client.js";

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

  it("serializes a request body and sets content-type for a body-bearing PATCH", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              firstName: null,
              id: "user_123",
              imageUrl: null,
              lastName: null,
              permissions: { web: ["viewer"] },
              primaryEmailAddress: "person@example.test",
              username: null,
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

    const result = await client.updateUserPermissions({
      permissions: { web: ["viewer"] },
      userId: "user_123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/admin/users",
      expect.objectContaining({
        body: JSON.stringify({
          permissions: { web: ["viewer"] },
          userId: "user_123",
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "PATCH",
      }),
    );
    expect(result.id).toBe("user_123");
  });

  it("builds a querystring for a query-bearing GET", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createResponse({
          json: () =>
            Promise.resolve({
              limit: 10,
              offset: 0,
              totalCount: 0,
              users: [],
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

    await client.listUsers({ limit: 10, offset: 0, query: "gwen" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/admin/users?limit=10&offset=0&query=gwen",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

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
              namespace: "cube-trainer",
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

    const result = await client.getDocument({ namespace: "cube-trainer", key: "progress" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data?namespace=cube-trainer&key=progress",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({
      namespace: "cube-trainer",
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

    const rejection = client.getDocument({ namespace: "cube-trainer", key: "missing" });

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
              namespace: "cube-trainer",
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
      namespace: "cube-trainer",
      key: "progress",
      value: { streak: 4 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          namespace: "cube-trainer",
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
                  namespace: "cube-trainer",
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

    const result = await client.listDocuments({ namespace: "cube-trainer" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data/list?namespace=cube-trainer",
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

    const result = await client.deleteDocument({ namespace: "cube-trainer", key: "progress" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/data",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ namespace: "cube-trainer", key: "progress" }),
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
                  namespace: "cube-trainer",
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

    const result = await client.listFiles({ namespace: "cube-trainer" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/files?namespace=cube-trainer",
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

    const result = await client.deleteFile({ namespace: "cube-trainer", key: "avatar.png" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/me/files",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ namespace: "cube-trainer", key: "avatar.png" }),
      }),
    );
    expect(result).toEqual({ deleted: true });
  });
});
