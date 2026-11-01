import { z } from "zod";

import { canonicalRecreationCommand, recreationComposeSchema } from "./recreation-client.js";
import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

const creationComposeSchema = z
  .object({
    composeId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    environmentId: z.string(),
    composeType: z.string(),
    sourceType: z.string(),
    owner: z.string().nullable(),
    repository: z.string().nullable(),
    branch: z.string().nullable(),
    autoDeploy: z.boolean(),
    composePath: z.string(),
    githubId: z.string().nullable(),
  })
  .and(recreationComposeSchema);

export type DokployCreationCompose = z.infer<typeof creationComposeSchema>;

export interface DokployComposeCreation {
  readonly name: string;
  readonly environmentId: string;
  readonly description: string;
}

export interface DokployComposeSourceConfiguration {
  readonly composePath: string;
  readonly githubId: string;
  readonly description: string;
}

export interface DokployCreationClient {
  createCompose(input: DokployComposeCreation): Promise<void>;
  configureCompose(composeId: string, source: DokployComposeSourceConfiguration): Promise<void>;
  getCompose(composeId: string): Promise<DokployCreationCompose>;
}

export function createDokployCreationClient(
  options: CreateDokployClientOptions,
): DokployCreationClient {
  const { callMutation, callProcedure } = createDokployTransport(options);

  return {
    createCompose: (input) =>
      callMutation("compose.create", {
        name: input.name,
        environmentId: input.environmentId,
        description: input.description,
        sourceType: "raw",
        composeType: "docker-compose",
      }),
    configureCompose: async (composeId, source) => {
      const row = await callProcedure("compose.one", creationComposeSchema, { composeId });
      const command = canonicalRecreationCommand({ ...row, composePath: source.composePath });
      if (
        row.composeId !== composeId ||
        row.description !== source.description ||
        row.sourceType !== "raw" ||
        row.owner !== null ||
        row.repository !== null ||
        row.githubId !== null ||
        row.branch !== null ||
        row.policy === "foreign-command" ||
        source.composePath !== `infra/docker/${row.name}-compose.yaml` ||
        command === null
      ) {
        throw new Error("Created service no longer matches the disconnected configuration.");
      }
      await callMutation("compose.update", {
        composeId,
        sourceType: "github",
        composeType: "docker-compose",
        owner: "unimatrixcore",
        repository: "unimatrix-01",
        branch: "main",
        autoDeploy: false,
        githubId: source.githubId,
        composePath: source.composePath,
        command,
      });
    },
    getCompose: (composeId) => callProcedure("compose.one", creationComposeSchema, { composeId }),
  };
}
