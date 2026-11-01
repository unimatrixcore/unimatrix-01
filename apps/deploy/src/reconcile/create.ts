import { randomUUID } from "node:crypto";

import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployClient } from "../dokploy/client.js";
import type { DokployCreationClient } from "../dokploy/creation-client.js";
import type { DokployCreationConfig } from "../dokploy/creation-config.js";
import type { DokployCreationStore } from "../dokploy/creation-store.js";
import {
  RECONCILE_EXPECTED_OWNER,
  RECONCILE_EXPECTED_REPOSITORY,
  RECONCILE_SELF_APP_DIR,
} from "./apply.js";
import { findComposeMatches, RECONCILE_AUTO_DEPLOY, RECONCILE_BRANCH } from "./diff.js";

export type CreateServiceState =
  "missing" | "ambiguous" | "disconnected" | "unconfigured" | "configured" | "unavailable";

export interface CreateServiceOutcome {
  readonly appDir: string;
  readonly outcome:
    | "created"
    | "refused-self"
    | "unknown-app"
    | "not-missing"
    | "invalid-target"
    | "already-attempted"
    | "error"
    | "verification-failed"
    | "write-status-unknown";
  readonly observed?: CreateServiceState;
}

export async function createMissingService(
  client: Pick<DokployClient, "getProjects">,
  creation: DokployCreationClient,
  store: Pick<DokployCreationStore, "reserve">,
  desired: DeployDesiredState,
  appDir: string,
  options: DokployCreationConfig,
): Promise<CreateServiceOutcome> {
  if (appDir === RECONCILE_SELF_APP_DIR) return { appDir, outcome: "refused-self" };
  const service = desired.find((entry) => entry.appDir === appDir);
  if (service === undefined) return { appDir, outcome: "unknown-app" };
  const composePath = service.composePath;

  let projects;
  try {
    projects = await client.getProjects();
  } catch {
    return { appDir, outcome: "error" };
  }
  if (findComposeMatches(appDir, projects).length !== 0) return { appDir, outcome: "not-missing" };
  const targets = projects
    .flatMap((project) => project.environments)
    .filter((environment) => environment.environmentId === options.environmentId);
  if (targets.length !== 1) return { appDir, outcome: "invalid-target" };
  const description = `unimatrix-create:${randomUUID()}`;

  async function observe(): Promise<{ state: CreateServiceState; composeId?: string }> {
    try {
      const matches = findComposeMatches(appDir, await client.getProjects());
      const [match] = matches;
      if (matches.length === 0) return { state: "missing" };
      if (matches.length !== 1 || match === undefined) return { state: "ambiguous" };
      const row = await creation.getCompose(match.composeId);
      if (
        row.composeId !== match.composeId ||
        row.name !== appDir ||
        row.environmentId !== options.environmentId ||
        row.description !== description
      ) {
        return { state: "ambiguous" };
      }
      const configured =
        row.sourceType === "github" &&
        row.composeType === "docker-compose" &&
        row.owner === RECONCILE_EXPECTED_OWNER &&
        row.repository === RECONCILE_EXPECTED_REPOSITORY &&
        row.branch === RECONCILE_BRANCH &&
        row.autoDeploy === RECONCILE_AUTO_DEPLOY &&
        row.githubId === options.githubId &&
        row.composePath.replace(/^\.\//u, "") === composePath;
      const disconnected =
        row.sourceType === "raw" &&
        row.composeType === "docker-compose" &&
        row.owner === null &&
        row.repository === null &&
        row.githubId === null &&
        row.branch === null;
      return {
        state: configured ? "configured" : disconnected ? "disconnected" : "unconfigured",
        composeId: row.composeId,
      };
    } catch {
      return { state: "unavailable" };
    }
  }

  // Dokploy has no idempotency key; never replay a possibly committed create after a timeout.
  try {
    if (!store.reserve(appDir)) return { appDir, outcome: "already-attempted" };
  } catch {
    return { appDir, outcome: "error" };
  }

  try {
    await creation.createCompose({
      name: appDir,
      environmentId: options.environmentId,
      description,
    });
  } catch {
    return { appDir, outcome: "write-status-unknown", observed: (await observe()).state };
  }

  const created = await observe();
  if (created.composeId === undefined || created.state !== "disconnected") {
    return { appDir, outcome: "verification-failed", observed: created.state };
  }
  try {
    await creation.configureCompose(created.composeId, { composePath, githubId: options.githubId });
  } catch {
    return { appDir, outcome: "write-status-unknown", observed: (await observe()).state };
  }

  const verified = await observe();
  return verified.state === "configured" && verified.composeId === created.composeId
    ? { appDir, outcome: "created" }
    : { appDir, outcome: "verification-failed", observed: verified.state };
}
