import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeHealth, resolveHealthProbeTargets } from "../src/health-history/probe.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";

void test("HTTP probe accepts 2xx, rejects errors and redirects without following them, and times out", async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (request.url === "/hang") return;
    if (request.url === "/redirect") response.writeHead(302, { location: "/" });
    else response.writeHead(request.url === "/bad" ? 500 : 204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${String(address.port)}`;
  const signal = new AbortController().signal;
  try {
    assert.equal(await probeHealth({ app: "api", url: base, configured: true }, signal), "up");
    assert.equal(
      await probeHealth({ app: "api", url: `${base}/bad`, configured: true }, signal),
      "down",
    );
    assert.equal(
      await probeHealth({ app: "api", url: `${base}/redirect`, configured: true }, signal),
      "down",
    );
    assert.equal(hits, 3);
    assert.equal(
      await probeHealth({ app: "api", url: `${base}/hang`, configured: true }, signal, 10),
      "down",
    );
    assert.equal(
      await probeHealth({ app: "api", url: base, configured: false }, signal),
      "unknown",
    );
    assert.equal(
      await probeHealth({ app: "api", url: base, configured: true }, AbortSignal.abort()),
      "unknown",
    );
    const abort = new AbortController();
    const pending = probeHealth(
      { app: "api", url: `${base}/hang`, configured: true },
      abort.signal,
    );
    abort.abort();
    assert.equal(await pending, "unknown");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
  assert.equal(await probeHealth({ app: "api", url: base, configured: true }, signal), "down");
});

void test("TLS probe verifies the pin and hostname against a real listener", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-probe-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "pipe" },
  );
  const ca = readFileSync(certPath, "utf8");
  const server = createTlsServer({ key: readFileSync(keyPath), cert: ca }, (_request, response) => {
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `https://localhost:${String(address.port)}/health`;
  const signal = new AbortController().signal;
  try {
    assert.equal(await probeHealth({ app: "secrets", url, ca, configured: true }, signal), "up");
    assert.equal(await probeHealth({ app: "secrets", url, configured: true }, signal), "down");
    assert.equal(
      await probeHealth(
        { app: "secrets", url: url.replace("localhost", "127.0.0.1"), ca, configured: true },
        signal,
      ),
      "down",
    );
    const targets = resolveHealthProbeTargets(DEPLOY_DESIRED_STATE, {
      SECRETS_TLS_CERT_BASE64: Buffer.from(ca).toString("base64"),
    });
    assert.equal(targets.find((target) => target.app === "secrets")?.ca, ca);
    assert.ok(targets.every((target) => target.configured));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("missing or malformed trust configuration is unknown without relaxing TLS", () => {
  for (const value of [undefined, "", "!!", Buffer.from("not a certificate").toString("base64")]) {
    const targets = resolveHealthProbeTargets(DEPLOY_DESIRED_STATE, {
      SECRETS_TLS_CERT_BASE64: value,
    });
    const secrets = targets.find((target) => target.app === "secrets");
    assert.equal(secrets?.configured, false);
    assert.equal(secrets?.url, "https://secrets:3001/health");
    assert.equal(targets.find((target) => target.app === "web")?.url, "http://web:8080/");
    assert.equal(targets.find((target) => target.app === "api")?.url, "http://api:3001/health");
  }
});
