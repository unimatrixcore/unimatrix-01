import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const healthQuerystringSchema = z.strictObject({});

const healthResponseSchema = z.object({
  service: z.literal("api"),
  status: z.literal("ok"),
});

const healthResponse = {
  service: "api",
  status: "ok",
} as const;

export const healthModule: FastifyPluginAsync = (app) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/health",
    schema: {
      querystring: healthQuerystringSchema,
      response: {
        200: healthResponseSchema,
      },
    },
    handler: () => healthResponse,
  });

  return Promise.resolve();
};
