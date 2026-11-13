import { z } from "zod";
import { pokerRectSchema } from "./poker.js";

export const pokerRegionEditorSchema = z.object({
  regions: z.record(
    z.string(),
    pokerRectSchema.extend({ x: z.number().int(), y: z.number().int() }),
  ),
  screenWidth: z.number().int().min(1).max(16384),
  screenHeight: z.number().int().min(1).max(16384),
});
export type PokerRegionEditorConfig = z.infer<typeof pokerRegionEditorSchema>;
export const pokerRegionEditorStateSchema = pokerRegionEditorSchema;
export const pokerRegionEditorSaveSchema = pokerRegionEditorSchema.extend({
  export: z.boolean().optional(),
});
export const pokerRegionEditorResponseSchema = z.object({
  saved: z.literal(true),
  exportPath: z.string().optional(),
  native: z.unknown().optional(),
});
export type PokerRegionEditorSave = z.infer<typeof pokerRegionEditorSaveSchema>;
export type PokerRegionEditorResponse = z.infer<typeof pokerRegionEditorResponseSchema>;

export const pokerLabRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string().startsWith("/api/").max(2048),
  body: z.unknown().optional(),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
});
export const pokerLabResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
  bodyBase64: z.string().optional(),
});
export type PokerLabRequest = z.infer<typeof pokerLabRequestSchema>;
export type PokerLabResponse = z.infer<typeof pokerLabResponseSchema>;

export const pokerLauncherWorktreeSchema = z.object({
  id: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  branch: z.string().min(1).max(1024),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export const pokerLauncherStatusSchema = z.object({
  selection: z.string().min(1).max(4096),
  current: pokerLauncherWorktreeSchema.nullable(),
  desired: pokerLauncherWorktreeSchema.nullable(),
  worktrees: z.array(pokerLauncherWorktreeSchema).max(512),
  error: z.string().nullable().optional(),
});
export type PokerLauncherWorktree = z.infer<typeof pokerLauncherWorktreeSchema>;
export type PokerLauncherStatus = z.infer<typeof pokerLauncherStatusSchema>;

export const pokerCardSuitSchema = z.enum(["s", "h", "c", "d"]);
export const pokerGameplayColorStateSchema = z.object({
  seats: z.record(
    z.string(),
    z.object({
      in_play: z.boolean().nullable(),
      hand_suits: z.array(pokerCardSuitSchema.nullable()).max(2),
    }),
  ),
  community_suits: z.array(pokerCardSuitSchema.nullable()).max(5),
  configuration: z.enum(["recorded", "current", "unavailable"]).optional(),
});
export type PokerCardSuit = z.infer<typeof pokerCardSuitSchema>;
export type PokerGameplayColorState = z.infer<typeof pokerGameplayColorStateSchema>;

export const pokerLabSystemMemorySchema = z
  .object({
    totalBytes: z.number().finite().positive(),
    availableBytes: z.number().finite().nonnegative(),
  })
  .refine((value) => value.availableBytes <= value.totalBytes);
export const pokerLabListPageSchema = z
  .object({
    items: z.array(z.unknown()),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().int().nonnegative(),
    meta: z.unknown().refine((value) => value !== undefined),
  })
  .refine((value) => value.hasMore === (value.nextCursor !== null));
export const pokerLabListItemSchema = z
  .object({
    id: z.string(),
  })
  .passthrough();
export const pokerLabFilenameSchema = z.object({ filename: z.string().min(1) });
export const pokerLabNameSuggestionSchema = z.object({ name: z.string().min(1) });
export const pokerLabDatasetSchema = z
  .object({ id: z.string().min(1), name: z.string(), archived: z.boolean() })
  .passthrough();
export const pokerLabDatasetMetaSchema = z.object({ default_dataset_id: z.string().min(1) });

export const pokerLabDatabaseItemSchema = pokerLabListItemSchema.extend({
  filename: z.string().min(1),
  label: z.string(),
});

export const pokerLabListMetaSchema = z.object({
  total: z.number().int().nonnegative(),
  meta: z.unknown().refine((value) => value !== undefined),
});
export const pokerLabHistoryRowSchema = z.object({
  kind: z.enum(["event", "prediction"]),
  payload: z.record(z.string(), z.unknown()),
});
const pokerLabHistoricalNumberSchema = z.union([
  z.number().finite(),
  z.string().refine((value) => Number.isFinite(Number(value))),
]);
export const pokerLabCompletionRowSchema = z
  .object({
    score: pokerLabHistoricalNumberSchema,
    items: pokerLabHistoricalNumberSchema.nullable().optional(),
    rpm: pokerLabHistoricalNumberSchema.nullable().optional(),
  })
  .passthrough();
export const pokerLabPageHandoffSchema = z.discriminatedUnion("path", [
  z
    .object({
      path: z.literal("/api/queue"),
      datasetId: z.string().min(1).max(256),
      query: z.object({ order: z.literal("newest") }).strict(),
      storedAt: z.number().int().nonnegative(),
      page: pokerLabListPageSchema,
    })
    .strict(),
  z
    .object({
      path: z.literal("/api/gameplay"),
      datasetId: z.null(),
      query: z.object({ archived: z.literal("0") }).strict(),
      storedAt: z.number().int().nonnegative(),
      page: pokerLabListPageSchema,
    })
    .strict(),
]);
