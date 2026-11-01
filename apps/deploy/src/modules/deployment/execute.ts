import {
  deployExecuteContract,
  deployExecuteInputSchema,
  deployRollbackContract,
  deployRollbackInputSchema,
  type DeployAttemptRecord,
  type DeployAttemptBaseline,
} from "@unimatrix/shared";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { DokployClientError } from "../../dokploy/transport.js";
import { requireDeployCapability } from "../../plugins/auth.js";
import {
  RECONCILE_SELF_APP_DIR,
  RECONCILE_EXPECTED_OWNER,
  RECONCILE_EXPECTED_REPOSITORY,
} from "../../reconcile/apply.js";
import { DEPLOY_DESIRED_STATE } from "../../reconcile/desired-state.gen.js";
import { findComposeMatches } from "../../reconcile/diff.js";
import { ImageTagWriteRefused } from "../../secret-env/image-tag.js";

function refuse(statusCode: 404 | 409 | 503): never {
  throw Object.assign(new Error("Deployment operation unavailable or conflicting"), { statusCode });
}

function safeFailure(error: unknown): never {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? error.statusCode
      : undefined;
  refuse(status === 404 || status === 409 ? status : 503);
}

function declaredApp(appDir: string): void {
  if (!DEPLOY_DESIRED_STATE.some((service) => service.appDir === appDir)) refuse(404);
}

async function resolveCompose(app: FastifyInstance, appDir: string): Promise<string> {
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
  return match.composeId;
}

function mutationFailure(error: unknown): "rejected" | "unknown" {
  return error instanceof ImageTagWriteRefused ||
    (error instanceof DokployClientError &&
      error.status !== null &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429)
    ? "rejected"
    : "unknown";
}

async function readBaseline(app: FastifyInstance, appDir: string): Promise<DeployAttemptBaseline> {
  const evidence = (await app.readRuntimeEvidence()).filter((entry) => entry.app === appDir);
  const now = Date.now();
  const [before] = evidence;
  if (
    evidence.length !== 1 ||
    before === undefined ||
    before.observedAt > now ||
    now - before.observedAt >= 30_000
  )
    refuse(503);
  return { containerId: before.containerId, observedAt: before.observedAt };
}

async function execute(
  app: FastifyInstance,
  record: DeployAttemptRecord,
  composeId: string,
  reporterId: string,
): Promise<DeployAttemptRecord> {
  if (app.imageTags === undefined || app.redeployment === undefined || record.image === null)
    refuse(503);
  const baseline = await readBaseline(app, record.app);
  const claim = app.deploymentAttempts.claimExecution(
    record.app,
    record.id,
    reporterId,
    Date.now(),
    baseline,
  );
  if (!claim.claimed) return claim.attempt;
  const report = (
    stage: "tag-write" | "queue",
    result: "started" | "acknowledged" | "rejected" | "unknown",
  ) =>
    app.deploymentAttempts.report({ attemptId: record.id, stage, result }, reporterId, Date.now());
  let result: "acknowledged" | "rejected" | "unknown" = "acknowledged";
  try {
    await app.imageTags.write(composeId, record.app, record.image);
  } catch (error) {
    result = mutationFailure(error);
  }
  const written = report("tag-write", result);
  if (result !== "acknowledged") return written;
  report("queue", "started");
  try {
    await app.redeployment.queueRedeploy(composeId, record.id);
  } catch (error) {
    result = mutationFailure(error);
  }
  return report("queue", result);
}

export const deploymentExecutionModule: FastifyPluginAsync = (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  routes.route({
    method: deployExecuteContract.method,
    url: deployExecuteContract.path,
    preHandler: requireDeployCapability("manage"),
    schema: {
      body: deployExecuteInputSchema,
      response: { 200: deployExecuteContract.responseSchema },
    },
    handler: async (request) => {
      declaredApp(request.body.app);
      try {
        const record = app.deploymentAttempts.get(
          request.body.app,
          request.body.attemptId,
          Date.now(),
        );
        if (record === undefined) refuse(404);
        const reporterId = request.serviceCaller!.id;
        if (record.trigger !== "ci" || record.reporterId !== reporterId) refuse(409);
        if (record.tagWrite !== null || record.queue !== null) return record;
        const composeId = await resolveCompose(app, record.app);
        return await execute(app, record, composeId, reporterId);
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  routes.route({
    method: deployRollbackContract.method,
    url: deployRollbackContract.path,
    preHandler: requireDeployCapability("manage"),
    schema: {
      body: deployRollbackInputSchema,
      response: { 200: deployRollbackContract.responseSchema },
    },
    handler: async (request) => {
      const { app: appDir } = request.body;
      if (appDir === RECONCILE_SELF_APP_DIR) refuse(409);
      declaredApp(appDir);
      try {
        const reporterId = request.serviceCaller!.id;
        const prior = app.deploymentAttempts.findRollback(request.body, reporterId, Date.now());
        if (prior !== undefined) return prior;
        if (app.imageTags === undefined || app.redeployment === undefined) refuse(503);
        const composeId = await resolveCompose(app, appDir);
        const baseline = await readBaseline(app, appDir);
        const now = Date.now();
        const reservation = app.deploymentAttempts.reserveRollback(
          request.body,
          reporterId,
          baseline,
          now,
        );
        if (!reservation.created) return reservation.attempt;
        return await execute(app, reservation.attempt, composeId, reporterId);
      } catch (error) {
        safeFailure(error);
      }
    },
  });
  return Promise.resolve();
};
