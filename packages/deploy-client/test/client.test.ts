import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDeployClient, DeployClientError, type DeployClientConfig } from "../src/index.js";

const state = { checkedAt: 123, apps: [] };
const summary = {
  from: 0,
  to: 123,
  upMs: 0,
  downMs: 0,
  unknownMs: 123,
  uptimePercent: null,
  coveragePercent: 0,
};
const health = {
  app: "api",
  current: { app: "api", state: "unknown", checkedAt: null },
  summary,
  days: [],
  recent: [],
  freshness: "missing",
};
let server: Server;
let baseUrl: string;
let mode = "ok";
let requests: { url: string | undefined; authorization: string | undefined }[];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (mode === "timeout") return;
    if (mode === "body-timeout") {
      response.writeHead(200);
      response.write("{");
      return;
    }
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    if (mode === "truncated") {
      response.writeHead(200, { "content-length": "1000" });
      response.write("{");
      setImmediate(() => response.destroy());
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { location: `${baseUrl}/leak` });
      response.end("private upstream text");
      return;
    }
    response.writeHead(mode === "error" ? 500 : 200);
    response.end(
      mode === "oversize"
        ? "x".repeat(1_048_577)
        : mode === "json"
          ? "private upstream text"
          : mode === "schema"
            ? JSON.stringify({ secret: "private upstream text" })
            : JSON.stringify(
                request.url === "/deployment/state"
                  ? state
                  : {
                      ...health,
                      ...(mode === "wrong-app" ? { app: "other" } : {}),
                      ...(mode === "wrong-current"
                        ? { current: { ...health.current, app: "other" } }
                        : {}),
                      ...(mode === "wrong-recent"
                        ? { recent: [{ app: "other", checkedAt: 123, state: "up" }] }
                        : {}),
                    },
              ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected listener address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

function client(options: Partial<DeployClientConfig> = {}) {
  return createDeployClient({ baseUrl, serviceToken: "test-token", ...options });
}

describe("deployment transport", () => {
  it("authenticates static contract reads and validates health selection", async () => {
    mode = "ok";
    requests = [];
    expect(await client().getState()).toEqual(state);
    expect(await client().getHealth("api")).toEqual(health);
    expect(requests).toEqual([
      { url: "/deployment/state", authorization: "Bearer test-token" },
      { url: "/deployment/health?app=api", authorization: "Bearer test-token" },
    ]);
    await expect(client().getHealth("../private")).rejects.toBeInstanceOf(DeployClientError);
    expect(requests).toHaveLength(2);
  });

  it("discards upstream and transport error details and refuses redirects", async () => {
    for (const failure of [
      "error",
      "json",
      "schema",
      "reset",
      "truncated",
      "oversize",
      "redirect",
      "timeout",
      "body-timeout",
    ]) {
      mode = failure;
      requests = [];
      let error: unknown;
      try {
        await client({ timeoutMs: 50 }).getState();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DeployClientError);
      expect(String(error)).toBe("DeployClientError: Deployment read unavailable");
      expect(error).not.toHaveProperty("cause");
      expect(requests).toHaveLength(1);
    }
  });

  it("rejects health observations belonging to another app", async () => {
    for (const failure of ["wrong-app", "wrong-current", "wrong-recent"]) {
      mode = failure;
      requests = [];
      await expect(client().getHealth("api")).rejects.toBeInstanceOf(DeployClientError);
    }
  });

  it("refuses malformed origins, tokens, deadlines and mismatched TLS configuration", () => {
    for (const options of [
      { baseUrl: "not-a-url" },
      { baseUrl: "ftp://localhost" },
      { baseUrl: "http://user:pass@localhost" },
      { baseUrl: "http://localhost/path" },
      { baseUrl: "http://localhost?query=1" },
      { baseUrl: "http://localhost#hash" },
      { baseUrl: "https://localhost" },
      { caCertificatePem: "unused" },
      { serviceToken: " " },
      { serviceToken: "token\r\nheader" },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
    ])
      expect(() => client(options)).toThrow(DeployClientError);
  });
});

it("pins the live TLS certificate, verifies hostname, and sends no token after failed handshakes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-client-tls-"));
  function pair(name: string) {
    const key = join(directory, `${name}.key`);
    const cert = join(directory, `${name}.pem`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  }
  const matching = pair("matching");
  const other = pair("other");
  const seen: string[] = [];
  const tlsServer = createTlsServer(matching, (request, response) => {
    seen.push(request.headers.authorization ?? "");
    response.end(JSON.stringify(state));
  });
  try {
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const address = tlsServer.address();
    if (!address || typeof address === "string") throw new Error("Expected listener address");
    const url = `https://localhost:${address.port}`;
    expect(await client({ baseUrl: url, caCertificatePem: matching.cert }).getState()).toEqual(
      state,
    );
    await expect(
      client({ baseUrl: url, caCertificatePem: other.cert }).getState(),
    ).rejects.toBeInstanceOf(DeployClientError);
    await expect(
      client({
        baseUrl: `https://127.0.0.1:${address.port}`,
        caCertificatePem: matching.cert,
      }).getState(),
    ).rejects.toBeInstanceOf(DeployClientError);
    expect(seen).toEqual(["Bearer test-token"]);
  } finally {
    tlsServer.closeAllConnections();
    await new Promise<void>((resolve) =>
      tlsServer.close(() => {
        resolve();
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
