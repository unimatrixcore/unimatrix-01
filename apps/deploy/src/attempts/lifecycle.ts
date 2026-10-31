import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import { createRuntimeEvidenceReader } from "./runtime-evidence.js";
import { openDeploymentAttemptStore, type DeploymentAttemptStore } from "./store.js";

export type RuntimeEvidenceReader = () => Promise<DeployAttemptRuntimeEvidence[]>;

declare module "fastify" {
  interface FastifyInstance {
    deploymentAttempts: DeploymentAttemptStore;
    readRuntimeEvidence: RuntimeEvidenceReader;
  }
}

export function setupDeploymentAttempts(
  app: FastifyInstance,
  path: string,
  suppliedStore?: DeploymentAttemptStore,
  suppliedReader?: RuntimeEvidenceReader,
): void {
  const store = suppliedStore ?? openDeploymentAttemptStore(path);
  const read =
    suppliedReader ?? createRuntimeEvidenceReader(join(dirname(path), "runtime-images.json"));
  app.decorate("deploymentAttempts", store);
  app.decorate("readRuntimeEvidence", read);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const sample = (): Promise<void> => {
    inFlight = (async () => {
      try {
        const evidence = await read();
        store.observe(evidence, Date.now());
      } catch {
        app.log.warn("deployment attempt observation unavailable");
        // Expiry does not depend on a bridge sample or CI callback arriving.
        try {
          store.observe([], Date.now());
        } catch {
          app.log.warn("deployment attempt expiry unavailable");
        }
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(() => void sample(), 30_000);
    });
    return inFlight;
  };
  app.addHook("onListen", () => {
    void sample();
    return Promise.resolve();
  });
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      await inFlight;
    } finally {
      store.close();
    }
  });
}
