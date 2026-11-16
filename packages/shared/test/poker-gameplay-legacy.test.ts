import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  pokerGameplayFrameSummarySchema,
  pokerGameplayHandSchema,
  pokerGameplayReadingVerificationSchema,
} from "../src/schemas/poker-gameplay-lists";
import {
  pokerGameplayAiItemsSchema,
  pokerGameplayAiPrepareSchema,
  pokerGameplayAiReviewResponseSchema,
  pokerGameplayAiJobSchema,
} from "../src/schemas/poker-gameplay-ai";

const provenance = {
  policy: "occurrence_owned_legacy_annotations_v2",
  source_dataset: "fixture",
  source_database: "/fixture/data.db",
  source_database_receipt: { "data.db": "digest" },
  source_region_id: "seats[0].status",
  target_region_id: "seats[0].status",
  target_profile_id: "profile",
  target_profile_sha256: "profile-digest",
  source_config_digest: "original-config",
  original_rect: { x: 1, y: 2, w: 3, h: 4 },
  original_pixel_sha256: "pixels",
  original_image_sha256: "png",
  label_present: true,
  explicit_blank: true,
  pixel_relationship: "source crop differs from current tight crop",
  visually_verified: false,
  capture: { id: 1 },
  crop: { id: 2, label: "" },
};
it("requires distinct source provenance for verified legacy blanks", () => {
  const reading = { state: "legacy_verified", source: "legacy", legacy_provenance: provenance };
  expect(pokerGameplayReadingVerificationSchema.parse(reading)).toEqual(reading);
  for (const invalid of [
    { ...reading, source: "ai" },
    { ...reading, legacy_provenance: null },
    { ...reading, legacy_provenance: { ...provenance, visually_verified: true } },
  ])
    expect(pokerGameplayReadingVerificationSchema.safeParse(invalid).success).toBe(false);
});

const fixturePath = process.env.POKER_MIGRATED_RESPONSE_FIXTURE;
it.runIf(fixturePath)("validates exported native legacy, new-field and corrected responses", () => {
  const fixture = z
    .object({
      initial_details: z.array(pokerGameplayFrameSummarySchema),
      persisted_details: z.array(pokerGameplayFrameSummarySchema),
      frames: z.object({ frames: z.array(pokerGameplayFrameSummarySchema) }),
      games: z.object({ hands: z.array(pokerGameplayHandSchema) }),
      paged: z.tuple([
        z.object({ items: z.array(pokerGameplayHandSchema) }),
        z.object({ items: z.array(pokerGameplayFrameSummarySchema) }),
      ]),
      verified_prepare: pokerGameplayAiPrepareSchema,
      verified_items: pokerGameplayAiItemsSchema,
      verified_status: z.object({ job: pokerGameplayAiJobSchema }),
      prepare: pokerGameplayAiPrepareSchema,
      items: pokerGameplayAiItemsSchema,
      reviews: z.array(pokerGameplayAiReviewResponseSchema),
      status: z.object({ job: pokerGameplayAiJobSchema }),
    })
    .parse(JSON.parse(readFileSync(fixturePath!, "utf8")) as unknown);
  for (const detail of [...fixture.initial_details, ...fixture.persisted_details]) {
    const parsed = pokerGameplayFrameSummarySchema.parse(detail);
    expect(parsed.verification?.total).toBeGreaterThan(0);
  }
  for (const hand of fixture.games.hands) pokerGameplayHandSchema.parse(hand);
  for (const frame of fixture.frames.frames) pokerGameplayFrameSummarySchema.parse(frame);
  for (const hand of fixture.paged[0].items) pokerGameplayHandSchema.parse(hand);
  for (const frame of fixture.paged[1].items) pokerGameplayFrameSummarySchema.parse(frame);
  pokerGameplayAiPrepareSchema.parse(fixture.verified_prepare);
  const verifiedItems = pokerGameplayAiItemsSchema.parse(fixture.verified_items);
  expect(
    verifiedItems.items.every(
      (item) => item.source === "legacy" && item.legacy_provenance?.visually_verified === false,
    ),
  ).toBe(true);
  pokerGameplayAiJobSchema.parse(fixture.verified_status.job);
  pokerGameplayAiPrepareSchema.parse(fixture.prepare);
  pokerGameplayAiItemsSchema.parse(fixture.items);
  for (const review of fixture.reviews) pokerGameplayAiReviewResponseSchema.parse(review);
  pokerGameplayAiJobSchema.parse(fixture.status.job);
  expect(fixture.initial_details[0]?.effective_results?.["seats[0].status"]).toMatchObject({
    prediction: { text: "" },
    verification: { state: "legacy_verified" },
  });
  expect(fixture.persisted_details[0]?.effective_results?.["seats[0].name"]).toMatchObject({
    verification: { source: "human" },
  });
});
