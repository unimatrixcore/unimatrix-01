import { z } from "zod";

export const pokerGameplaySessionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    source: z.string(),
    interval_ms: z.number().int().nonnegative(),
    collection_id: z.string().min(1).optional(),
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
  verification: z.lazy(() => pokerGameplayFrameVerificationSchema).optional(),
});
export type PokerGameplayHand = z.infer<typeof pokerGameplayHandSchema>;
export const pokerGameplayCropMaskSchema = z.object({
  policy: z.literal("source_css_rounded_panels_rgb_v1"),
  source: z.enum([
    "sp_default_nameplate",
    "chip_columns_value",
    "single_chip_value",
    "upper_pot",
    "status_announcement",
    "game_id_tab",
  ]),
  neutral_rgb: z.tuple([
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
  ]),
  panels: z
    .array(
      z.object({
        bounds: z.object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().positive(),
          height: z.number().positive(),
        }),
        corners: z.tuple([
          z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }),
          z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }),
          z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }),
          z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }),
        ]),
      }),
    )
    .min(1)
    .max(10),
});
export type PokerGameplayCropMask = z.infer<typeof pokerGameplayCropMaskSchema>;
export const pokerGameplayRegionProfileSchema = z
  .object({
    id: z.string().optional(),
    viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    legacy_seat_offset: z.number().int().optional(),
    regions: z.array(
      z
        .object({
          id: z.string().min(1),
          category: z.string(),
          ocr: z.boolean().optional(),
          overlay: z.boolean().optional(),
          localization_error: z.string().optional(),
          presence: z
            .object({
              state: z.enum(["present", "absent", "ambiguous", "visual_indicator"]),
              reason: z.string(),
              policy: z.string(),
            })
            .optional(),
          crop_mask: pokerGameplayCropMaskSchema.optional(),
          bounds: z.object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().positive(),
            height: z.number().positive(),
          }),
          polygon: z
            .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
            .min(3)
            .max(64)
            .optional(),
          rotation: z.number().finite().optional(),
          guide: z
            .object({
              slot: z.object({
                x: z.number().finite(),
                y: z.number().finite(),
                width: z.number().positive(),
                height: z.number().positive(),
              }),
              anchor: z.object({ x: z.number().finite(), y: z.number().finite() }),
              alignment: z.enum(["left", "center", "right"]),
              family: z.string().min(1),
              source: z.enum(["css_slot", "deck_glyph_union", "pixel_panel"]),
            })
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export const pokerGameplayLegacyProvenanceSchema = z
  .object({
    policy: z.literal("occurrence_owned_legacy_annotations_v2"),
    source_dataset: z.string(),
    source_database: z.string(),
    source_database_receipt: z.record(z.string(), z.string()),
    source_region_id: z.string(),
    target_region_id: z.string(),
    target_profile_id: z.string(),
    target_profile_sha256: z.string(),
    source_config_digest: z.string(),
    original_rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    original_pixel_sha256: z.string(),
    original_image_sha256: z.string(),
    label_present: z.literal(true),
    explicit_blank: z.boolean(),
    pixel_relationship: z.string(),
    visually_verified: z.literal(false),
    capture: z.unknown(),
    crop: z.unknown(),
  })
  .passthrough();
export const pokerGameplayReadingVerificationSchema = z
  .object({
    state: z.enum([
      "unprepared",
      "pending",
      "absent",
      "unchanged",
      "corrected",
      "manual",
      "legacy_verified",
      "ambiguous",
      "flagged",
      "conflict",
      "error",
      "unsupported",
      "visual_indicator",
    ]),
    source: z.enum(["ai", "human", "legacy", "capture", "none"]),
    reason: z.string().optional(),
    cache_kind: z.string().optional(),
    legacy_provenance: pokerGameplayLegacyProvenanceSchema.nullish(),
  })
  .superRefine((reading, context) => {
    if (
      (reading.state === "legacy_verified" || reading.source === "legacy") &&
      (reading.state !== "legacy_verified" ||
        reading.source !== "legacy" ||
        !reading.legacy_provenance)
    ) {
      context.addIssue({
        code: "custom",
        message: "Legacy verification requires legacy source provenance",
      });
    }
  });
export type PokerGameplayReadingVerification = z.infer<
  typeof pokerGameplayReadingVerificationSchema
>;
export const pokerGameplayFrameVerificationSchema = z.object({
  region_profile_id: z.string().min(1),
  status: z.enum(["unverified", "partial", "verified", "needs_review", "unavailable"]),
  total: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
  needs_review: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  absent_count: z.number().int().nonnegative().optional(),
});
export type PokerGameplayFrameVerification = z.infer<typeof pokerGameplayFrameVerificationSchema>;
export const pokerGameplayReadingSchema = z
  .object({
    rect: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      w: z.number().finite(),
      h: z.number().finite(),
    }),
    prediction: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable().default(null),
    original_region_id: z.string().optional(),
    verification: pokerGameplayReadingVerificationSchema.optional(),
  })
  .passthrough();
export const pokerGameplayEffectiveConfigSchema = z.object({
  region_profile_id: z.string().min(1),
  regions: pokerGameplayRegionProfileSchema,
});
export const pokerGameplayFrameSummarySchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    hand_id: z.string().nullable(),
    captured_hand_id: z.string().nullable().optional(),
    captured_at: z.string(),
    image_url: z.string(),
    preview_url: z.string().optional(),
    thumbnail_url: z.string().optional(),
    ocr_status: z.string(),
    error: z.string().nullable(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    results: z.record(z.string(), pokerGameplayReadingSchema).optional(),
    config_snapshot: z
      .object({ regions: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
    effective_results: z.record(z.string(), pokerGameplayReadingSchema).optional(),
    effective_config_snapshot: pokerGameplayEffectiveConfigSchema.optional(),
    effective_region_error: z.string().optional(),
    verification: pokerGameplayFrameVerificationSchema.optional(),
  })
  .passthrough();
