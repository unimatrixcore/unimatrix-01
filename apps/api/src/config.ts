import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/**
 * This module imports no workspace package, and must not start:
 * `infra/scripts/validate-deploy-config.mjs` imports it directly on every
 * `pnpm check`, before anything is built, and `@unimatrix/shared`'s main
 * entry resolves only through a `dist` that does not exist at that point.
 * `apps/secrets/src/config.ts` carries the same constraint.
 */

export const API_NODE_ENVS = ["development", "test", "production"] as const;
export const API_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const DEFAULT_API_CORS_ALLOWED_ORIGINS = [
  "https://unimatrix-01.dev",
  "https://*.unimatrix-01.dev",
  "https://omnimatrix.dev",
  "https://*.omnimatrix.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "http://localhost:4175",
  "http://127.0.0.1:4175",
] as const;

export type ApiNodeEnv = (typeof API_NODE_ENVS)[number];
export type ApiLogLevel = (typeof API_LOG_LEVELS)[number];
export type ApiTrustProxy = boolean | string;
export type ApiCorsProtocol = "http:" | "https:";

export interface ApiCorsExactOriginRule {
  kind: "exact";
  origin: string;
}

export interface ApiCorsWildcardSubdomainOriginRule {
  kind: "wildcard-subdomain";
  protocol: ApiCorsProtocol;
  domainSuffix: string;
  port: string | null;
}

export type ApiCorsOriginRule = ApiCorsExactOriginRule | ApiCorsWildcardSubdomainOriginRule;

export interface ApiCorsConfig {
  allowedOrigins: ApiCorsOriginRule[];
}

/**
 * Clerk configuration, present only when all three `CLERK_*` env vars are
 * set. See {@link loadApiRuntimeConfig} for the required/optional rules.
 */
export interface ApiClerkConfig {
  secretKey: string;
  publishableKey: string;
  jwtKey: string;
}

/**
 * How to reach the secrets service, present only when both
 * `SECRETS_BASE_URL` and `SECRETS_SERVICE_TOKEN` are set. See
 * {@link loadApiRuntimeConfig} for the all-or-none rule — unlike Clerk,
 * neither var is required in production, because no integration is
 * configured yet.
 *
 * *Which* credentials exist is not configuration: `SECRET_REGISTRY` in
 * `@unimatrix/shared` declares them, read by the plugins rather than here.
 */
export interface ApiSecretsStoreConfig {
  baseUrl: string;
  serviceToken: string;
  /**
   * A `manage`-capability token scoped to `integrations`, present only when
   * `SECRETS_INTEGRATIONS_MANAGE_TOKEN` is set. `null` when absent — the
   * admin secrets routes are unregistered in that case, the same "absent
   * rather than broken" shape `integrationsModule` uses for a missing
   * `secretsStore`. See {@link parseSecretsStoreConfig} for why no two of
   * the three tokens here may be equal.
   */
  integrationsManageToken: string | null;
  /**
   * A `write`-capability token scoped to `platform`: it can create and
   * rotate but never delete. Separate from
   * {@link ApiSecretsStoreConfig.integrationsManageToken} because a service
   * token carries exactly one scope prefix with no wildcard
   * (`scopeCoversName` in `apps/secrets`), so no single token reaches both
   * tiers — and one that did would carry delete rights over `platform/*`
   * whatever capability it held.
   */
  platformWriteToken: string | null;
  /**
   * The store's own server certificate, PEM text decoded from
   * `SECRETS_TLS_CERT_BASE64`. Required whenever `baseUrl` is `https://` and
   * refused when it is `http://`, because the store's certificate is
   * self-signed: with no pin the connection falls back to the system trust
   * store, which does not carry it, and every read fails at runtime instead
   * of at boot with a variable name attached. `null` only for a plain-HTTP
   * base URL.
   */
  caCertificatePem: string | null;
}

export interface ApiDeployServiceConfig {
  baseUrl: string;
  serviceToken: string;
  caCertificatePem: string | null;
}

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: ApiNodeEnv;
  logLevel: ApiLogLevel;
  trustProxy: ApiTrustProxy;
  cors: ApiCorsConfig;
  clerk: ApiClerkConfig | null;
  secretsStore: ApiSecretsStoreConfig | null;
  deployService: ApiDeployServiceConfig | null;
  maxUploadBytes: number;
  /**
   * Cumulative ceiling on the bytes one user may keep in `user_documents`
   * plus `user_files` combined. Distinct from {@link maxUploadBytes}, which
   * bounds a single request: without a cumulative bound, a caller can stay
   * under the per-request limit indefinitely and still fill the volume.
   */
  maxUserStorageBytes: number;
  runDatabaseMigrations: boolean;
}

export interface ApiRuntimeEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  NODE_ENV?: string | undefined;
  LOG_LEVEL?: string | undefined;
  TRUST_PROXY?: string | undefined;
  CORS_ALLOWED_ORIGINS?: string | undefined;
  CLERK_SECRET_KEY?: string | undefined;
  CLERK_PUBLISHABLE_KEY?: string | undefined;
  CLERK_JWT_KEY?: string | undefined;
  DEPLOY_BASE_URL?: string | undefined;
  DEPLOY_SERVICE_TOKEN?: string | undefined;
  DEPLOY_TLS_CERT_BASE64?: string | undefined;
  SECRETS_BASE_URL?: string | undefined;
  SECRETS_SERVICE_TOKEN?: string | undefined;
  SECRETS_INTEGRATIONS_MANAGE_TOKEN?: string | undefined;
  SECRETS_PLATFORM_WRITE_TOKEN?: string | undefined;
  SECRETS_TLS_CERT_BASE64?: string | undefined;
  MAX_UPLOAD_BYTES?: string | undefined;
  MAX_USER_STORAGE_BYTES?: string | undefined;
  DB_MIGRATE_ON_START?: string | undefined;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV: ApiNodeEnv = "development";
const DEFAULT_PORT = 3001;
const DEFAULT_TRUST_PROXY = false;
const DEFAULT_MAX_UPLOAD_BYTES = 5_242_880;
/** 50 MiB per user across documents and files combined. */
const DEFAULT_MAX_USER_STORAGE_BYTES = 52_428_800;
const WILDCARD_CORS_ALLOWED_ORIGIN_PATTERN = /^(https?):\/\/\*\.([^/?#:]+)(?::([0-9]+))?$/iu;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function createApiConfigError(message: string): Error {
  return new Error(`Invalid API runtime configuration: ${message}`);
}

function readOptionalString(
  variableName: keyof ApiRuntimeEnv,
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

function isApiNodeEnv(value: string): value is ApiNodeEnv {
  return API_NODE_ENVS.includes(value as ApiNodeEnv);
}

function isApiLogLevel(value: string): value is ApiLogLevel {
  return API_LOG_LEVELS.includes(value as ApiLogLevel);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError("PORT must not be empty when it is set.");
  }

  if (!/^[0-9]+$/u.test(trimmedValue)) {
    throw createApiConfigError(
      `PORT must be an integer between 1 and 65535. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  const port = Number(trimmedValue);

  if (port < 1 || port > 65535) {
    throw createApiConfigError(
      `PORT must be an integer between 1 and 65535. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return port;
}

/**
 * Shared parser for the byte-count env vars. Both `MAX_UPLOAD_BYTES` and
 * `MAX_USER_STORAGE_BYTES` mean the same thing to a reader — a positive
 * integer number of bytes — so they get the same validation and the same
 * error wording rather than two copies that can drift apart.
 */
function parseByteCount(
  variableName: "MAX_UPLOAD_BYTES" | "MAX_USER_STORAGE_BYTES",
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError(`${variableName} must not be empty when it is set.`);
  }

  if (!/^[0-9]+$/u.test(trimmedValue)) {
    throw createApiConfigError(
      `${variableName} must be a positive integer. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  const byteCount = Number(trimmedValue);

  if (!Number.isSafeInteger(byteCount) || byteCount < 1) {
    throw createApiConfigError(
      `${variableName} must be a positive integer. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return byteCount;
}

function parseRunDatabaseMigrations(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError("DB_MIGRATE_ON_START must not be empty when it is set.");
  }

  if (trimmedValue === "true" || trimmedValue === "1") {
    return true;
  }

  if (trimmedValue === "false" || trimmedValue === "0") {
    return false;
  }

  throw createApiConfigError(
    `DB_MIGRATE_ON_START must be one of true, 1, false, 0. Received ${JSON.stringify(trimmedValue)}.`,
  );
}

function parseNodeEnv(value: string | undefined): ApiNodeEnv {
  const nodeEnv = readOptionalString("NODE_ENV", value, DEFAULT_NODE_ENV);

  if (!isApiNodeEnv(nodeEnv)) {
    throw createApiConfigError(
      `NODE_ENV must be one of ${API_NODE_ENVS.join(", ")}. Received ${JSON.stringify(nodeEnv)}.`,
    );
  }

  return nodeEnv;
}

function defaultLogLevelForNodeEnv(nodeEnv: ApiNodeEnv): ApiLogLevel {
  return nodeEnv === "development" ? "debug" : "info";
}

function parseLogLevel(value: string | undefined, nodeEnv: ApiNodeEnv): ApiLogLevel {
  if (value === undefined) {
    return defaultLogLevelForNodeEnv(nodeEnv);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError("LOG_LEVEL must not be empty when it is set.");
  }

  if (!isApiLogLevel(trimmedValue)) {
    throw createApiConfigError(
      `LOG_LEVEL must be one of ${API_LOG_LEVELS.join(", ")}. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return trimmedValue;
}

function parseTrustProxy(value: string | undefined): ApiTrustProxy {
  if (value === undefined) {
    return DEFAULT_TRUST_PROXY;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError("TRUST_PROXY must not be empty when it is set.");
  }

  if (trimmedValue === "true") {
    return true;
  }

  if (trimmedValue === "1") {
    throw createApiConfigError(
      "TRUST_PROXY=1 is unsupported. Set the immediate proxy's explicit IP address instead of a hop count.",
    );
  }

  if (trimmedValue === "false" || trimmedValue === "0") {
    return false;
  }

  if (isIP(trimmedValue) !== 0) {
    return trimmedValue;
  }

  throw createApiConfigError(
    `TRUST_PROXY must be an explicit IP address or one of true, false, 0. Received ${JSON.stringify(trimmedValue)}.`,
  );
}

function isApiCorsProtocol(value: string): value is ApiCorsProtocol {
  return value === "http:" || value === "https:";
}

function normalizeOriginPort(protocol: ApiCorsProtocol, port: string | undefined): string | null {
  if (port === undefined || port.length === 0) {
    return null;
  }

  if (!/^[0-9]+$/u.test(port)) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard origin port must be an integer between 1 and 65535. Received ${JSON.stringify(port)}.`,
    );
  }

  const portNumber = Number(port);

  if (portNumber < 1 || portNumber > 65535) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard origin port must be an integer between 1 and 65535. Received ${JSON.stringify(port)}.`,
    );
  }

  const normalizedPort = String(portNumber);

  if (
    (protocol === "http:" && normalizedPort === "80") ||
    (protocol === "https:" && normalizedPort === "443")
  ) {
    return null;
  }

  return normalizedPort;
}

function hasAuthorityOnlyOriginSyntax(value: string): boolean {
  const schemeDelimiterIndex = value.indexOf("://");

  if (schemeDelimiterIndex === -1) {
    return false;
  }

  const authority = value.slice(schemeDelimiterIndex + 3);

  return authority.length > 0 && !/[/?#]/u.test(authority);
}

function parseExactCorsAllowedOriginRule(token: string): ApiCorsExactOriginRule {
  let url: URL;

  try {
    url = new URL(token);
  } catch {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS entries must be valid http:// or https:// origins. Received ${JSON.stringify(token)}.`,
    );
  }

  if (!isApiCorsProtocol(url.protocol)) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS entries must use http:// or https://. Received ${JSON.stringify(token)}.`,
    );
  }

  if (!hasAuthorityOnlyOriginSyntax(token)) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS entries must not include a path, query, or fragment. Received ${JSON.stringify(token)}.`,
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS entries must not include username or password information. Received ${JSON.stringify(token)}.`,
    );
  }

  return {
    kind: "exact",
    origin: url.origin,
  };
}

function validateWildcardDomainSuffix(token: string, domainSuffix: string): void {
  if (domainSuffix === "localhost") {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard entries must not target localhost. Received ${JSON.stringify(token)}.`,
    );
  }

  const labels = domainSuffix.split(".");

  if (
    isIP(domainSuffix) !== 0 ||
    labels.length < 2 ||
    labels.some((label) => !HOST_LABEL_PATTERN.test(label))
  ) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard entries must include a real domain suffix. Received ${JSON.stringify(token)}.`,
    );
  }
}

function parseWildcardCorsAllowedOriginRule(token: string): ApiCorsWildcardSubdomainOriginRule {
  const wildcardMatch = WILDCARD_CORS_ALLOWED_ORIGIN_PATTERN.exec(token);

  if (wildcardMatch === null) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard entries must use the form https://*.example.com or http://*.example.com. Received ${JSON.stringify(token)}.`,
    );
  }

  const protocolValue = wildcardMatch[1];
  const domainSuffixValue = wildcardMatch[2];
  const portValue = wildcardMatch[3];

  if (protocolValue === undefined || domainSuffixValue === undefined) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard entries must use the form https://*.example.com or http://*.example.com. Received ${JSON.stringify(token)}.`,
    );
  }

  const protocol = `${protocolValue.toLowerCase()}:`;

  if (!isApiCorsProtocol(protocol)) {
    throw createApiConfigError(
      `CORS_ALLOWED_ORIGINS wildcard entries must use http:// or https://. Received ${JSON.stringify(token)}.`,
    );
  }

  const domainSuffix = domainSuffixValue.toLowerCase();
  validateWildcardDomainSuffix(token, domainSuffix);

  return {
    kind: "wildcard-subdomain",
    protocol,
    domainSuffix,
    port: normalizeOriginPort(protocol, portValue),
  };
}

function parseCorsAllowedOriginRule(token: string): ApiCorsOriginRule {
  if (token.includes("*")) {
    return parseWildcardCorsAllowedOriginRule(token);
  }

  return parseExactCorsAllowedOriginRule(token);
}

function parseCorsAllowedOrigins(value: string | undefined): ApiCorsConfig {
  const originTokens =
    value === undefined
      ? [...DEFAULT_API_CORS_ALLOWED_ORIGINS]
      : value.split(",").map((token) => token.trim());

  if (originTokens.some((token) => token.length === 0)) {
    throw createApiConfigError("CORS_ALLOWED_ORIGINS must not contain blank entries.");
  }

  return {
    allowedOrigins: originTokens.map((token) => parseCorsAllowedOriginRule(token)),
  };
}

function originPortForMatching(url: URL): string | null {
  if (url.port.length === 0) {
    return null;
  }

  const portNumber = Number(url.port);

  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    return null;
  }

  if (
    (url.protocol === "http:" && portNumber === 80) ||
    (url.protocol === "https:" && portNumber === 443)
  ) {
    return null;
  }

  return String(portNumber);
}

export function isApiCorsOriginAllowed(
  corsConfig: ApiCorsConfig,
  origin: string | undefined,
): boolean {
  if (origin === undefined) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (!isApiCorsProtocol(url.protocol) || origin !== url.origin) {
    return false;
  }

  return corsConfig.allowedOrigins.some((rule) => {
    if (rule.kind === "exact") {
      return rule.origin === url.origin;
    }

    return (
      rule.protocol === url.protocol &&
      rule.port === originPortForMatching(url) &&
      url.hostname !== rule.domainSuffix &&
      url.hostname.endsWith(`.${rule.domainSuffix}`)
    );
  });
}

function readOptionalTrimmedValue(
  variableName: keyof ApiRuntimeEnv,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

/**
 * Parses the `CLERK_*` env vars into an {@link ApiClerkConfig}, or `null`
 * when Clerk is not configured. In production all three vars are
 * required; outside production they must either all be present or all be
 * absent (a partial set is treated as a misconfiguration and throws).
 */
function parseClerkConfig(env: ApiRuntimeEnv, nodeEnv: ApiNodeEnv): ApiClerkConfig | null {
  const secretKey = readOptionalTrimmedValue("CLERK_SECRET_KEY", env.CLERK_SECRET_KEY);
  const publishableKey = readOptionalTrimmedValue(
    "CLERK_PUBLISHABLE_KEY",
    env.CLERK_PUBLISHABLE_KEY,
  );
  const jwtKey = readOptionalTrimmedValue("CLERK_JWT_KEY", env.CLERK_JWT_KEY);

  if (secretKey !== undefined && publishableKey !== undefined && jwtKey !== undefined) {
    return { secretKey, publishableKey, jwtKey };
  }

  const missingVariableNames = [
    secretKey === undefined ? "CLERK_SECRET_KEY" : undefined,
    publishableKey === undefined ? "CLERK_PUBLISHABLE_KEY" : undefined,
    jwtKey === undefined ? "CLERK_JWT_KEY" : undefined,
  ].filter((name): name is string => name !== undefined);

  if (missingVariableNames.length === 3 && nodeEnv !== "production") {
    return null;
  }

  throw createApiConfigError(
    nodeEnv === "production"
      ? `${missingVariableNames.join(", ")} must be set in production.`
      : `${missingVariableNames.join(", ")} must be set together with the other CLERK_* variables, or CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, and CLERK_JWT_KEY must all be left unset outside production.`,
  );
}

function parseSecretsBaseUrl(value: string | undefined): string | undefined {
  const trimmedValue = readOptionalTrimmedValue("SECRETS_BASE_URL", value);

  if (trimmedValue === undefined) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(trimmedValue);
  } catch {
    throw createApiConfigError(
      `SECRETS_BASE_URL must be a valid http:// or https:// URL. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw createApiConfigError(
      `SECRETS_BASE_URL must use http:// or https://. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return trimmedValue;
}

/**
 * Decodes the store's certificate from base64 PEM. The `-----BEGIN` check
 * mirrors `apps/secrets/src/config.ts`: `Buffer.from` drops characters
 * outside the base64 alphabet rather than throwing, so a mangled paste would
 * otherwise reach the TLS handshake as an opaque failure on the first read.
 */
function parseSecretsCaCertificate(value: string): string {
  const pem = Buffer.from(value, "base64").toString("utf8");

  if (!pem.includes("-----BEGIN")) {
    throw createApiConfigError(
      'SECRETS_TLS_CERT_BASE64 must be a base64-encoded PEM certificate. The decoded value contains no "-----BEGIN" line.',
    );
  }

  return pem;
}

function createSharedSecretsTokenError(variableName: string, otherVariableName: string): Error {
  return createApiConfigError(
    `${variableName} must not equal ${otherVariableName} — the store answers a wrong-capability caller with the same 404 it uses for a missing name, so a shared token boots cleanly and fails silently.`,
  );
}

function createUnconfiguredSecretsTokenError(variableName: string): Error {
  return createApiConfigError(
    `${variableName} must not be set unless SECRETS_BASE_URL and SECRETS_SERVICE_TOKEN are both configured.`,
  );
}

/**
 * Parses `SECRETS_BASE_URL`/`SECRETS_SERVICE_TOKEN` plus the two admin-console
 * tokens into an {@link ApiSecretsStoreConfig}, or `null` when the store is
 * not configured. Unlike {@link parseClerkConfig}, none of these is required
 * in any environment — no integration is configured yet — but the first pair
 * is all-or-none: a lone `SECRETS_BASE_URL` or `SECRETS_SERVICE_TOKEN` is a
 * misconfiguration. Either admin token may only be set once the store itself
 * is configured, and `SECRETS_TLS_CERT_BASE64` tracks the base URL's scheme
 * exactly — required for `https://`, refused for `http://`.
 *
 * The rule that matters most here is that no two of the three tokens may be
 * equal. `apps/secrets` answers a wrong-capability caller with a
 * byte-identical 404 to "not found" (`denySecretAccess`) — there is nothing in
 * that response that distinguishes "this name does not exist" from "this token
 * cannot do that". Pasting one token into two env vars would boot cleanly, the
 * admin console would render, and every call the token lacks the capability or
 * the scope for would read as "not found" with nothing anywhere saying why.
 * Failing at boot, in this loader, is the only point where the mistake is
 * cheap to catch.
 */
function parseSecretsStoreConfig(env: ApiRuntimeEnv): ApiSecretsStoreConfig | null {
  const baseUrl = parseSecretsBaseUrl(env.SECRETS_BASE_URL);
  const serviceToken = readOptionalTrimmedValue("SECRETS_SERVICE_TOKEN", env.SECRETS_SERVICE_TOKEN);
  const integrationsManageToken = readOptionalTrimmedValue(
    "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
    env.SECRETS_INTEGRATIONS_MANAGE_TOKEN,
  );
  const platformWriteToken = readOptionalTrimmedValue(
    "SECRETS_PLATFORM_WRITE_TOKEN",
    env.SECRETS_PLATFORM_WRITE_TOKEN,
  );
  const encodedCaCertificate = readOptionalTrimmedValue(
    "SECRETS_TLS_CERT_BASE64",
    env.SECRETS_TLS_CERT_BASE64,
  );

  if (baseUrl !== undefined && serviceToken !== undefined) {
    if (integrationsManageToken === serviceToken) {
      throw createSharedSecretsTokenError(
        "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
        "SECRETS_SERVICE_TOKEN",
      );
    }

    if (platformWriteToken === serviceToken) {
      throw createSharedSecretsTokenError("SECRETS_PLATFORM_WRITE_TOKEN", "SECRETS_SERVICE_TOKEN");
    }

    // The `!== undefined` guard is what stops two absent tokens comparing
    // equal to each other and failing a boot that is correctly configured.
    if (platformWriteToken !== undefined && platformWriteToken === integrationsManageToken) {
      throw createSharedSecretsTokenError(
        "SECRETS_PLATFORM_WRITE_TOKEN",
        "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
      );
    }

    // Through the parsed URL rather than the raw string: `parseSecretsBaseUrl`
    // returns what was configured, and `HTTPS://secrets:3001` is a valid URL
    // whose `protocol` normalises to `https:` while a `startsWith` check on the
    // original text reads it as plain HTTP.
    const isHttps = new URL(baseUrl).protocol === "https:";

    if (isHttps && encodedCaCertificate === undefined) {
      throw createApiConfigError(
        "SECRETS_TLS_CERT_BASE64 must be set when SECRETS_BASE_URL is https:// — the store's " +
          "certificate is self-signed, so without it every read fails against the system trust " +
          "store at runtime rather than here at boot.",
      );
    }

    if (!isHttps && encodedCaCertificate !== undefined) {
      throw createApiConfigError(
        "SECRETS_TLS_CERT_BASE64 must not be set when SECRETS_BASE_URL is http:// — the " +
          "certificate would be silently unused and the connection would stay in cleartext.",
      );
    }

    return {
      baseUrl,
      serviceToken,
      integrationsManageToken: integrationsManageToken ?? null,
      platformWriteToken: platformWriteToken ?? null,
      caCertificatePem:
        encodedCaCertificate === undefined ? null : parseSecretsCaCertificate(encodedCaCertificate),
    };
  }

  if (baseUrl === undefined && serviceToken === undefined) {
    if (integrationsManageToken !== undefined) {
      throw createUnconfiguredSecretsTokenError("SECRETS_INTEGRATIONS_MANAGE_TOKEN");
    }

    if (platformWriteToken !== undefined) {
      throw createUnconfiguredSecretsTokenError("SECRETS_PLATFORM_WRITE_TOKEN");
    }

    if (encodedCaCertificate !== undefined) {
      throw createUnconfiguredSecretsTokenError("SECRETS_TLS_CERT_BASE64");
    }

    return null;
  }

  throw createApiConfigError(
    "SECRETS_BASE_URL and SECRETS_SERVICE_TOKEN must be set together, or both left unset.",
  );
}

function parseDeployServiceConfig(
  env: ApiRuntimeEnv,
  nodeEnv: ApiNodeEnv,
): ApiDeployServiceConfig | null {
  const baseUrl = readOptionalTrimmedValue("DEPLOY_BASE_URL", env.DEPLOY_BASE_URL);
  const serviceToken = readOptionalTrimmedValue("DEPLOY_SERVICE_TOKEN", env.DEPLOY_SERVICE_TOKEN);
  const certificate = readOptionalTrimmedValue(
    "DEPLOY_TLS_CERT_BASE64",
    env.DEPLOY_TLS_CERT_BASE64,
  );

  if (baseUrl === undefined && serviceToken === undefined && certificate === undefined) {
    return null;
  }
  if (baseUrl === undefined || serviceToken === undefined) {
    throw createApiConfigError(
      "DEPLOY_BASE_URL and DEPLOY_SERVICE_TOKEN must be set together; DEPLOY_TLS_CERT_BASE64 requires both.",
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw createApiConfigError("DEPLOY_BASE_URL must be a valid http:// or https:// origin.");
  }
  if (
    !/^https?:\/\/[^\s/?#@\\]+\/?$/iu.test(baseUrl) ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw createApiConfigError(
      "DEPLOY_BASE_URL must be an http:// or https:// origin without credentials, path, query, or fragment.",
    );
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw createApiConfigError("DEPLOY_BASE_URL must use https:// in production.");
  }
  if (url.protocol === "https:" && certificate === undefined) {
    throw createApiConfigError(
      "DEPLOY_TLS_CERT_BASE64 must be set when DEPLOY_BASE_URL is https://.",
    );
  }
  if (url.protocol === "http:" && certificate !== undefined) {
    throw createApiConfigError(
      "DEPLOY_TLS_CERT_BASE64 must not be set when DEPLOY_BASE_URL is http://.",
    );
  }

  const caCertificatePem =
    certificate === undefined ? null : Buffer.from(certificate, "base64").toString("utf8");
  if (caCertificatePem !== null) {
    try {
      new X509Certificate(caCertificatePem);
    } catch {
      throw createApiConfigError(
        "DEPLOY_TLS_CERT_BASE64 must be a base64-encoded PEM certificate.",
      );
    }
  }
  return { baseUrl: url.origin, serviceToken, caCertificatePem };
}

export function loadApiRuntimeConfig(env: ApiRuntimeEnv = process.env): ApiRuntimeConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  return {
    host: readOptionalString("HOST", env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cors: parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
    clerk: parseClerkConfig(env, nodeEnv),
    secretsStore: parseSecretsStoreConfig(env),
    deployService: parseDeployServiceConfig(env, nodeEnv),
    maxUploadBytes: parseByteCount(
      "MAX_UPLOAD_BYTES",
      env.MAX_UPLOAD_BYTES,
      DEFAULT_MAX_UPLOAD_BYTES,
    ),
    maxUserStorageBytes: parseByteCount(
      "MAX_USER_STORAGE_BYTES",
      env.MAX_USER_STORAGE_BYTES,
      DEFAULT_MAX_USER_STORAGE_BYTES,
    ),
    runDatabaseMigrations: parseRunDatabaseMigrations(env.DB_MIGRATE_ON_START),
  };
}
