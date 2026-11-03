import { z } from "zod";

export const canvasSyntheticEchoInputSchema = z.strictObject({ message: z.string().max(256) });
export const canvasSyntheticEchoSchema = z.strictObject({ message: z.string().max(256) });

export type CanvasSyntheticEcho = z.output<typeof canvasSyntheticEchoSchema>;
