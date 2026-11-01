import { SecretValue } from "@unimatrix/secrets/client";
import { deployRequestedImageSchema, type DeployAttemptRecord } from "@unimatrix/shared";

import type { DokployComposeEnv, DokployEnvClient } from "../dokploy/env-client.js";
import { RECONCILE_EXPECTED_OWNER, RECONCILE_EXPECTED_REPOSITORY } from "../reconcile/apply.js";
import { mergeSecretEnv } from "./merge.js";

export interface ImageTagWriter {
  isCurrent(
    composeId: string,
    appDir: string,
    image: NonNullable<DeployAttemptRecord["image"]>,
  ): Promise<boolean>;
  write(
    composeId: string,
    appDir: string,
    image: NonNullable<DeployAttemptRecord["image"]>,
  ): Promise<void>;
}

export class ImageTagWriteRefused extends Error {
  constructor() {
    super("Image tag write refused");
  }
}

async function imageUpdateFor(
  client: DokployEnvClient,
  composeId: string,
  appDir: string,
  requestedImage: NonNullable<DeployAttemptRecord["image"]>,
) {
  const parsed = deployRequestedImageSchema.safeParse(requestedImage);
  if (!parsed.success || parsed.data.repository !== `ghcr.io/unimatrixcore/unimatrix-${appDir}`)
    throw new ImageTagWriteRefused();
  let current: DokployComposeEnv;
  try {
    current = await client.getComposeEnv(composeId);
  } catch {
    throw new ImageTagWriteRefused();
  }
  if (
    current.composeId !== composeId ||
    current.owner !== RECONCILE_EXPECTED_OWNER ||
    current.repository !== RECONCILE_EXPECTED_REPOSITORY ||
    current.sourceType !== "github"
  )
    throw new ImageTagWriteRefused();
  const merged = mergeSecretEnv(
    current.env,
    new Map([["IMAGE_TAG", new SecretValue(`${parsed.data.tag}@${parsed.data.digest}`)]]),
    true,
  );
  if (merged.refused.length > 0) throw new ImageTagWriteRefused();
  return { env: merged.env, changed: merged.changed.length > 0 };
}

export function createImageTagWriter(client: DokployEnvClient): ImageTagWriter {
  return {
    isCurrent: async (composeId, appDir, image) =>
      !(await imageUpdateFor(client, composeId, appDir, image)).changed,
    async write(composeId, appDir, image) {
      const update = await imageUpdateFor(client, composeId, appDir, image);
      if (!update.changed) return;
      await client.updateComposeEnv(composeId, update.env);
      try {
        if ((await imageUpdateFor(client, composeId, appDir, image)).changed) throw new Error();
      } catch {
        throw new Error("Image tag write could not be confirmed");
      }
    },
  };
}
