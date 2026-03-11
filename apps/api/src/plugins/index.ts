import type { FastifyInstance } from "fastify";

export function registerCorePlugins(app: FastifyInstance): Promise<void> {
  void app;

  return Promise.resolve();
}
