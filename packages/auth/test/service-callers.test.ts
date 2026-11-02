import { generateKeyPairSync, sign } from "node:crypto";
import type * as ClerkFastify from "@clerk/fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyOAuth, verifyApiKey } = vi.hoisted(() => ({
  verifyOAuth: vi.fn(),
  verifyApiKey: vi.fn(),
}));

vi.mock("@clerk/fastify", async (importOriginal) => ({
  ...(await importOriginal<typeof ClerkFastify>()),
  createClerkClient: () => ({
    idPOAuthAccessToken: { verify: verifyOAuth },
    apiKeys: { verify: verifyApiKey },
  }),
}));

import { hasServiceCapability } from "../src/index.js";
import { AuthError, createServiceCallerVerifier } from "../src/server.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://auth.example.test";
const resource = "https://canvas.example.test/mcp";
const ownerUserId = "user_owner";
const options = {
  secretKey: "sk_test_synthetic",
  publishableKey: "pk_test_synthetic",
  jwtKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  issuer,
  resource,
  ownerUserId,
  capabilities: ["canvas:read", "canvas:status"],
};
const required = ["canvas:read"];

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: ownerUserId,
    aud: resource,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 600,
    jti: "oat_synthetic",
    client_id: "client_synthetic",
    scope: "canvas:read canvas:status unrelated:write",
    ...overrides,
  };
}

function jwt(payload = claims(), header: Record<string, unknown> = {}): string {
  const signingInput = [{ alg: "RS256", typ: "at+jwt", kid: "synthetic", ...header }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

function oauthCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "oat_synthetic",
    type: "oauth_token",
    clientId: "client_synthetic",
    subject: ownerUserId,
    scopes: ["canvas:read", "canvas:status", "unrelated:write"],
    revoked: false,
    expired: false,
    expiration: Date.now() + 600_000,
    ...overrides,
  };
}

function apiCredential(overrides: Record<string, unknown> = {}) {
  return {
    ...oauthCredential(),
    id: "ak_synthetic",
    type: "api_key",
    claims: { resource },
    secret: "ak_secret_must_not_escape",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  verifyOAuth.mockResolvedValue(oauthCredential());
  verifyApiKey.mockResolvedValue(apiCredential());
});

describe("delegated service callers", () => {
  it("verifies an RSA-signed access token and current provider state", async () => {
    const token = jwt();
    const principal = await createServiceCallerVerifier(options).verifyOAuthCaller(token, required);
    expect(principal).toStrictEqual({
      credentialKind: "oauth_token",
      userId: ownerUserId,
      credentialId: "oat_synthetic",
      clientId: "client_synthetic",
      resource,
      capabilities: ["canvas:read", "canvas:status"],
    });
    expect(verifyOAuth).toHaveBeenCalledWith(token);
    expect(hasServiceCapability(principal, "canvas:read")).toBe(true);
    expect(hasServiceCapability(principal, "unrelated:write")).toBe(false);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.capabilities)).toBe(true);
    expect(JSON.stringify(principal)).not.toContain(token);
  });

  it("uses signed scp capabilities when provided by Clerk", async () => {
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(
        jwt(claims({ scp: ["canvas:read"], scope: undefined })),
        required,
      ),
    ).resolves.toHaveProperty("capabilities", ["canvas:read"]);
  });

  it("rejects malformed scp rather than falling back to broader scope", async () => {
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(
        jwt(claims({ scp: "canvas:read" })),
        required,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rechecks OAuth revocation after a successful call", async () => {
    const verifier = createServiceCallerVerifier(options);
    const token = jwt();
    await verifier.verifyOAuthCaller(token, required);
    verifyOAuth.mockResolvedValue(oauthCredential({ revoked: true }));
    await expect(verifier.verifyOAuthCaller(token, required)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(verifyOAuth).toHaveBeenCalledTimes(2);
  });

  it("accepts the intended resource in an audience array", async () => {
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(
        jwt(claims({ aud: ["https://other.example.test", resource] })),
        required,
      ),
    ).resolves.toHaveProperty("userId", ownerUserId);
  });

  it.each([
    ["wrong issuer", { iss: "https://other.example.test" }],
    ["missing issuer", { iss: undefined }],
    ["wrong resource", { aud: "https://other.example.test" }],
    ["missing resource", { aud: undefined }],
    ["wrong audience array", { aud: ["https://other.example.test"] }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 10 }],
    ["missing expiry", { exp: undefined }],
    ["future activation", { nbf: Math.floor(Date.now() / 1000) + 600 }],
  ])("rejects %s before provider verification", async (_label, override) => {
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(jwt(claims(override)), required),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });
    expect(verifyOAuth).not.toHaveBeenCalled();
  });

  it.each(["JWT", "id_token"])("rejects a token with %s header type", async (typ) => {
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(jwt(claims(), { typ }), required),
    ).rejects.toBeInstanceOf(AuthError);
    expect(verifyOAuth).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature", async () => {
    const token = jwt();
    const signatureStart = token.lastIndexOf(".") + 1;
    const tampered = `${token.slice(0, signatureStart)}${token[signatureStart] === "A" ? "B" : "A"}${token.slice(signatureStart + 1)}`;
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(tampered, required),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(verifyOAuth).not.toHaveBeenCalled();
  });

  it.each(["oat_opaque", "ak_other", "mt_other", "", "not-a-token"])(
    "rejects credential without signed resource evidence: %s",
    async (token) => {
      await expect(
        createServiceCallerVerifier(options).verifyOAuthCaller(token, required),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(verifyOAuth).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["credential id", { id: "oat_other" }],
    ["client id", { clientId: "client_other" }],
    ["subject", { subject: "user_other" }],
    ["credential kind", { type: "api_key" }],
    ["revoked", { revoked: true }],
    ["expired flag", { expired: true }],
    ["past expiry", { expiration: Date.now() - 1 }],
    ["missing expiry", { expiration: null }],
  ])("rejects current provider %s mismatch", async (_label, override) => {
    verifyOAuth.mockResolvedValue(oauthCredential(override));
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(jwt(), required),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each(["user_other", "org_owner"])("rejects verified non-owner %s", async (subject) => {
    verifyOAuth.mockResolvedValue(oauthCredential({ subject }));
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(
        jwt(claims({ sub: subject })),
        required,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it.each([
    ["signed consent", { scope: "canvas:status" }, ["canvas:read"]],
    ["current provider scope", { scope: "canvas:read" }, ["canvas:status"]],
  ])("requires capabilities in %s", async (_label, override, scopes) => {
    verifyOAuth.mockResolvedValue(oauthCredential({ scopes }));
    await expect(
      createServiceCallerVerifier(options).verifyOAuthCaller(jwt(claims(override)), required),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("programmatic service callers", () => {
  it("returns only the verified owner and recognized capabilities", async () => {
    const principal = await createServiceCallerVerifier(options).verifyApiKeyCaller(
      "ak_synthetic_secret",
      required,
    );
    expect(principal).toStrictEqual({
      credentialKind: "api_key",
      userId: ownerUserId,
      credentialId: "ak_synthetic",
      clientId: null,
      resource,
      capabilities: ["canvas:read", "canvas:status"],
    });
    expect(verifyApiKey).toHaveBeenCalledWith("ak_synthetic_secret");
    expect(JSON.stringify(principal)).not.toContain("secret");
  });

  it("accepts a provider-managed key without an expiry", async () => {
    verifyApiKey.mockResolvedValue(apiCredential({ expiration: null }));
    await expect(
      createServiceCallerVerifier(options).verifyApiKeyCaller("ak_synthetic", required),
    ).resolves.toHaveProperty("credentialKind", "api_key");
  });

  it.each([
    ["wrong owner", { subject: "user_other" }, 403],
    ["organization owner", { subject: "org_owner", createdBy: ownerUserId }, 403],
    ["wrong resource", { claims: { resource: "https://other.example.test" } }, 401],
    ["missing resource", { claims: null }, 401],
    ["wrong kind", { type: "oauth_token" }, 401],
    ["empty id", { id: "" }, 401],
    ["revoked", { revoked: true }, 401],
    ["expired flag", { expired: true }, 401],
    ["past expiry", { expiration: Date.now() - 1 }, 401],
    ["invalid expiry", { expiration: Number.NaN }, 401],
    ["missing scope", { scopes: ["canvas:status"] }, 403],
    ["malformed scopes", { scopes: "canvas:read" }, 401],
    [
      "admin without scopes",
      { scopes: [], claims: { resource, permissions: { auth: ["admin"] } } },
      403,
    ],
  ])("rejects %s", async (_label, override, statusCode) => {
    verifyApiKey.mockResolvedValue(apiCredential(override));
    await expect(
      createServiceCallerVerifier(options).verifyApiKeyCaller("ak_synthetic", required),
    ).rejects.toMatchObject({ statusCode });
  });

  it.each(["oat_other", "mt_other", "session_token", ""])(
    "rejects non-key credential %s before provider verification",
    async (token) => {
      await expect(
        createServiceCallerVerifier(options).verifyApiKeyCaller(token, required),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(verifyApiKey).not.toHaveBeenCalled();
    },
  );

  it.each([
    { capabilities: [] },
    { capabilities: ["unrelated:write"] },
    { capabilities: ["canvas:read", "canvas:missing"] },
  ])("requires every explicitly recognized capability: %j", async ({ capabilities }) => {
    await expect(
      createServiceCallerVerifier(options).verifyApiKeyCaller("ak_synthetic", capabilities),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rechecks provider revocation on every call", async () => {
    const verifier = createServiceCallerVerifier(options);
    await verifier.verifyApiKeyCaller("ak_synthetic", required);
    verifyApiKey.mockResolvedValue(apiCredential({ revoked: true }));
    await expect(verifier.verifyApiKeyCaller("ak_synthetic", required)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(verifyApiKey).toHaveBeenCalledTimes(2);
  });
});

describe("service caller verification failures", () => {
  it.each(["oauth", "key"])("sanitizes %s provider failures", async (kind) => {
    const providerError = new Error("upstream exposed ak_private_token and coursework");
    verifyOAuth.mockRejectedValue(providerError);
    verifyApiKey.mockRejectedValue(providerError);
    const verifier = createServiceCallerVerifier(options);
    const result =
      kind === "oauth"
        ? verifier.verifyOAuthCaller(jwt(), required)
        : verifier.verifyApiKeyCaller("ak_synthetic", required);
    await expect(result).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 401,
      message: "Authentication is required to access this resource.",
    });
    await expect(result).rejects.not.toHaveProperty("cause");
  });

  it.each([
    { ownerUserId: "" },
    { ownerUserId: "org_owner" },
    { resource: "http://canvas.example.test" },
    { resource: "https://user:password@canvas.example.test" },
    { resource: "https://canvas.example.test/#fragment" },
    { issuer: "not-a-url" },
    { capabilities: [] },
    { capabilities: ["bad scope"] },
    { secretKey: " " },
    { jwtKey: " " },
    { publishableKey: " " },
  ])("rejects invalid boot policy %j", (override) => {
    expect(() => createServiceCallerVerifier({ ...options, ...override })).toThrow(
      "Invalid service caller verification configuration.",
    );
  });
});
