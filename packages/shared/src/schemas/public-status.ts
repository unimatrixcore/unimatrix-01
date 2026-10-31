import { z } from "zod";

const publicHealthSummarySchema = z.strictObject({
  uptimePercent: z.number().min(0).max(100).nullable(),
  coveragePercent: z.number().min(0).max(100),
});
const publicHealthDaySchema = publicHealthSummarySchema
  .extend({
    from: z.number().int().nonnegative().safe().multipleOf(60_000),
    to: z.number().int().nonnegative().safe().multipleOf(60_000),
  })
  .refine((day) => day.to >= day.from);

export const publicDeploymentStatusQuerySchema = z.strictObject({});
export const publicDeploymentStatusResponseSchema = z.strictObject({
  apps: z
    .array(
      z.strictObject({
        displayName: z.string().min(1).max(128),
        state: z.enum(["up", "down", "degraded"]),
        lastCheckedAt: z.number().int().nonnegative().safe().multipleOf(60_000).nullable(),
        history: z.array(publicHealthDaySchema).max(30),
        summary: publicHealthSummarySchema,
      }),
    )
    .max(100),
});

export type PublicDeploymentStatusResponse = z.output<typeof publicDeploymentStatusResponseSchema>;
