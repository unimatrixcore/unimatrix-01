import type { FastifyPluginCallback } from "fastify";

export const healthModule: FastifyPluginCallback = (app, options, done) => {
  void options;

  app.get("/health", () => {
    return {
      service: "api",
      status: "ok",
    };
  });

  done();
};
