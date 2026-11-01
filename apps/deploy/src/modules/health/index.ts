import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  deployHealthContract,
  healthQuerySchema,
  type DeployHealthResponse,
} from "@unimatrix/shared";

const healthResponse: DeployHealthResponse = {
  service: "deploy",
  status: "ok",
};

export const healthModule: FastifyPluginAsync = (app) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: deployHealthContract.method,
    url: deployHealthContract.path,
    schema: {
      querystring: healthQuerySchema,
      response: {
        200: deployHealthContract.responseSchema,
      },
    },
    handler: (_request, reply) => {
      reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
      reply.header("Pragma", "no-cache");
      reply.header("X-Deploy-Capabilities", "commit-subject-v1");

      return healthResponse;
    },
  });

  return Promise.resolve();
};
