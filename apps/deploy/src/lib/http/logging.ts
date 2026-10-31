import type { FastifyServerOptions } from "fastify";

import type { DeployRuntimeConfig } from "../../config.js";

type DeployLoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

/**
 * Trimmed to the headers this service can actually receive — no `apps/secrets` route ever runs
 * here, so its `cookie`/`proxy-authorization`/`set-cookie` redaction paths would be dead config
 * nothing could flag as stale. Caller service tokens are redacted from request headers.
 */
const REDACTED_LOG_PATHS = ["req.headers.authorization"] as const;

export interface DeployLoggerStream {
  write: (chunk: string) => void;
}

export interface BuildDeployLoggerOptions {
  /** Where records go instead of stdout. Tests pass one to assert on redaction. */
  stream?: DeployLoggerStream;
}

export function buildLoggerOptions(
  config: Pick<DeployRuntimeConfig, "logLevel">,
  options: BuildDeployLoggerOptions = {},
): DeployLoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [...REDACTED_LOG_PATHS],
      censor: "[REDACTED]",
    },
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  };
}
