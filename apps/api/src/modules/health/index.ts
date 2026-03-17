import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  healthContract,
  healthQuerySchema,
  type HealthResponse,
} from "@unimatrix/shared";

const healthResponse: HealthResponse = {
  service: "api",
  status: "ok",
};

export const healthModule: FastifyPluginAsync = (app) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: healthContract.method,
    url: healthContract.path,
    schema: {
      querystring: healthQuerySchema,
      response: {
        200: healthContract.responseSchema,
      },
    },
    handler: (_request, reply) => {
      reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
      reply.header("Pragma", "no-cache");

      return healthResponse;
    },
  });

  return Promise.resolve();
};
