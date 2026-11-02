import { z } from "zod";

import { deployRuntimeImageSchema } from "./deployment-attempts.js";

export const deployBaselinesQuerySchema = z.strictObject({});

export const deployBaselineSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  containerId: z.string().regex(/^[a-f0-9]{64}$/u),
  observedAt: z.number().int().nonnegative().safe(),
  image: deployRuntimeImageSchema,
});

export const deployBaselinesResponseSchema = z.strictObject({
  checkedAt: z.number().int().nonnegative().safe(),
  apps: z
    .array(
      z.strictObject({
        app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
        baseline: deployBaselineSchema.nullable(),
      }),
    )
    .max(100)
    .refine((apps) => new Set(apps.map(({ app }) => app)).size === apps.length),
});

export type DeployBaseline = z.output<typeof deployBaselineSchema>;
export type DeployBaselinesResponse = z.output<typeof deployBaselinesResponseSchema>;
