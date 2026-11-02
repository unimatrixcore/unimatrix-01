import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@unimatrix/db";
import type { RefreshIntegrationCredentialsResponse, SecretRegistryEntry } from "@unimatrix/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { buildApp, type BuildApiAppOptions } from "../src/app.js";
import { loadApiRuntimeConfig, type ApiRuntimeEnv } from "../src/config.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

const FRONTEND_API_HOST = "example.clerk.accounts.dev";

/**
 * One RSA keypair for this file, under one `kid` — same reasoning as
 * `user-data-authenticated-routes.test.ts`: `@clerk/backend` caches the
 * derived JWK per `kid` for the life of the process, so a second keypair
 * reusing this `kid` would silently verify against this one's public key.
 * Distinct from that file's own keypair only because each test file is its
 * own Node process under `node --test` — nothing here depends on that
 * isolation, but nothing relies on sharing a keypair across files either.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const SIGNING_KEY_ID = "unimatrix-integration-routes-test-key";

const CLERK_JWT_KEY = publicKey.export({ format: "pem", type: "spki" }).toString();

const CLERK_ENV: ApiRuntimeEnv = {
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_JWT_KEY,
};

const SECRETS_ENV: ApiRuntimeEnv = {
  SECRETS_BASE_URL: "http://secrets.internal:3002",
  SECRETS_SERVICE_TOKEN: "svc_test_token",
};

/**
 * The API has no integration consumers, so this route would refresh
 * nothing without the `integrationNames` seam — and a route that returns
 * three empty arrays proves nothing about whether it re-fetched.
 */
const GITHUB_TOKEN_SECRET: SecretRegistryEntry = {
  name: "github/token",
  tier: "integration",
  consumedBy: "stand-in for github/token",
};

const INTEGRATION_NAMES = [GITHUB_TOKEN_SECRET.name];

const ADMIN_USER = "user_2cccccccccccccccccccccccccc";
const NON_ADMIN_USER = "user_2ddddddddddddddddddddddddd";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mints a Clerk-shaped session JWT for `userId`, optionally carrying the
 * custom `permissions` claim `requireAdminSection`/`getSessionPermissionsClaim`
 * read — see `packages/auth/test/guards.test.ts` for the claim shape this
 * mirrors (`sessionClaims: { permissions: { auth: ["admin"] } }`).
 */
function signSessionToken(userId: string, permissions?: Record<string, string[]>): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", kid: SIGNING_KEY_ID, typ: "JWT" };
  const payload = {
    azp: "http://localhost",
    exp: issuedAt + 60,
    iat: issuedAt,
    iss: `https://${FRONTEND_API_HOST}`,
    nbf: issuedAt - 5,
    sid: `sess_${userId}`,
    sub: userId,
    v: 2,
    ...(permissions === undefined ? {} : { permissions }),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

function adminAuthHeaders(): Record<string, string> {
  return { authorization: `Bearer ${signSessionToken(ADMIN_USER, { auth: ["admin"] })}` };
}

function nonAdminAuthHeaders(): Record<string, string> {
  return { authorization: `Bearer ${signSessionToken(NON_ADMIN_USER, { auth: ["editor"] })}` };
}

interface TestContext {
  app: ReturnType<typeof buildApp>;
  cleanup: () => void;
}

/**
 * Builds an app against a throwaway SQLite file, mirroring
 * `integration-credentials.test.ts` and `user-data-authenticated-routes.test.ts`.
 */
function createTestApp(env: ApiRuntimeEnv, options: BuildApiAppOptions = {}): TestContext {
  const directory = mkdtempSync(join(tmpdir(), "unimatrix-integration-routes-"));
  const filePath = join(directory, "integration-routes.sqlite");
  const previousDatabaseUrl = process.env.DATABASE_URL;

  const instance = createDatabase({ filePath });

  migrate(instance.db, { migrationsFolder: MIGRATIONS_FOLDER });
  instance.client.close();

  process.env.DATABASE_URL = filePath;

  const app = buildApp(
    loadApiRuntimeConfig({ LOG_LEVEL: "error", NODE_ENV: "test", ...env }),
    options,
  );

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  return {
    app,
    cleanup: () => {
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

/**
 * Counts calls and returns a value derived from the count, so a caller can
 * prove the route triggered a real re-fetch (a rotated value) rather than
 * just replaying the boot-time cache.
 */
function fakeSecretsFetch(callCount: { value: number }): typeof fetch {
  const impl: typeof fetch = (input) => {
    const url = new URL(
      input instanceof URL ? input : input instanceof Request ? input.url : input,
    );
    const name = url.searchParams.get("name") ?? "";

    callCount.value += 1;

    return Promise.resolve(
      new Response(JSON.stringify({ name, value: `value-${callCount.value}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return impl;
}

const REFRESH_URL = "/integrations/admin/credentials/refresh";

void test("the route is absent when Clerk is not configured, even with a secrets store", async () => {
  const { app, cleanup } = createTestApp(SECRETS_ENV, {
    integrationNames: INTEGRATION_NAMES,
    secretsFetch: fakeSecretsFetch({ value: 0 }),
  });

  try {
    await app.ready();

    const response = await app.inject({ method: "POST", url: REFRESH_URL });

    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

void test("the route is absent when the secrets store is not configured, even with Clerk", async () => {
  const { app, cleanup } = createTestApp(CLERK_ENV);

  try {
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: REFRESH_URL,
      headers: adminAuthHeaders(),
    });

    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

void test("an unauthenticated request is refused with 401", async () => {
  const { app, cleanup } = createTestApp(
    { ...CLERK_ENV, ...SECRETS_ENV },
    { integrationNames: INTEGRATION_NAMES, secretsFetch: fakeSecretsFetch({ value: 0 }) },
  );

  try {
    await app.ready();

    const response = await app.inject({ method: "POST", url: REFRESH_URL });

    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

void test("a signed-in session lacking auth:admin is refused with 403", async () => {
  const { app, cleanup } = createTestApp(
    { ...CLERK_ENV, ...SECRETS_ENV },
    { integrationNames: INTEGRATION_NAMES, secretsFetch: fakeSecretsFetch({ value: 0 }) },
  );

  try {
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: REFRESH_URL,
      headers: nonAdminAuthHeaders(),
    });

    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup();
  }
});

void test("an admin session gets 200 with the refreshed result, and the cache is observably re-fetched", async () => {
  const { app, cleanup } = createTestApp(
    { ...CLERK_ENV, ...SECRETS_ENV },
    { integrationNames: INTEGRATION_NAMES, secretsFetch: fakeSecretsFetch({ value: 0 }) },
  );

  try {
    await app.ready();

    // The boot fetch already ran once, so the fake fetch's counter-derived
    // value is already at "value-1" in the cache. Calling the route must
    // trigger a second fetch — "value-2" — proving the handler calls
    // `refresh()` rather than serving the boot-time cache back unchanged.
    assert.equal(
      app.integrationCredentials.get(GITHUB_TOKEN_SECRET)?.reveal(),
      "value-1",
      "boot fetch precondition",
    );

    const response = await app.inject({
      method: "POST",
      url: REFRESH_URL,
      headers: adminAuthHeaders(),
    });

    assert.equal(response.statusCode, 200);

    const body: RefreshIntegrationCredentialsResponse = response.json();

    assert.deepEqual(body, { loaded: ["github/token"], denied: [], failed: [] });
    assert.equal(app.integrationCredentials.get(GITHUB_TOKEN_SECRET)?.reveal(), "value-2");
  } finally {
    await app.close();
    cleanup();
  }
});
