import { SecretValue } from "@unimatrix/secrets/client";
import { deployRequestedImageSchema, type DeployAttemptRecord } from "@unimatrix/shared";

import type { DokployComposeEnv, DokployEnvClient } from "../dokploy/env-client.js";
import { RECONCILE_EXPECTED_OWNER, RECONCILE_EXPECTED_REPOSITORY } from "../reconcile/apply.js";
import { mergeSecretEnv } from "./merge.js";

export interface ImageTagWriter {
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

export function createImageTagWriter(client: DokployEnvClient): ImageTagWriter {
  return {
    async write(composeId, appDir, requestedImage) {
      const parsed = deployRequestedImageSchema.safeParse(requestedImage);
      if (!parsed.success || parsed.data.repository !== `ghcr.io/unimatrixcore/unimatrix-${appDir}`)
        throw new ImageTagWriteRefused();
      const image = parsed.data;
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
        new Map([["IMAGE_TAG", new SecretValue(`${image.tag}@${image.digest}`)]]),
        true,
      );
      if (merged.refused.length > 0) throw new ImageTagWriteRefused();
      if (merged.changed.length > 0) {
        await client.updateComposeEnv(composeId, merged.env);
        try {
          const confirmed = await client.getComposeEnv(composeId);
          const check = mergeSecretEnv(
            confirmed.env,
            new Map([["IMAGE_TAG", new SecretValue(`${image.tag}@${image.digest}`)]]),
            true,
          );
          if (
            confirmed.composeId !== composeId ||
            confirmed.owner !== RECONCILE_EXPECTED_OWNER ||
            confirmed.repository !== RECONCILE_EXPECTED_REPOSITORY ||
            confirmed.sourceType !== "github" ||
            check.changed.length > 0 ||
            check.refused.length > 0
          )
            throw new Error();
        } catch {
          throw new Error("Image tag write could not be confirmed");
        }
      }
    },
  };
}
