import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export function setupSecurity(app: FastifyInstance): void {
  app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    ...(app.runtimeConfig.nodeEnv === "production"
      ? {}
      : {
          strictTransportSecurity: false,
        }),
  });
}
