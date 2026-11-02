import { isIP } from "node:net";

export interface CanvasConfig {
  host: string;
  port: number;
  ownerUserId: string;
  resource: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  secretKey: string;
  publishableKey: string;
  jwtKey: string;
  issuer: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim() || value !== value.trim()) throw new Error(`Invalid ${name}.`);
  return value;
}

function httpsUrl(env: NodeJS.ProcessEnv, name: string): URL {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}.`);
  }
  return url;
}

function hostnames(env: NodeJS.ProcessEnv, name: string): string[] {
  const values = required(env, name)
    .split(",")
    .map((value) => value.trim());
  if (
    values.some((value) => !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[::1\])$/u.test(value))
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return [...new Set(values)];
}

export function loadCanvasConfig(env: NodeJS.ProcessEnv = process.env): CanvasConfig {
  const ownerUserId = required(env, "CANVAS_OWNER_USER_ID");
  if (!/^user_\S+$/u.test(ownerUserId)) throw new Error("Invalid CANVAS_OWNER_USER_ID.");
  const resource = httpsUrl(env, "CANVAS_RESOURCE_URL");
  if (resource.pathname !== "/mcp") throw new Error("Invalid CANVAS_RESOURCE_URL.");
  httpsUrl(env, "CLERK_ISSUER");
  const allowedHosts = hostnames(env, "CANVAS_ALLOWED_HOSTS");
  const allowedOrigins = hostnames(env, "CANVAS_ALLOWED_ORIGINS");
  if (!allowedHosts.includes(resource.hostname)) throw new Error("Invalid CANVAS_ALLOWED_HOSTS.");
  const rawPort = env.PORT ?? "3020";
  const port = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT.");
  }
  const host = env.HOST === undefined ? "127.0.0.1" : required(env, "HOST");
  if (
    isIP(host) === 0 &&
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(
      host,
    )
  ) {
    throw new Error("Invalid HOST.");
  }
  return {
    host,
    port,
    ownerUserId,
    resource: resource.href,
    allowedHosts,
    allowedOrigins,
    secretKey: required(env, "CLERK_SECRET_KEY"),
    publishableKey: required(env, "CLERK_PUBLISHABLE_KEY"),
    jwtKey: required(env, "CLERK_JWT_KEY"),
    issuer: required(env, "CLERK_ISSUER"),
  };
}
