import { createUserManagementClient, requirePermission } from "@unimatrix/auth/server";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  listUsersContract,
  listUsersQuerySchema,
  updateUserPermissionsBodySchema,
  updateUserPermissionsContract,
} from "@unimatrix/shared";

export const adminModule: FastifyPluginAsync = (app) => {
  const { clerk } = app.runtimeConfig;

  if (clerk === null) {
    throw new Error(
      "adminModule requires app.runtimeConfig.clerk to be configured; only register it when Clerk is set up.",
    );
  }

  // Constructed once at registration time (not per request): secretKey is
  // static for the lifetime of the app.
  const userManagementClient = createUserManagementClient({ secretKey: clerk.secretKey });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: listUsersContract.method,
    url: listUsersContract.path,
    preHandler: requirePermission("auth", "admin"),
    schema: {
      querystring: listUsersQuerySchema,
      response: {
        200: listUsersContract.responseSchema,
      },
    },
    handler: async (request) => {
      const { query, limit, offset } = request.query;
      const { users, totalCount } = await userManagementClient.listUsers({
        ...(query === undefined ? {} : { query }),
        limit,
        offset,
      });

      return { users, totalCount, limit, offset };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: updateUserPermissionsContract.method,
    url: updateUserPermissionsContract.path,
    preHandler: requirePermission("auth", "admin"),
    schema: {
      body: updateUserPermissionsBodySchema,
      response: {
        200: updateUserPermissionsContract.responseSchema,
      },
    },
    handler: async (request) => {
      const { userId, permissions } = request.body;

      return userManagementClient.setUserPermissions(userId, permissions);
    },
  });

  return Promise.resolve();
};
