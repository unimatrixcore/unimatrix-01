import { z } from "zod";

export const healthQuerySchema = z.strictObject({});

export const healthResponseSchema = z.strictObject({
  service: z.literal("api"),
  status: z.literal("ok"),
});

export type HealthQuery = z.output<typeof healthQuerySchema>;
export type HealthResponse = z.output<typeof healthResponseSchema>;
