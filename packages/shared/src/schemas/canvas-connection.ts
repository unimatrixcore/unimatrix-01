import { z } from "zod";

export const canvasConnectionStatusSchema = z.strictObject({
  connection: z.literal("connected"),
});

export type CanvasConnectionStatus = z.output<typeof canvasConnectionStatusSchema>;
