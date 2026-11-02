import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  deployBaselineSchema,
  deployBaselinesContract,
  deployBaselinesQuerySchema,
  type DeployBaseline,
  type DeployRuntimeEvidence,
} from "@unimatrix/shared";

import { RUNTIME_EVIDENCE_MAX_AGE_MS } from "../../attempts/runtime-evidence.js";
import { requireDeployCapability } from "../../plugins/auth.js";
import { DEPLOY_DESIRED_STATE } from "../../reconcile/desired-state.gen.js";

export function selectDeploymentBaseline(
  app: string,
  repository: string,
  evidence: readonly DeployRuntimeEvidence[],
  unresolved: boolean,
  now: number,
): DeployBaseline | null {
  const matches = evidence.filter((entry) => entry.app === app);
  const [entry] = matches;
  if (
    unresolved ||
    matches.length !== 1 ||
    entry === undefined ||
    entry.observedAt > now ||
    now - entry.observedAt >= RUNTIME_EVIDENCE_MAX_AGE_MS ||
    entry.image.repository !== repository ||
    entry.image.platform !== "linux/amd64"
  )
    return null;
  const parsed = deployBaselineSchema.safeParse({
    commit: entry.metadata?.commit,
    containerId: entry.containerId,
    observedAt: entry.observedAt,
    image: entry.image,
  });
  return parsed.success ? parsed.data : null;
}

export const deploymentBaselinesModule: FastifyPluginAsync = (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  routes.route({
    method: deployBaselinesContract.method,
    url: deployBaselinesContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployBaselinesQuerySchema,
      response: { 200: deployBaselinesContract.responseSchema },
    },
    handler: async () => {
      try {
        const evidence = await app.readRuntimeEvidence();
        const checkedAt = Date.now();
        return deployBaselinesContract.responseSchema.parse({
          checkedAt,
          apps: DEPLOY_DESIRED_STATE.map((service) => ({
            app: service.appDir,
            baseline: selectDeploymentBaseline(
              service.appDir,
              service.image,
              evidence,
              app.deploymentAttempts.hasUnresolvedWork(service.appDir, checkedAt),
              checkedAt,
            ),
          })),
        });
      } catch {
        throw Object.assign(new Error("Deployment baseline read unavailable"), {
          statusCode: 503,
        });
      }
    },
  });
  return Promise.resolve();
};
