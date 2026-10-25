import { SecretValue } from "@unimatrix/secrets/client";
import { z } from "zod";

import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

const composeEnvSchema = z.object({
  composeId: z.string(),
  owner: z.string().nullable(),
  repository: z.string().nullable(),
  sourceType: z.string(),
  env: z
    .string()
    .nullable()
    .transform((value) => new SecretValue(value ?? "")),
});

export type DokployComposeEnv = z.output<typeof composeEnvSchema>;

export interface DokployEnvClient {
  getComposeEnv(composeId: string): Promise<DokployComposeEnv>;
  updateComposeEnv(composeId: string, env: SecretValue): Promise<void>;
}

export function createDokployEnvClient(options: CreateDokployClientOptions): DokployEnvClient {
  const transport = createDokployTransport(options);
  return {
    getComposeEnv: (composeId) =>
      transport.callProcedure("compose.one", composeEnvSchema, { composeId }),
    updateComposeEnv: (composeId, env) =>
      transport.callMutation("compose.update", {
        composeId,
        env: env.reveal(),
      }),
  };
}
