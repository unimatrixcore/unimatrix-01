import { requireAdminSection } from "@unimatrix/auth/server";
import { DeployClientError, type DeployClient } from "@unimatrix/deploy-client";
import {
  adminDeployDeclarationsContract,
  deployDeclarationsQuerySchema,
  adminDeployStateContract,
  adminDeployHealthHistoryContract,
  adminDeployReconciliationContract,
  adminDeployAttemptHistoryContract,
  deployStateQuerySchema,
  deployHealthHistoryQuerySchema,
  deployReconciliationQuerySchema,
  deployAttemptQuerySchema,
  adminDeployAttemptLogsContract,
  deployAttemptLogsQuerySchema,
  adminDeployManualRedeployContract,
  deployManualRedeployRequestSchema,
} from "@unimatrix/shared";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { getRequiredAuthUserId } from "../../lib/http/auth.js";
import { ApiError } from "../../lib/http/errors.js";

export interface AdminDeploymentModuleOptions {
  deployClient: DeployClient;
}

export const adminDeploymentModule: FastifyPluginAsync<AdminDeploymentModuleOptions> = (
  app,
  { deployClient },
) => {
  app.addHook("onRequest", (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return Promise.resolve();
  });

  async function read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      // Upstream errors can contain credentials or response values, including in their cause.
      throw new ApiError({
        statusCode: 502,
        code: "INTERNAL_ERROR",
        message: "Deployment reads unavailable",
      });
    }
  }

  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployManualRedeployContract.method,
    url: adminDeployManualRedeployContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      body: deployManualRedeployRequestSchema,
      response: { 200: adminDeployManualRedeployContract.responseSchema },
    },
    handler: async (request) => {
      const actorUserId = getRequiredAuthUserId(request);
      try {
        return await deployClient.redeploy({ ...request.body, actorUserId });
      } catch (error) {
        const statusCode = error instanceof DeployClientError ? error.statusCode : undefined;
        throw new ApiError({
          statusCode: statusCode ?? 502,
          code:
            statusCode === 404
              ? "NOT_FOUND"
              : statusCode === 409
                ? "CLIENT_ERROR"
                : "INTERNAL_ERROR",
          message:
            statusCode === 409
              ? "Deployment request conflicts with deployment policy or pending work"
              : "Deployment request unavailable",
        });
      }
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployAttemptLogsContract.method,
    url: adminDeployAttemptLogsContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployAttemptLogsQuerySchema,
      response: { 200: adminDeployAttemptLogsContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getAttemptLogs(request.query));
    },
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployDeclarationsContract.method,
    url: adminDeployDeclarationsContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployDeclarationsQuerySchema,
      response: { 200: adminDeployDeclarationsContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getDeclarations(request.query));
    },
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployStateContract.method,
    url: adminDeployStateContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployStateQuerySchema,
      response: { 200: adminDeployStateContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getState(request.query));
    },
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployHealthHistoryContract.method,
    url: adminDeployHealthHistoryContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployHealthHistoryQuerySchema,
      response: { 200: adminDeployHealthHistoryContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getHealth(request.query.app));
    },
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployReconciliationContract.method,
    url: adminDeployReconciliationContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployReconciliationQuerySchema,
      response: { 200: adminDeployReconciliationContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getReconciliation(request.query));
    },
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminDeployAttemptHistoryContract.method,
    url: adminDeployAttemptHistoryContract.path,
    preHandler: requireAdminSection("deploys"),
    schema: {
      querystring: deployAttemptQuerySchema,
      response: { 200: adminDeployAttemptHistoryContract.responseSchema },
    },
    handler: (request) => {
      getRequiredAuthUserId(request);
      return read(() => deployClient.getAttempts(request.query));
    },
  });
  return Promise.resolve();
};
