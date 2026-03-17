export const API_NODE_ENVS = ["development", "test", "production"] as const;
export const API_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type ApiNodeEnv = (typeof API_NODE_ENVS)[number];
export type ApiLogLevel = (typeof API_LOG_LEVELS)[number];

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: ApiNodeEnv;
  logLevel: ApiLogLevel;
  trustProxy: boolean;
}

export interface ApiRuntimeEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  NODE_ENV?: string | undefined;
  LOG_LEVEL?: string | undefined;
  TRUST_PROXY?: string | undefined;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV: ApiNodeEnv = "development";
const DEFAULT_PORT = 3001;
const DEFAULT_TRUST_PROXY = false;

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

function parseTrustProxy(value: string | undefined): boolean {
  if (value === undefined) {
    return DEFAULT_TRUST_PROXY;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createApiConfigError("TRUST_PROXY must not be empty when it is set.");
  }

  if (trimmedValue === "true" || trimmedValue === "1") {
    return true;
  }

  if (trimmedValue === "false" || trimmedValue === "0") {
    return false;
  }

  throw createApiConfigError(
    `TRUST_PROXY must be one of true, 1, false, 0. Received ${JSON.stringify(trimmedValue)}.`,
  );
}

export function loadApiRuntimeConfig(env: ApiRuntimeEnv = process.env): ApiRuntimeConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  return {
    host: readOptionalString("HOST", env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
