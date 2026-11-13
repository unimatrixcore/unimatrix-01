import { z } from "zod";
import { pokerGameStateSchema, pokerRectSchema } from "./poker.js";

const suits = z.object({
  diamonds: z.string(),
  spades: z.string(),
  clubs: z.string(),
  hearts: z.string(),
});
export const pokerAssistantColorsSchema = z.object({
  card_text: z.string(),
  dim_text: z.string(),
  suits,
  dim_suits: suits,
});
export const pokerProductionStateSchema = z.object({
  state: z.string(),
  reason: z.string(),
  capture_age_ms: z.number().nullable(),
  frame_id: z.string().nullable(),
  game_state: pokerGameStateSchema
    .extend({
      seat_banks: z.record(z.string(), z.string()),
      seat_statuses: z.record(z.string(), z.string()),
      seat_dealers: z.record(z.string(), z.string()),
      pot: z.string().nullable(),
      split_pot: z.string().nullable(),
    })
    .nullable(),
  ocr_regions: z.record(z.string(), z.unknown()),
});
export const pokerAssistantResponses = {
  load_preferences: z.string().nullable(),
  save_preferences: z.null(),
  get_monitors: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      is_primary: z.boolean(),
    }),
  ),
  get_colors: pokerAssistantColorsSchema,
  capture_production_frame: z.object({
    capture_id: z.string(),
    screenshot_bytes: z.array(z.number().int().min(0).max(255)).max(67108864),
  }),
  extract_regions: z.array(
    z.object({ id: z.string(), rect: pokerRectSchema, base64_image: z.string() }),
  ),
  get_production_state: pokerProductionStateSchema,
  stop_production_ocr: z.null(),
  save_debug_screenshot: z.string(),
  debug_env: z.string(),
};
export type PokerProductionState = z.infer<typeof pokerProductionStateSchema>;
export type PokerAssistantColors = z.infer<typeof pokerAssistantColorsSchema>;
export type PokerAssistantMonitor = z.infer<typeof pokerAssistantResponses.get_monitors>[number];
export type PokerAssistantCrop = z.infer<typeof pokerAssistantResponses.extract_regions>[number];
export type PokerProductionCapture = z.infer<
  typeof pokerAssistantResponses.capture_production_frame
>;
