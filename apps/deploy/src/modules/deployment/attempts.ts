import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  deployAttemptIntentContract,
  deployAttemptReportContract,
  deployAttemptHistoryContract,
  deployAttemptIntentSchema,
  deployAttemptReportSchema,
  deployAttemptQuerySchema,
  deployAttemptLogsContract,
  deployAttemptLogsQuerySchema,
} from "@unimatrix/shared";

import { requireDeployCapability } from "../../plugins/auth.js";
import { readAttemptLogs } from "../../attempts/logs.js";
import { DEPLOY_DESIRED_STATE } from "../../reconcile/desired-state.gen.js";

function declaredApp(app: string) {
  const service = DEPLOY_DESIRED_STATE.find((entry) => entry.appDir === app);
  if (service === undefined)
    throw Object.assign(new Error("Unknown deployment app"), { statusCode: 404 });
  return service;
}

function safeFailure(error: unknown): never {
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error.statusCode === 404 || error.statusCode === 409)
      ? error.statusCode
      : 503;
  throw Object.assign(new Error("Deployment attempt operation unavailable or conflicting"), {
    statusCode,
  });
}

export const deploymentAttemptsModule: FastifyPluginAsync = (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  routes.route({
    method: deployAttemptLogsContract.method,
    url: deployAttemptLogsContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployAttemptLogsQuerySchema,
      response: { 200: deployAttemptLogsContract.responseSchema },
    },
    handler: async (request) => {
      declaredApp(request.query.app);
      try {
        const attempt = app.deploymentAttempts.get(
          request.query.app,
          request.query.attemptId,
          Date.now(),
        );
        if (attempt === undefined)
          throw Object.assign(new Error("Attempt not found"), { statusCode: 404 });
        return await readAttemptLogs(attempt, app.dokploy, app.deploymentLogs);
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  routes.route({
    method: deployAttemptIntentContract.method,
    url: deployAttemptIntentContract.path,
    preHandler: requireDeployCapability("manage"),
    schema: {
      body: deployAttemptIntentSchema,
      response: { 200: deployAttemptIntentContract.responseSchema },
    },
    handler: async (request) => {
      const service = declaredApp(request.body.app);
      if (
        request.body.repository !== "unimatrixcore/unimatrix-01" ||
        request.body.image.repository !== service.image
      ) {
        throw Object.assign(new Error("Deployment image or repository is not declared"), {
          statusCode: 400,
        });
      }
      try {
        const evidence = (await app.readRuntimeEvidence()).filter(
          (entry) => entry.app === service.appDir,
        );
        const now = Date.now();
        const [before] = evidence;
        const baseline =
          evidence.length === 1 &&
          before !== undefined &&
          before.observedAt <= now &&
          now - before.observedAt < 30_000
            ? { containerId: before.containerId, observedAt: before.observedAt }
            : null;
        return app.deploymentAttempts.intent(
          request.body,
          request.serviceCaller!.id,
          baseline,
          now,
        );
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  routes.route({
    method: deployAttemptReportContract.method,
    url: deployAttemptReportContract.path,
    preHandler: requireDeployCapability("manage"),
    schema: {
      body: deployAttemptReportSchema,
      response: { 200: deployAttemptReportContract.responseSchema },
    },
    handler: (request) => {
      try {
        return app.deploymentAttempts.report(request.body, request.serviceCaller!.id, Date.now());
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  routes.route({
    method: deployAttemptHistoryContract.method,
    url: deployAttemptHistoryContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployAttemptQuerySchema,
      response: { 200: deployAttemptHistoryContract.responseSchema },
    },
    handler: (request) => {
      if (request.query.app !== undefined) declaredApp(request.query.app);
      try {
        return {
          attempts: app.deploymentAttempts.list(request.query.app, request.query.limit, Date.now()),
        };
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  return Promise.resolve();
};
