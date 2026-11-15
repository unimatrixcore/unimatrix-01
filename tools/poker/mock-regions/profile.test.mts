import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveLegacySeatOffset,
  geometryOnly,
  regionContentKind,
  type GeometryRegion,
} from "./profile.mts";
import type { Region } from "./extract.mts";

test("seat rotation is derived from measured name allocations and rejects inconsistent maps", () => {
  const regions: GeometryRegion[] = Array.from({ length: 9 }, (_, seat) => ({
    id: `seat.${seat}.name`,
    category: "name",
    seat,
    template: null,
    cardSlot: null,
    rotation: 0,
    bounds: { x: seat * 100, y: 0, width: 40, height: 20 },
    polygon: null,
  }));
  const legacy = {
    seats: Array.from({ length: 9 }, (_, seat) => ({
      name: { x: ((seat + 3) % 9) * 100, y: 0, w: 40, h: 20 },
    })),
  };
  assert.equal(deriveLegacySeatOffset(legacy, regions), 3);
  legacy.seats[0].name.x = 400;
  assert.throws(() => deriveLegacySeatOffset(legacy, regions), /consistent rotation/);
});

test("all seat guide exports are independent of current OCR ink and labels", () => {
  const profile = JSON.parse(
    readFileSync(
      new URL("../../../packages/poker-native/assets/gameplay-regions.json", import.meta.url),
      "utf8",
    ),
  ) as { regions: GeometryRegion[] };
  for (let seat = 0; seat < 9; seat++) {
    const measured = profile.regions.find((region) => region.id === `seats[${seat}].bet`)!;
    assert.ok(measured.guide, measured.id);
    const base = {
      ...measured,
      label: "1 BB",
      visibility: "visible" as const,
      reason: null,
      labelEvidence: "controlled_render_state" as const,
      visuallyVerified: false as const,
      rotation: measured.rotation ?? 0,
      seat,
      template: measured.template ?? null,
      cardSlot: null,
    };
    const short = geometryOnly({ ...base, inkBounds: { ...measured.bounds!, width: 1 } })!;
    const long = geometryOnly({
      ...base,
      label: "9,007,199,254,740,991 BB",
      inkBounds: measured.bounds!,
    })!;
    assert.deepEqual(short.guide, long.guide, measured.id);
    assert.equal(short.guide!.anchor.y, short.guide!.slot.y + short.guide!.slot.height / 2);
    assert.ok(short.guide!.slot.width <= short.bounds!.width);
  }
});

test("visual timer bars and canvases never fabricate rendered seconds", () => {
  for (const region of [
    { id: "header.timer", category: "timer" },
    { id: "seat.0.timer_bar", category: "timer_bar" },
    { id: "seat.0.active", category: "active" },
  ])
    assert.deepEqual(regionContentKind(region), { ocr: false, source_content: "visual_indicator" });
  for (const region of [
    { id: "seat.0.timer", category: "timer" },
    { id: "seat.0.dealer", category: "dealer" },
    { id: "board.0.suit", category: "suit" },
  ])
    assert.deepEqual(regionContentKind(region), { ocr: true, source_content: "text" });
});

test("exported geometry cannot carry synthetic labels or visibility into real recordings", () => {
  const region = {
    id: "board.0.rank",
    category: "rank",
    seat: null,
    template: null,
    cardSlot: 0,
    rotation: 0,
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    polygon: [
      { x: 1, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 6 },
      { x: 1, y: 6 },
    ],
    label: "A",
    cropLabel: "A",
    visibility: "visible",
    reason: null,
    autoLabelEligible: true,
    labelEvidence: "controlled_render_state",
    visuallyVerified: false,
  } satisfies Region;
  const result = geometryOnly(region)!;
  for (const key of [
    "label",
    "cropLabel",
    "visibility",
    "autoLabelEligible",
    "labelEvidence",
    "visuallyVerified",
  ])
    assert.equal(key in result, false, key);
  assert.equal(geometryOnly({ ...region, bounds: null }), null);
  assert.equal(geometryOnly({ ...region, bounds: { x: NaN, y: 0, width: 1, height: 1 } }), null);
});

test("every textual bundled region has a finite nominal guide within its full envelope", () => {
  const profile = JSON.parse(
    readFileSync(
      new URL("../../../packages/poker-native/assets/gameplay-regions.json", import.meta.url),
      "utf8",
    ),
  ) as { regions: GeometryRegion[] };
  for (const region of profile.regions.filter((r) => r.ocr)) {
    assert.ok(region.guide, region.id);
    assert.equal(region.guideUnsupportedReason, undefined, region.id);
    const b = region.bounds!,
      s = region.guide.slot;
    assert.ok(s.width > 0 && s.height > 0, region.id);
    assert.ok(
      s.x >= b.x - 0.01 &&
        s.y >= b.y - 0.01 &&
        s.x + s.width <= b.x + b.width + 0.01 &&
        s.y + s.height <= b.y + b.height + 0.01,
      region.id,
    );
  }
});

test("active profile preserves original71 OCR fields and9 CV contexts plus23 suits and one table line", () => {
  const profile = JSON.parse(
    readFileSync(
      new URL("../../../packages/poker-native/assets/gameplay-regions.json", import.meta.url),
      "utf8",
    ),
  );
  const ids = new Set(profile.regions.map((r: { id: string }) => r.id));
  assert.equal(profile.regions.length, 104);
  assert.equal(profile.regions.filter((r: { ocr: boolean }) => r.ocr !== false).length, 95);
  for (let seat = 0; seat < 9; seat++)
    for (const field of [
      "name",
      "nameplate",
      "bank",
      "bet",
      "status",
      "dealer",
      "cards[0]",
      "cards[1]",
      "cards[0].suit",
      "cards[1].suit",
    ])
      assert.ok(ids.has(`seats[${seat}].${field}`));
  for (let card = 0; card < 5; card++) {
    assert.ok(ids.has(`community_cards[${card}]`));
    assert.ok(ids.has(`community_cards[${card}].suit`));
  }
  for (const id of ["round_id", "pot", "split_pot", "table.info"]) assert.ok(ids.has(id));
  assert.equal(profile.legacy_seat_offset, 0);
  assert.equal(profile.source_seat_offset, 3);
  assert.equal(
    profile.regions.filter((r: { id: string }) => /award|combination|high_hand|pot\./.test(r.id))
      .length,
    0,
  );
  for (const r of profile.regions.filter((r: { ocr: boolean }) => r.ocr === false)) {
    assert.match(r.id, /^seats\[\d\]\.nameplate$/);
    assert.equal(r.overlay, false);
  }
  assert.ok(
    profile.regions
      .find((r: { id: string }) => r.id === "split_pot")
      .localizer.exclude_region_categories.includes("bet"),
  );
});
