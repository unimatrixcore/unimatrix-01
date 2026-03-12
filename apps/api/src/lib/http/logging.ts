import type { FastifyServerOptions } from "fastify";

import type { ApiRuntimeConfig } from "../../config.js";

type ApiLoggerOptions = Exclude<
  NonNullable<FastifyServerOptions["logger"]>,
  boolean
>;

const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.proxy-authorization",
  "req.headers['set-cookie']",
  "res.headers['set-cookie']",
] as const;

export function buildLoggerOptions(config: ApiRuntimeConfig): ApiLoggerOptions {
  const isDevelopment = config.nodeEnv === "development";

  return {
    level: isDevelopment ? "debug" : "info",
    redact: {
      paths: [...REDACTED_LOG_PATHS],
      censor: "[REDACTED]",
    },
    ...(isDevelopment
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname",
              translateTime: "SYS:standard",
            },
          },
        }
      : {}),
  };
}
