import { posix } from "node:path";
import { z } from "zod";

import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

export type RecreationPolicy = "disabled" | "enabled" | "foreign-command" | "unsupported";

export interface RecreationCommandInputs {
  readonly appName: string;
  readonly composePath: string;
  readonly composeType: string;
  readonly createEnvFile: boolean;
  readonly serverId: string | null;
  readonly mountCount: number;
}

export function canonicalRecreationCommand(input: RecreationCommandInputs): string | null {
  if (
    input.composeType !== "docker-compose" ||
    input.serverId !== null ||
    input.mountCount !== 0 ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(input.appName) ||
    !/^(?:\.\/)?infra\/docker\/[a-z][a-z0-9-]*-compose\.yaml$/u.test(input.composePath)
  )
    return null;
  const envFile = input.createEnvFile
    ? `--env-file ${posix.join(posix.dirname(input.composePath), ".env")} `
    : "";
  return `compose -p ${input.appName} ${envFile}-f ${input.composePath} up -d --build --remove-orphans --force-recreate`;
}

export const recreationComposeSchema = z
  .object({
    composeId: z.string(),
    name: z.string(),
    owner: z.string().nullable(),
    repository: z.string().nullable(),
    sourceType: z.string(),
    appName: z.string(),
    composePath: z.string(),
    composeType: z.string(),
    createEnvFile: z.boolean(),
    serverId: z.string().nullable(),
    mounts: z.array(z.unknown()),
    command: z.string().nullable().optional(),
  })
  .transform(({ mounts, command, ...row }) => {
    const inputs = { ...row, mountCount: mounts.length };
    const canonical = canonicalRecreationCommand(inputs);
    const policy: RecreationPolicy =
      command && command !== canonical
        ? "foreign-command"
        : canonical === null
          ? "unsupported"
          : command
            ? "enabled"
            : "disabled";
    return { ...inputs, policy };
  });

export type DokployRecreationCompose = z.infer<typeof recreationComposeSchema>;
export type EnableRecreationResult =
  "applied" | "already-enabled" | "refused" | "write-status-unknown" | "verification-failed";

export interface DokployRecreationClient {
  inspect(composeId: string): Promise<DokployRecreationCompose>;
  enable(expected: DokployRecreationCompose): Promise<EnableRecreationResult>;
}

function sameInputs(left: DokployRecreationCompose, right: DokployRecreationCompose): boolean {
  const keys = [
    "composeId",
    "name",
    "owner",
    "repository",
    "sourceType",
    "appName",
    "composePath",
    "composeType",
    "createEnvFile",
    "serverId",
    "mountCount",
  ] as const;
  return keys.every((key) => left[key] === right[key]);
}

export function createDokployRecreationClient(
  options: CreateDokployClientOptions,
): DokployRecreationClient {
  const transport = createDokployTransport(options);
  const inspect = (composeId: string) =>
    transport.callProcedure("compose.one", recreationComposeSchema, { composeId });
  return {
    inspect,
    async enable(expected) {
      const current = await inspect(expected.composeId);
      if (
        !sameInputs(current, expected) ||
        current.sourceType !== "github" ||
        current.owner !== "unimatrixcore" ||
        current.repository !== "unimatrix-01"
      )
        return "refused";
      if (current.policy === "enabled") return "already-enabled";
      if (current.policy !== expected.policy) return "refused";
      const command = canonicalRecreationCommand(current);
      if (current.policy !== "disabled" || command === null) return "refused";
      try {
        await transport.callMutation("compose.update", { composeId: current.composeId, command });
      } catch {
        return "write-status-unknown";
      }
      try {
        const verified = await inspect(current.composeId);
        return sameInputs(current, verified) && verified.policy === "enabled"
          ? "applied"
          : "verification-failed";
      } catch {
        return "write-status-unknown";
      }
    },
  };
}
