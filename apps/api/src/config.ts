import { isIP } from "node:net";

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
] as const;

export type ApiNodeEnv = (typeof API_NODE_ENVS)[number];
export type ApiLogLevel = (typeof API_LOG_LEVELS)[number];
export type ApiTrustProxy = boolean | 1;
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

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: ApiNodeEnv;
  logLevel: ApiLogLevel;
  trustProxy: ApiTrustProxy;
  cors: ApiCorsConfig;
}

export interface ApiRuntimeEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  NODE_ENV?: string | undefined;
  LOG_LEVEL?: string | undefined;
  TRUST_PROXY?: string | undefined;
  CORS_ALLOWED_ORIGINS?: string | undefined;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV: ApiNodeEnv = "development";
const DEFAULT_PORT = 3001;
const DEFAULT_TRUST_PROXY = false;
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
    return 1;
  }

  if (trimmedValue === "false" || trimmedValue === "0") {
    return false;
  }

  throw createApiConfigError(
    `TRUST_PROXY must be one of true, 1, false, 0. Received ${JSON.stringify(trimmedValue)}.`,
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

  if ((protocol === "http:" && normalizedPort === "80") || (protocol === "https:" && normalizedPort === "443")) {
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

  if (isIP(domainSuffix) !== 0 || labels.length < 2 || labels.some((label) => !HOST_LABEL_PATTERN.test(label))) {
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
    value === undefined ? [...DEFAULT_API_CORS_ALLOWED_ORIGINS] : value.split(",").map((token) => token.trim());

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

  if ((url.protocol === "http:" && portNumber === 80) || (url.protocol === "https:" && portNumber === 443)) {
    return null;
  }

  return String(portNumber);
}

export function isApiCorsOriginAllowed(corsConfig: ApiCorsConfig, origin: string | undefined): boolean {
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

export function loadApiRuntimeConfig(env: ApiRuntimeEnv = process.env): ApiRuntimeConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  return {
    host: readOptionalString("HOST", env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cors: parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
  };
}
