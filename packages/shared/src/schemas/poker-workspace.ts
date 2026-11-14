import { z } from "zod";

const ocrPath = z
  .string()
  .regex(/^\/(?:collection|review|database|labeling(?:\/[1-9][0-9]{0,7})?)$/);
const scroll = z.object({
  top: z.number().finite().min(0).max(10_000_000),
  left: z.number().finite().min(0).max(10_000_000),
});
export const pokerWorkspaceStateSchema = z.object({
  path: z.union([ocrPath, z.enum(["/gameplay", "/training"])]).optional(),
  ocrPath: ocrPath.optional(),
  scroll: z.object({ gameplay: scroll.optional(), training: scroll.optional() }).optional(),
  trainingPanes: z
    .record(z.string().min(1).max(128), scroll)
    .refine((value) => Object.keys(value).length <= 10)
    .optional(),
  trainingRun: z.string().max(128).optional(),
  trainingSelection: z
    .object({
      collections: z.array(z.string().min(1).max(256)).max(100),
      epochs: z.number().int().min(1).max(100),
    })
    .optional(),
  gameplay: z
    .object({
      sessionId: z.string().max(256),
      view: z.enum(["recording", "games", "frames"]),
      hand: z.string().max(256).optional(),
    })
    .optional(),
});
export type PokerWorkspaceState = z.infer<typeof pokerWorkspaceStateSchema>;
