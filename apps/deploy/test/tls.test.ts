import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Agent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import type { DokployClient } from "../src/dokploy/client.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";
import { createDeployPinnedAgent, loadDeployTlsOptions } from "../src/tls.js";

const directory = mkdtempSync(join(tmpdir(), "deploy-tls-test-"));
after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function generateCertificate(name: string): { certificate: string; key: string } {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:deploy",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );

  return {
    certificate: readFileSync(certPath).toString("base64"),
    key: readFileSync(keyPath).toString("base64"),
  };
}

const primary = generateCertificate("primary");
const other = generateCertificate("other");

void test("TLS is optional locally but mandatory in production and configured as a pair", () => {
  assert.equal(loadDeployTlsOptions({}), undefined);
  assert.equal(loadDeployTlsOptions({ NODE_ENV: "test" }), undefined);
  for (const env of [
    { NODE_ENV: "production" },
    { NODE_ENV: " production " },
    { DEPLOY_TLS_CERT_BASE64: primary.certificate },
    { DEPLOY_TLS_KEY_BASE64: primary.key },
    { DEPLOY_TLS_CERT_BASE64: "", DEPLOY_TLS_KEY_BASE64: "" },
  ]) {
    assert.throws(() => loadDeployTlsOptions(env), /Invalid deploy TLS configuration/u);
  }
  assert.equal(
    loadDeployTlsOptions({
      NODE_ENV: "production",
      DEPLOY_TLS_CERT_BASE64: primary.certificate,
      DEPLOY_TLS_KEY_BASE64: primary.key,
    })?.minVersion,
    "TLSv1.2",
  );
});

void test("malformed documents and mismatched keys fail without leaking input or OpenSSL errors", () => {
  for (const [certificate, key] of [
    ["secret-input-not-base64", primary.key],
    [primary.certificate + "!", primary.key],
    [
      Buffer.from("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n").toString(
        "base64",
      ),
      primary.key,
    ],
    [primary.certificate, Buffer.from("secret-private-key").toString("base64")],
    [primary.certificate, other.key],
    [primary.certificate, primary.certificate],
  ] as const) {
    assert.throws(
      () =>
        loadDeployTlsOptions({ DEPLOY_TLS_CERT_BASE64: certificate, DEPLOY_TLS_KEY_BASE64: key }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Invalid deploy TLS configuration: supply a valid matching base64 PEM certificate and private key; production requires TLS.",
        );
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  for (const malformed of [
    "",
    "private-pin-input",
    primary.certificate + "!",
    primary.key,
    Buffer.from("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n").toString(
      "base64",
    ),
  ]) {
    assert.throws(() => createDeployPinnedAgent(malformed), {
      message: "Invalid deploy TLS certificate pin: expected one base64 PEM certificate.",
    });
  }
});

function get(
  port: number,
  agent: Agent,
  servername: string,
  token = "test-service-credential",
  path = "/",
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        servername,
        path,
        agent,
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

void test("pinned HTTPS accepts only the configured certificate and matching hostname", async () => {
  let requests = 0;
  const tlsOptions = loadDeployTlsOptions({
    DEPLOY_TLS_CERT_BASE64: primary.certificate,
    DEPLOY_TLS_KEY_BASE64: primary.key,
  });
  assert.ok(tlsOptions);
  const server = createServer(tlsOptions, (req, response) => {
    requests += 1;
    assert.equal(req.headers.authorization, "Bearer test-service-credential");
    response.end("authenticated transport");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const trusted = createDeployPinnedAgent(primary.certificate);
  const untrusted = createDeployPinnedAgent(other.certificate);
  try {
    assert.equal((await get(address.port, trusted, "deploy")).body, "authenticated transport");
    await assert.rejects(get(address.port, untrusted, "deploy"));
    await assert.rejects(get(address.port, trusted, "wrong-host.invalid"));
    assert.equal(requests, 1, "failed TLS verification must not transmit credentials");
  } finally {
    trusted.destroy();
    untrusted.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

void test("Fastify serves the authenticated caller over pinned TLS and revokes it without restart", async () => {
  const serviceTokens = openServiceTokenStore(":memory:");
  const token = serviceTokens.issue({ name: "api", capability: "read" }).token;
  const unused = () => Promise.reject(new Error("Dokploy must not be called"));
  const dokploy: DokployClient = {
    getDokployVersion: unused,
    getContainers: unused,
    getProjects: unused,
    getCompose: unused,
    updateComposeSettings: unused,
  };
  const https = loadDeployTlsOptions({
    NODE_ENV: "production",
    DEPLOY_TLS_CERT_BASE64: primary.certificate,
    DEPLOY_TLS_KEY_BASE64: primary.key,
  });
  assert.ok(https);
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      DOKPLOY_BASE_URL: "http://dokploy:3000",
      DOKPLOY_API_KEY: "unused",
      DEPLOY_DATABASE_PATH: ":memory:",
    }),
    { dokploy, https, serviceTokens },
  );
  app.register((routes) => {
    routes.get("/test/identity", (req) => req.serviceCaller);
    return Promise.resolve();
  });
  const trusted = createDeployPinnedAgent(primary.certificate);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal((await get(address.port, trusted, "deploy", "invalid", "/health")).status, 200);
    const response = await get(address.port, trusted, "deploy", token, "/test/identity");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      id: serviceTokens.list()[0]?.id,
      name: "api",
      capability: "read",
    });
    assert.equal(
      (await get(address.port, trusted, "deploy", "invalid", "/test/identity")).status,
      401,
    );
    serviceTokens.revoke("api");
    assert.equal((await get(address.port, trusted, "deploy", token, "/test/identity")).status, 401);
  } finally {
    trusted.destroy();
    await app.close();
  }
});
