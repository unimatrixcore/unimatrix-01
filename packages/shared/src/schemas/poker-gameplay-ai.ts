import { z } from "zod";
import { pokerGameplayLegacyProvenanceSchema } from "./poker-gameplay-lists";

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
export const pokerGameplayCollectionSchema = z.object({
  id,
  name: z.string(),
  kind: z.string(),
  archived: z.boolean(),
  recording_count: count,
  frame_count: count,
});
export const pokerGameplayCollectionsSchema = z.object({
  collections: z.array(pokerGameplayCollectionSchema),
  default_collection_id: id,
});
export const pokerGameplayAiFilterSchema = z.enum([
  "all",
  "pending",
  "completed",
  "manual",
  "ambiguous",
  "error",
]);
export const pokerGameplayAiScopeSchema = z.object({
  session_id: id,
  frame_count: count,
  occurrences: count,
  unique_crops: count,
  exact_cache_hits: count,
  ambiguous: count,
  absent_count: count.optional(),
  profile_id: id,
  recover_from_job_id: id.nullish(),
});
export const pokerGameplayAiPrepareRequestSchema = z.object({
  session_id: id,
  recover_from_job_id: id.optional(),
  selection: z
    .array(z.object({ frame_id: id, region_id: id }))
    .min(1)
    .max(24)
    .optional(),
  review_after_prepare: z.boolean().optional().default(false),
  auto_correct: z.boolean().optional(),
  max_requests: z.number().int().min(1).max(10000).optional(),
});
export type PokerGameplayAiPrepareRequest = z.input<typeof pokerGameplayAiPrepareRequestSchema>;
export const pokerGameplayAiResumeRequestSchema = z.object({
  job_id: id,
  max_requests: z.number().int().min(1).max(10000).optional(),
});
export const pokerGameplayAiPrepareSchema = z.object({
  scope: pokerGameplayAiScopeSchema,
  run_id: id,
  job_id: id.nullable(),
});
export const pokerGameplayAiCountsSchema = z.object({
  total: count,
  pending: count,
  verified: count,
  corrected: count,
  manual: count,
  needs_review: count,
  ambiguous: count,
  error: count,
  frames_completed: count,
  frames_total: count,
});
export const pokerGameplayAiUsageSchema = z.object({
  exact_cache_hits: count,
  near_cache_hits: count,
  requests: count,
  input_tokens: count,
  output_tokens: count,
});
export const pokerGameplayAiJobSchema = z.object({
  id,
  recovery_candidate_job_id: id.nullish(),
  state: z.string(),
  counts: pokerGameplayAiCountsSchema,
  group_counts: pokerGameplayAiCountsSchema.optional(),
  absent_count: count.optional(),
  usage: pokerGameplayAiUsageSchema,
  scope: pokerGameplayAiScopeSchema,
  revision: count,
  error: z.string().optional(),
  auto_correct: z.boolean().optional(),
  max_requests: z.number().int().min(1).max(10000).optional(),
  preparation: z
    .object({
      processed_frames: count,
      total_frames: count,
      inflight: z.boolean().optional(),
      pause_requested: z.boolean().optional(),
    })
    .optional(),
});
export const pokerGameplayAiStatusSchema = z.object({ job: pokerGameplayAiJobSchema.nullable() });
export const pokerGameplayAiGuideSchema = z.object({
  policy: z.string(),
  anchor: z.object({ x: z.number().finite(), y: z.number().finite() }),
  slot_polygon: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).length(4),
  alignment: z.enum(["left", "center", "right"]),
  family: z.string(),
  source: z.enum(["css_slot", "deck_glyph_union", "pixel_panel"]),
  ordinal_basis: z.literal("rendered_visible_order").optional(),
  target_ordinal: z.number().int().nonnegative().optional(),
  crop_width: z.number().int().positive(),
  crop_height: z.number().int().positive(),
  visible_pixel_rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }),
});
export const pokerGameplayAiOccurrenceSchema = z.object({
  id,
  frame_id: id,
  region_id: id,
  label: z.string(),
  original_label: z.string(),
  state: z.string(),
  revision: count,
  has_manual_decision: z.boolean().optional(),
});
export const pokerGameplayAiItemSchema = z.object({
  id,
  frame_id: id,
  region_id: id,
  category: z.string(),
  label: z.string(),
  original_label: z.string(),
  state: z.string(),
  reason: z.string(),
  crop_url: z.string().nullable(),
  crop_available: z.boolean().optional(),
  crop_scope: z.enum(["current", "legacy_source"]).optional(),
  image_url: z.string(),
  cache_kind: z.string(),
  guide: pokerGameplayAiGuideSchema.nullish(),
  revision: count,
  proposed_text: z.string().nullable().optional(),
  has_manual_decision: z.boolean().optional(),
  review_evidence: z.unknown().optional(),
  legacy_provenance: pokerGameplayLegacyProvenanceSchema.nullish(),
  source: z.enum(["legacy", "ai", "human", "capture", "none"]).optional(),
  work_key: id.optional(),
  occurrence_count: count.optional(),
  representative_occurrence_id: id.optional(),
  conflicting_labels: z.array(z.string()).optional(),
  component_work_keys: z.array(id).optional(),
  occurrences: z.array(pokerGameplayAiOccurrenceSchema).max(20).optional(),
  has_more_occurrences: z.boolean().optional(),
});
export const pokerGameplayAiItemsSchema = z.object({
  items: z.array(pokerGameplayAiItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: count,
  meta: z.unknown(),
  grouped: z.boolean().optional(),
});
export const pokerGameplayAiReviewResponseSchema = z.object({
  item: pokerGameplayAiItemSchema,
  revision: count,
  affected_count: count,
});
export type PokerGameplayAiItem = z.infer<typeof pokerGameplayAiItemSchema>;
export type PokerGameplayAiJob = z.infer<typeof pokerGameplayAiJobSchema>;
