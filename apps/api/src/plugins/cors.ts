import fastifyCors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

import { isApiCorsOriginAllowed } from "../config.js";

export function setupCors(app: FastifyInstance): void {
  app.register(fastifyCors, {
    allowedHeaders: ["authorization", "content-type"],
    credentials: false,
    exposedHeaders: ["x-request-id"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      if (origin === undefined) {
        callback(null, false);
        return;
      }

      callback(null, isApiCorsOriginAllowed(app.runtimeConfig.cors, origin));
    },
  });
}
