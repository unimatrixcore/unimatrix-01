import type { FastifyServerOptions } from "fastify";

export interface ServiceLoggerStream {
  write: (chunk: string) => void;
}

export interface SafeLoggerOptions {
  level: string;
  stream?: ServiceLoggerStream;
}

export type ServiceLoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

// Application log calls must also use closed metadata: serializers cannot sanitize arbitrary fields.
export function buildSafeLoggerOptions(options: SafeLoggerOptions): ServiceLoggerOptions {
  return {
    level: options.level,
    hooks: {
      logMethod(args, method) {
        // Fastify also passes error messages and URLs outside the serialized object.
        const fields = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
        method.call(this, fields, "service event");
      },
    },
    serializers: {
      req: () => ({}),
      res: () => ({}),
      err: () => ({ type: "Error", message: "Request failed", stack: "" }),
    },
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  };
}
