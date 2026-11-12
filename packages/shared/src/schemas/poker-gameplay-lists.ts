import { z } from "zod";

export const pokerGameplaySessionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    source: z.string(),
    interval_ms: z.number().int().positive(),
    status: z.string(),
    created_at: z.string(),
    frame_count: z.number().int().nonnegative(),
    hand_count: z.number().int().nonnegative(),
  })
  .passthrough();
export const pokerGameplayHandSchema = z.object({
  hand_id: z.string().nullable(),
  frame_count: z.number().int().nonnegative(),
  first_at: z.string(),
  last_at: z.string(),
});
export const pokerGameplayFrameSummarySchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    hand_id: z.string().nullable(),
    captured_at: z.string(),
    image_url: z.string(),
    preview_url: z.string().optional(),
    thumbnail_url: z.string().optional(),
    ocr_status: z.string(),
    error: z.string().nullable(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  })
  .passthrough();
