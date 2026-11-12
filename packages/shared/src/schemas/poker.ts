import { z } from "zod";

export const pokerRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(16384),
  h: z.number().int().min(1).max(16384),
});
export const pokerRegionsSchema = z.record(z.string(), pokerRectSchema);
export const pokerDecisionSchema = z.enum(["pending", "label", "blank", "discard"]);
export const pokerSampleSchema = z.object({
  key: z.string(),
  regionId: z.string(),
  label: z.string(),
  phash: z.string(),
  source: z.string(),
  rect: pokerRectSchema,
  image: z.string(),
  decision: pokerDecisionSchema,
});
export const pokerFrameSchema = z.object({
  key: z.string(),
  source: z.string(),
  gameId: z.string(),
  thumbnail: z.string(),
  crops: z.array(pokerSampleSchema),
});
export const pokerSessionSchema = z.object({
  frames: z.array(pokerFrameSchema),
  pool: z.array(pokerSampleSchema),
  currentIndex: z.number().int().min(0),
  points: z.number().min(0),
  streak: z.number().int().min(0),
  elapsedMs: z.number().min(0),
});
export const pokerSettingsSchema = z.looseObject({
  monitor: z.string(),
  username: z.string(),
  captureIntervalMs: z.number().int().min(1000).max(60000),
});
export const pokerEntrySchema = z.object({
  filename: z.string(),
  regionId: z.string(),
  label: z.string(),
  phash: z.string(),
  source: z.string().nullable(),
  rect: pokerRectSchema.nullable(),
  decision: pokerDecisionSchema.nullable(),
});
export const pokerDatasetMetricsSchema = z.object({
  categories: z.record(z.string(), z.number().int().min(0)),
  topLabels: z.record(z.string(), z.number().int().min(0)),
  crops: z.object({
    minWidth: z.number(),
    maxWidth: z.number(),
    meanWidth: z.number(),
    minHeight: z.number(),
    maxHeight: z.number(),
    meanHeight: z.number(),
  }),
  labelLengths: z.object({ min: z.number(), max: z.number(), mean: z.number() }),
  perCategory: z.record(
    z.string(),
    z.object({
      uniqueLabels: z.number().int().min(0),
      meanLabelLength: z.number(),
      meanHammingDistance: z.number(),
      meanAspectRatio: z.number(),
      sampledPairs: z.number().int().min(0),
    }),
  ),
  currency: z.record(z.string(), z.number().int().min(0)),
  actions: z.record(z.string(), z.number().int().min(0)),
  allInRate: z.number().min(0).max(100),
});
export const pokerStatsSchema = z.object({
  images: z.number().int().min(0),
  captures: z.number().int().min(0),
  emptyLabels: z.number().int().min(0),
  byRegion: z.record(z.string(), z.number().int().min(0)),
  metrics: pokerDatasetMetricsSchema.optional(),
});
export const pokerMonitorSchema = z.object({
  name: z.string(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export const pokerGameStateSchema = z.object({
  in_play_seats: z.array(z.number()),
  seat_usernames: z.record(z.string(), z.string()),
  seat_cards: z.record(z.string(), z.array(z.string())),
  seat_bets: z.record(z.string(), z.string()),
  active_seat: z.number().nullable(),
  active_seat_color: z.string().nullable(),
  my_seat_index: z.number().nullable(),
  community_cards: z.array(z.string().nullable()),
  game_id: z.string().nullable(),
});
export const pokerBootstrapSchema = z.object({
  dataDir: z.string(),
  monitors: z.array(pokerMonitorSchema),
  settings: pokerSettingsSchema,
  session: pokerSessionSchema,
  history: z.array(z.object({ timestamp: z.number(), data: z.unknown() })),
  stats: pokerStatsSchema,
  regions: pokerRegionsSchema,
  screenWidth: z.number().int().min(1),
  screenHeight: z.number().int().min(1),
  warnings: z.array(z.string()),
});

const empty = z.object({});
const changed = z.object({ changed: z.number().int().min(0) });
export const pokerOperations = {
  bootstrap: { request: empty, response: pokerBootstrapSchema },
  entries: {
    request: z.object({
      search: z.string(),
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(250),
    }),
    response: z.object({ items: z.array(pokerEntrySchema), total: z.number().int().min(0) }),
  },
  image: {
    request: z.object({ filename: z.string(), kind: z.enum(["crop", "capture"]) }),
    response: z.object({ dataUrl: z.string() }),
  },
  capture: { request: z.object({ monitor: z.string() }), response: pokerFrameSchema },
  save_session: { request: z.object({ session: pokerSessionSchema }), response: changed },
  commit_session: { request: z.object({ session: pokerSessionSchema }), response: changed },
  clear_session: { request: empty, response: changed },
  update_labels: {
    request: z.object({ filenames: z.array(z.string()).min(1).max(250), label: z.string() }),
    response: changed,
  },
  delete_entries: {
    request: z.object({ filenames: z.array(z.string()).min(1).max(250) }),
    response: changed,
  },
  clear_database: { request: z.object({ confirmation: z.literal("CLEAR") }), response: changed },
  save_settings: { request: z.object({ settings: pokerSettingsSchema }), response: changed },
  save_regions: {
    request: z.object({
      regions: pokerRegionsSchema,
      screenWidth: z.number().int().min(1).max(16384),
      screenHeight: z.number().int().min(1).max(16384),
    }),
    response: changed,
  },
  recrop: {
    request: empty,
    response: z.object({ changed: z.number().int().min(0), skipped: z.number().int().min(0) }),
  },
  import_dataset: { request: z.object({ path: z.string().min(1) }), response: changed },
  game_state: {
    request: z.object({ monitor: z.string(), username: z.string() }),
    response: z.object({ state: pokerGameStateSchema, screenshot: z.string() }),
  },
} as const;

export type PokerOperation = keyof typeof pokerOperations;
export type PokerPayload<K extends PokerOperation> = z.infer<
  (typeof pokerOperations)[K]["request"]
>;
export type PokerResult<K extends PokerOperation> = z.infer<
  (typeof pokerOperations)[K]["response"]
>;
export type PokerRect = z.infer<typeof pokerRectSchema>;
export type PokerRegions = z.infer<typeof pokerRegionsSchema>;
export type PokerSample = z.infer<typeof pokerSampleSchema>;
export type PokerFrame = z.infer<typeof pokerFrameSchema>;
export type PokerSession = z.infer<typeof pokerSessionSchema>;
export type PokerSettings = z.infer<typeof pokerSettingsSchema>;
export type PokerEntry = z.infer<typeof pokerEntrySchema>;
export type PokerBootstrap = z.infer<typeof pokerBootstrapSchema>;
