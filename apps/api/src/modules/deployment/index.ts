import { createDeployClient, type DeployClient } from "@unimatrix/deploy-client";
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
  const config = app.runtimeConfig.deployService;
  const client =
    options.deployClient ??
    (config === null
      ? null
      : createDeployClient({
          baseUrl: config.baseUrl,
          serviceToken: config.serviceToken,
          ...(config.caCertificatePem === null
            ? {}
            : { caCertificatePem: config.caCertificatePem }),
        }));
  const read = createPublicStatusReader(client);
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
