import { z } from "zod";

export const publicDeploymentStatusQuerySchema = z.strictObject({});
export const publicDeploymentStatusResponseSchema = z.strictObject({
  apps: z
    .array(
      z.strictObject({
        displayName: z.string().min(1).max(128),
        state: z.enum(["up", "down", "degraded"]),
        lastCheckedAt: z.number().int().nonnegative().safe().multipleOf(60_000).nullable(),
      }),
    )
    .max(100),
});

export type PublicDeploymentStatusResponse = z.output<typeof publicDeploymentStatusResponseSchema>;
