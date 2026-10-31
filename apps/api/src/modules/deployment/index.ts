import type { DeployClient } from "@unimatrix/deploy-client";
import { publicDeploymentStatusContract } from "@unimatrix/shared";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createPublicStatusReader } from "./status.js";

export interface PublicDeploymentModuleOptions {
  deployClient?: DeployClient;
}

export const publicDeploymentModule: FastifyPluginAsync<PublicDeploymentModuleOptions> = (
  app,
  options,
) => {
  const read = createPublicStatusReader(options.deployClient ?? null);
  app.withTypeProvider<ZodTypeProvider>().route({
    method: publicDeploymentStatusContract.method,
    url: publicDeploymentStatusContract.path,
    schema: {
      querystring: publicDeploymentStatusContract.querySchema,
      response: { 200: publicDeploymentStatusContract.responseSchema },
    },
    handler: (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return read();
    },
  });
  return Promise.resolve();
};
