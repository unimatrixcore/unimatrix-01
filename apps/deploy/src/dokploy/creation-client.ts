import { z } from "zod";

import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

const creationComposeSchema = z.object({
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
});

export type DokployCreationCompose = z.infer<typeof creationComposeSchema>;

export interface DokployComposeCreation {
  readonly name: string;
  readonly environmentId: string;
  readonly description: string;
}

export interface DokployComposeSourceConfiguration {
  readonly composePath: string;
  readonly githubId: string;
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
    configureCompose: (composeId, source) =>
      callMutation("compose.update", {
        composeId,
        sourceType: "github",
        composeType: "docker-compose",
        owner: "unimatrixcore",
        repository: "unimatrix-01",
        branch: "main",
        autoDeploy: false,
        githubId: source.githubId,
        composePath: source.composePath,
      }),
    getCompose: (composeId) => callProcedure("compose.one", creationComposeSchema, { composeId }),
  };
}
