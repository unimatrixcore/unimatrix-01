export const DEPLOY_NODE_ENVS = ["development", "test", "production"] as const;
export const DEPLOY_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type DeployNodeEnv = (typeof DEPLOY_NODE_ENVS)[number];
export type DeployLogLevel = (typeof DEPLOY_LOG_LEVELS)[number];

/**
 * Everything about this service's runtime configuration except the Dokploy API key. Deliberately
 * excludes it, and deliberately imports no workspace package: `infra/scripts/validate-deploy-config.mjs`
 * imports this module directly, before anything has been built, and `@unimatrix/shared`'s exports
 * map points at `dist`. The key itself is read once by `loadDokployApiKey` (`src/dokploy/client.ts`)
 * and lives only in a closure inside the client — see `apps/deploy/AGENTS.md`.
 */
export interface DeployRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: DeployNodeEnv;
  logLevel: DeployLogLevel;
  dokployBaseUrl: string;
  databasePath: string;
}

export interface DeployRuntimeEnv {
  HOST?: string | undefined;
  PORT?: string | undefined;
  NODE_ENV?: string | undefined;
  LOG_LEVEL?: string | undefined;
  DOKPLOY_BASE_URL?: string | undefined;
  DOKPLOY_API_KEY?: string | undefined;
  DEPLOY_DATABASE_PATH?: string | undefined;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV: DeployNodeEnv = "development";
// 3001 is apps/api's and 3002 is apps/secrets'; a distinct default keeps `pnpm dev` off both.
const DEFAULT_PORT = 3003;

function createDeployConfigError(message: string): Error {
  return new Error(`Invalid deploy service runtime configuration: ${message}`);
}

function readOptionalString(
  variableName: keyof DeployRuntimeEnv,
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createDeployConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

function isDeployNodeEnv(value: string): value is DeployNodeEnv {
  return DEPLOY_NODE_ENVS.includes(value as DeployNodeEnv);
}

function isDeployLogLevel(value: string): value is DeployLogLevel {
  return DEPLOY_LOG_LEVELS.includes(value as DeployLogLevel);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createDeployConfigError("PORT must not be empty when it is set.");
  }

  if (!/^[0-9]+$/u.test(trimmedValue)) {
    throw createDeployConfigError(
      `PORT must be an integer between 1 and 65535. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  const port = Number(trimmedValue);

  if (port < 1 || port > 65535) {
    throw createDeployConfigError(
      `PORT must be an integer between 1 and 65535. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return port;
}

function parseNodeEnv(value: string | undefined): DeployNodeEnv {
  const nodeEnv = readOptionalString("NODE_ENV", value, DEFAULT_NODE_ENV);

  if (!isDeployNodeEnv(nodeEnv)) {
    throw createDeployConfigError(
      `NODE_ENV must be one of ${DEPLOY_NODE_ENVS.join(", ")}. Received ${JSON.stringify(nodeEnv)}.`,
    );
  }

  return nodeEnv;
}

function defaultLogLevelForNodeEnv(nodeEnv: DeployNodeEnv): DeployLogLevel {
  return nodeEnv === "development" ? "debug" : "info";
}

function parseLogLevel(value: string | undefined, nodeEnv: DeployNodeEnv): DeployLogLevel {
  if (value === undefined) {
    return defaultLogLevelForNodeEnv(nodeEnv);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createDeployConfigError("LOG_LEVEL must not be empty when it is set.");
  }

  if (!isDeployLogLevel(trimmedValue)) {
    throw createDeployConfigError(
      `LOG_LEVEL must be one of ${DEPLOY_LOG_LEVELS.join(", ")}. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return trimmedValue;
}

/**
 * Rejects anything that is not `http:`/`https:`, modelled on `parseSecretsBaseUrl` in
 * `apps/api/src/config.ts`. Dokploy's own API answers over plain HTTP inside `dokploy-network`
 * today, so `http:` is accepted rather than required to be `https:`.
 */
function parseDokployBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw createDeployConfigError("DOKPLOY_BASE_URL must be set.");
  }

  const trimmedValue = value.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmedValue);
  } catch {
    throw createDeployConfigError(
      `DOKPLOY_BASE_URL must be a valid URL. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createDeployConfigError(
      `DOKPLOY_BASE_URL must use http or https. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return trimmedValue;
}

/**
 * A presence-and-non-empty check only — this module cannot import the client that reads the key
 * (see {@link DeployRuntimeConfig}). Kept here anyway so a compose file that forgot to name the
 * variable still fails `validate-deploy-config.mjs`'s probe of this module, not just a live boot.
 */
function assertDokployApiKeyIsSet(value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) {
    throw createDeployConfigError("DOKPLOY_API_KEY must be set.");
  }
}

/**
 * Fails loud with no `DOKPLOY_BASE_URL` or `DOKPLOY_API_KEY` — this function only checks that the
 * key is set (see {@link assertDokployApiKeyIsSet}); it does not parse or return it. The caller —
 * `src/server.ts` — composes this with `loadDokployApiKey` (`src/dokploy/client.ts`) before
 * building the app.
 */
export function loadDeployRuntimeConfig(env: DeployRuntimeEnv = process.env): DeployRuntimeConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  assertDokployApiKeyIsSet(env.DOKPLOY_API_KEY);

  return {
    host: readOptionalString("HOST", env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    dokployBaseUrl: parseDokployBaseUrl(env.DOKPLOY_BASE_URL),
    databasePath: readOptionalString(
      "DEPLOY_DATABASE_PATH",
      env.DEPLOY_DATABASE_PATH,
      "local/deploy.sqlite",
    ),
  };
}
