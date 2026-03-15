export const API_NODE_ENVS = ["development", "test", "production"] as const;

export type ApiNodeEnv = (typeof API_NODE_ENVS)[number];

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: ApiNodeEnv;
}

export interface ApiRuntimeEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  NODE_ENV?: string | undefined;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV: ApiNodeEnv = "development";
const DEFAULT_PORT = 3001;

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

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
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

export function loadApiRuntimeConfig(env: ApiRuntimeEnv = process.env): ApiRuntimeConfig {
  return {
    host: readOptionalString("HOST", env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    nodeEnv: parseNodeEnv(env.NODE_ENV),
  };
}
