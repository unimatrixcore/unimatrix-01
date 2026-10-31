import { createHash } from "node:crypto";
import { z } from "zod";

import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

export const LOG_LINE_LIMIT = 100;
const eventMessages = new Map([
  ["Initializing deployment", "deployment-initialized" as const],
  ["Docker Compose Deployed: ✅", "deployment-completed" as const],
  ["Error occurred ❌, check the logs for details.", "deployment-failed" as const],
]);

// Exact whole-line recognition emits constants only. No captured substring crosses this boundary.
export const dokployLogOutputSchema = z
  .string()
  .max(262_144)
  .transform((text) => {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const selected = lines.slice(-LOG_LINE_LIMIT);
    const events: Array<"deployment-initialized" | "deployment-completed" | "deployment-failed"> =
      [];
    let withheld = false;
    for (const line of selected) {
      const event = eventMessages.get(line);
      if (event !== undefined) events.push(event);
      else if (line !== "") withheld = true;
    }
    return {
      events,
      withheld,
      truncated: lines.length > LOG_LINE_LIMIT,
      empty: lines.every((line) => line.trim() === ""),
    };
  });

const deploymentsSchema = z
  .array(
    z.object({
      deploymentId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
      composeId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
      title: z
        .string()
        .max(1024)
        .transform((title) => (/^unimatrix-attempt:[a-f0-9-]{36}$/u.test(title) ? title : null)),
      logPath: z
        .string()
        .max(4096)
        .transform((path) =>
          path === "" ? null : createHash("sha256").update(path).digest("hex"),
        ),
    }),
  )
  .max(1000);

export interface DokployLogClient {
  getDeployments(composeId: string): Promise<z.output<typeof deploymentsSchema>>;
  getLogs(deploymentId: string): Promise<z.output<typeof dokployLogOutputSchema>>;
}

export function createDokployLogClient(options: CreateDokployClientOptions): DokployLogClient {
  const transport = createDokployTransport({ ...options, maxResponseBytes: 1_048_576 });
  return {
    getDeployments: (composeId) =>
      transport.callProcedure("deployment.allByCompose", deploymentsSchema, { composeId }),
    getLogs: (deploymentId) =>
      transport.callProcedure("deployment.readLogs", dokployLogOutputSchema, {
        deploymentId,
        tail: String(LOG_LINE_LIMIT + 1),
      }),
  };
}
