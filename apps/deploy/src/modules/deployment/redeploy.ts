import { deployManualRedeployContract, deployManualRedeployInputSchema } from "@unimatrix/shared";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { DokployClientError } from "../../dokploy/transport.js";
import { requireDeployCapability } from "../../plugins/auth.js";
import {
  RECONCILE_SELF_APP_DIR,
  RECONCILE_EXPECTED_OWNER,
  RECONCILE_EXPECTED_REPOSITORY,
} from "../../reconcile/apply.js";
import { findComposeMatches } from "../../reconcile/diff.js";
import { DEPLOY_DESIRED_STATE } from "../../reconcile/desired-state.gen.js";

function refuse(statusCode: 404 | 409 | 503): never {
  throw Object.assign(new Error("Manual redeploy unavailable or conflicting"), { statusCode });
}

export const deploymentRedeployModule: FastifyPluginAsync = (app) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    method: deployManualRedeployContract.method,
    url: deployManualRedeployContract.path,
    preHandler: requireDeployCapability("manage"),
    schema: {
      body: deployManualRedeployInputSchema,
      response: { 200: deployManualRedeployContract.responseSchema },
    },
    handler: async (request) => {
      const { app: appDir } = request.body;
      if (appDir === RECONCILE_SELF_APP_DIR) refuse(409);
      const service = DEPLOY_DESIRED_STATE.find((entry) => entry.appDir === appDir);
      if (service === undefined) refuse(404);
      try {
        const reporterId = request.serviceCaller!.id;
        const existing = app.deploymentAttempts.findManual(request.body, reporterId, Date.now());
        if (existing !== undefined) return existing;
        if (app.redeployment === undefined) refuse(503);
        const matches = findComposeMatches(appDir, await app.dokploy.getProjects());
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) refuse(409);
        const compose = await app.dokploy.getCompose(match.composeId);
        if (
          compose.composeId !== match.composeId ||
          compose.name !== appDir ||
          compose.owner !== RECONCILE_EXPECTED_OWNER ||
          compose.repository !== RECONCILE_EXPECTED_REPOSITORY ||
          compose.sourceType !== "github"
        )
          refuse(409);

        const evidence = (await app.readRuntimeEvidence()).filter((entry) => entry.app === appDir);
        const now = Date.now();
        const [before] = evidence;
        const baseline =
          evidence.length === 1 &&
          before !== undefined &&
          before.observedAt <= now &&
          now - before.observedAt < 30_000
            ? { containerId: before.containerId, observedAt: before.observedAt }
            : null;
        const reservation = app.deploymentAttempts.reserveManual(
          request.body,
          reporterId,
          baseline,
          now,
        );
        if (!reservation.created) return reservation.attempt;
        const attemptId = reservation.attempt.id;
        app.deploymentAttempts.report(
          { attemptId, stage: "queue", result: "started" },
          reporterId,
          Date.now(),
        );
        let result: "acknowledged" | "rejected" | "unknown" = "acknowledged";
        try {
          await app.redeployment.queueRedeploy(match.composeId, attemptId);
        } catch (error) {
          // A timeout or server error can follow a successful enqueue; never retry it here.
          result =
            error instanceof DokployClientError &&
            error.status !== null &&
            error.status >= 400 &&
            error.status < 500
              ? "rejected"
              : "unknown";
        }
        return app.deploymentAttempts.report(
          { attemptId, stage: "queue", result },
          reporterId,
          Date.now(),
        );
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "statusCode" in error
            ? error.statusCode
            : undefined;
        refuse(status === 404 || status === 409 ? status : 503);
      }
    },
  });
  return Promise.resolve();
};
