import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  deployDeclarationsContract,
  deployDeclarationsQuerySchema,
  deployStateContract,
  deployStateQuerySchema,
  deployHealthHistoryContract,
  deployHealthHistoryQuerySchema,
  deployReconciliationContract,
  deployReconciliationQuerySchema,
} from "@unimatrix/shared";

import { DEPLOY_DECLARATIONS } from "../../declarations/manifest.gen.js";

import { PROBE_INTERVAL_MS } from "../../health-history/model.js";
import { CONTAINER_POLL_INTERVAL_MS } from "../../observe/polling.js";
import { requireDeployCapability } from "../../plugins/auth.js";
import { DEPLOY_DESIRED_STATE } from "../../reconcile/desired-state.gen.js";

function selectApps(app: string | undefined) {
  const selected = DEPLOY_DESIRED_STATE.filter(
    (service) => app === undefined || service.appDir === app,
  );
  if (selected.length === 0) {
    throw Object.assign(new Error("Unknown deployment app"), { statusCode: 404 });
  }
  return selected;
}

function freshness(observedAt: number | null, now: number, interval: number) {
  if (observedAt === null) return "missing" as const;
  return now >= observedAt && now - observedAt < interval ? ("fresh" as const) : ("stale" as const);
}

function unavailable() {
  return Object.assign(new Error("Deployment read unavailable"), { statusCode: 503 });
}

export const deploymentModule: FastifyPluginAsync = (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  routes.route({
    method: deployDeclarationsContract.method,
    url: deployDeclarationsContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployDeclarationsQuerySchema,
      response: { 200: deployDeclarationsContract.responseSchema },
    },
    handler: (request) => {
      const selected = selectApps(request.query.app);
      try {
        return deployDeclarationsContract.responseSchema.parse({
          apps: DEPLOY_DECLARATIONS.filter((declaration) =>
            selected.some((service) => service.appDir === declaration.appDir),
          ),
        });
      } catch {
        throw unavailable();
      }
    },
  });
  routes.route({
    method: deployStateContract.method,
    url: deployStateContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployStateQuerySchema,
      response: { 200: deployStateContract.responseSchema },
    },
    handler: (request) => {
      const selected = selectApps(request.query.app);
      try {
        const checkedAt = Date.now();
        const snapshot = app.containerObserver.getSnapshot();
        return deployStateContract.responseSchema.parse({
          checkedAt,
          apps: selected.map((service) => {
            const container = snapshot.find((entry) => entry.appDir === service.appDir) ?? {
              appDir: service.appDir,
              kind: "unknown",
              reason: "not-polled",
              observedAt: null,
            };
            return {
              appDir: service.appDir,
              publicStatus: service.publicStatus === true,
              container: {
                ...container,
                freshness: freshness(container.observedAt, checkedAt, CONTAINER_POLL_INTERVAL_MS),
              },
            };
          }),
        });
      } catch {
        // Validation errors can hold rejected upstream values; discard them before logging.
        throw unavailable();
      }
    },
  });
  routes.route({
    method: deployHealthHistoryContract.method,
    url: deployHealthHistoryContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployHealthHistoryQuerySchema,
      response: { 200: deployHealthHistoryContract.responseSchema },
    },
    handler: (request) => {
      selectApps(request.query.app);
      try {
        const now = Date.now();
        const snapshot = app.healthHistory.snapshot(request.query.app, now);
        return deployHealthHistoryContract.responseSchema.parse({
          ...snapshot,
          freshness: freshness(snapshot.current.checkedAt, now, PROBE_INTERVAL_MS),
        });
      } catch {
        throw unavailable();
      }
    },
  });
  routes.route({
    method: deployReconciliationContract.method,
    url: deployReconciliationContract.path,
    preHandler: requireDeployCapability("read"),
    schema: {
      querystring: deployReconciliationQuerySchema,
      response: { 200: deployReconciliationContract.responseSchema },
    },
    handler: (request) => {
      const selected = selectApps(request.query.app);
      try {
        const snapshot = app.reconciliationDetector.snapshot();
        return deployReconciliationContract.responseSchema.parse({
          ...snapshot,
          results: snapshot.results.filter((result) =>
            selected.some((service) => service.appDir === result.appDir),
          ),
        });
      } catch {
        throw unavailable();
      }
    },
  });
  return Promise.resolve();
};
