import { describe, expect, it } from "vitest";
import { pokerOperations, type PokerFrame, type PokerSample } from "@unimatrix/shared";
import {
  appendFrame,
  canonicalRegionId,
  checkedRegions,
  completeLabel,
  decideSample,
  defaultRegionIds,
  emptySession,
  exportNativeRegions,
  labelCategory,
  normalizeLabel,
  removeSamples,
  sessionReady,
  validateLabel,
} from "../src/index.js";
import { createPokerClient } from "../src/client.js";

const sample: PokerSample = {
  key: "a",
  regionId: "seats[0].cards[0]",
  label: "",
  source: "cap.png",
  phash: "aabb",
  rect: { x: 0, y: 0, w: 5, h: 5 },
  image: "data:image/png;base64,AA==",
  decision: "pending",
};
const frame: PokerFrame = {
  key: "frame",
  source: "cap.png",
  gameId: "#123456",
  thumbnail: sample.image,
  crops: [sample],
};

describe("legacy region identity and native export", () => {
  it.each([
    ["pot", "pot.main"],
    ["split_pot", "pot.split"],
    ["community_cards[0]", "community.card_1"],
    ["community_cards[4]", "community.card_5"],
    ["seats[8].cards[1]", "seat.8.hand_1"],
    ["seats[0].bank", "seat.0.bank"],
    ["seat.0.name", "seat.0.name"],
    ["custom", "custom"],
  ])("adapts %s without altering unrelated IDs", (id, expected) => {
    expect(canonicalRegionId(id)).toBe(expected);
  });

  it("exports every configured rectangle with explicit absent slots", () => {
    const flat = Object.fromEntries(defaultRegionIds().map((id) => [id, sample.rect]));
    const exported = exportNativeRegions(flat, 1920, 1080);
    expect(exported.seats).toHaveLength(9);
    expect(exported.seats[8]?.cards).toEqual([sample.rect, sample.rect]);
    expect(exported.community_cards).toHaveLength(5);
    expect(exported.pot).toEqual(sample.rect);
    expect(exported.split_pot).toEqual(sample.rect);
    expect(exported.round_id).toEqual(sample.rect);
    expect(exportNativeRegions({}, 50, 50).seats[0]).toEqual({
      name: null,
      nameplate: null,
      bank: null,
      bet: null,
      status: null,
      dealer: null,
      cards: [null, null],
    });
  });

  it("rejects duplicate aliases, invalid rectangles and dimensions", () => {
    expect(checkedRegions({ pot: sample.rect }, 5, 5)).toEqual({ "pot.main": sample.rect });
    expect(() => checkedRegions({ pot: sample.rect, "pot.main": sample.rect }, 5, 5)).toThrow(
      "Duplicate",
    );
    expect(() => checkedRegions({ invalid: sample.rect }, 5, 5)).toThrow("Unknown");
    expect(() => checkedRegions({ pot: sample.rect }, 4, 5)).toThrow("outside");
    expect(() => checkedRegions({ pot: { ...sample.rect, w: 0 } }, 5, 5)).toThrow();
    for (const width of [0, -1, 1.5, Infinity, 16385])
      expect(() => checkedRegions({}, width, 5)).toThrow("dimensions");
    expect(() => checkedRegions({}, 5, 0)).toThrow("dimensions");
  });
});

describe("label semantics", () => {
  it.each([
    ["seat.0.name", "Player1...", "Player1.", "name"],
    ["seat.0.status", "All-In", "fold", "status"],
    ["seat.0.dealer", "D", "dealer", "dealer"],
    ["seats[0].cards[1]", "10", "T", "card"],
    ["community.card_2", "K", "10s", "card"],
    ["seat.0.bet", "G 10.5 BB", "G 10.55 BB", "money"],
    ["seat.0.bank", "All-In", "All in", "bank"],
    ["pot", "Pot: S 3 BB", "G 1 BB", "pot"],
    ["split_pot", "G 3 BB S 2.5 BB", "3 2", "split"],
    ["round_id", "#123456", "prefix #123456 suffix", "game"],
  ])("validates %s independently of UI", (id, valid, invalid, category) => {
    expect(labelCategory(id)).toBe(category);
    expect(validateLabel(id, valid)).toBeNull();
    expect(validateLabel(id, invalid)).toBeTypeOf("string");
    expect(validateLabel(id, "")).toBeNull();
  });

  it("rejects unknown region labels and accepts the pause format", () => {
    expect(labelCategory("custom.text")).toBe("other");
    expect(validateLabel("custom.text", "unrestricted\ntext")).toBe("Unsupported OCR region.");
    expect(validateLabel("pot.main", "Run It Twice pause (5 sec)")).toBeNull();
    expect(validateLabel("seat.0.bank", "S 4 BB")).toBeNull();
  });

  it("normalizes casing and spacing without fabricating username letters", () => {
    expect(normalizeLabel("seat.0.name", " PlayerOne... ")).toBe("PlayerOne...");
    expect(normalizeLabel("seat.0.status", "all-in")).toBe("All-In");
    expect(normalizeLabel("seat.0.bank", "all-in")).toBe("All-In");
    expect(normalizeLabel("pot", "pot:  g 2.5 bb")).toBe("Pot: G 2.5 BB");
    expect(normalizeLabel("seat.0.bet", "s 3 bb")).toBe("S 3 BB");
    expect(normalizeLabel("seat.0.dealer", "d")).toBe("D");
    expect(normalizeLabel("seat.0.hand_0", "a")).toBe("A");
  });

  it.each([
    ["seat.0.status", "k", [], "Check"],
    ["seat.0.status", "rai", [], "Raise"],
    ["seat.0.status", "shc", [], "Show Cards"],
    ["seat.0.status", "Call", [], null],
    ["seat.0.hand_0", "1", [], "10"],
    ["seat.0.hand_0", "a", [], "A"],
    ["seat.0.name", "Pla", ["Player1", "invalid!"], "Player1"],
    ["seat.0.name", "Pyr", ["Player1"], "Player1"],
    ["seat.0.name", "User.", [], "User..."],
    ["seat.0.bank", "al", [], "All-In"],
    ["seat.0.bet", "g 3", [], "G 3 BB"],
    ["pot.main", "Pot: S 3 B", [], "Pot: S 3 BB"],
    ["seat.0.bet", "nonsense", [], null],
    ["seat.0.name", "", [], null],
    ["unknown", "value", [], null],
  ])("completes %s / %s only as a suggestion", (id, input, known, expected) => {
    expect(completeLabel(id, input, known)).toBe(expected);
  });
});

describe("recoverable labeling session", () => {
  it("deduplicates aliases while retaining different regions and frames", () => {
    const session = appendFrame(emptySession(), frame);
    expect(appendFrame(session, frame)).toBe(session);
    const next = appendFrame(session, {
      ...frame,
      key: "second",
      crops: [
        { ...sample, key: "alias", regionId: "seat.0.hand_0" },
        { ...sample, key: "b", regionId: "seat.1.hand_0" },
        { ...sample, key: "c", regionId: "seat.1.hand_0" },
      ],
    });
    expect(next.pool.map((item) => item.key)).toEqual(["a", "b"]);
    expect(session.pool[0]?.decision).toBe("pending");
    expect(sessionReady(session)).toBe(false);
  });

  it("requires explicit blank and discard and updates frame copies", () => {
    const session = appendFrame(emptySession(), frame);
    expect(() => decideSample(session, "a", "label", "")).toThrow("Blank");
    expect(() => decideSample(session, "a", "label", "not a card")).toThrow("rank");
    expect(() => decideSample(session, "gone", "label", "A")).toThrow("no longer exists");
    const labeled = decideSample(session, "a", "label", "a");
    expect(labeled.pool[0]?.label).toBe("A");
    expect(labeled.frames[0]?.crops[0]?.label).toBe("A");
    expect(sessionReady(labeled)).toBe(true);
    for (const decision of ["blank", "discard"] as const) {
      const next = decideSample(labeled, "a", decision, "A");
      expect(next.pool[0]?.label).toBe("");
      expect(sessionReady(next)).toBe(true);
    }
    expect(sessionReady(decideSample(labeled, "a", "pending", "A"))).toBe(false);
  });

  it("rejects malformed recovered sessions and inconsistent decisions", () => {
    expect(sessionReady(emptySession())).toBe(false);
    const ready = decideSample(appendFrame(emptySession(), frame), "a", "label", "A");
    expect(sessionReady({ ...ready, pool: [...ready.pool, ...ready.pool] })).toBe(false);
    for (const item of [
      { ...sample, label: "", decision: "label" as const },
      { ...sample, label: "invalid", decision: "label" as const },
      { ...sample, label: "A", decision: "blank" as const },
    ])
      expect(sessionReady({ ...ready, pool: [item] })).toBe(false);
    expect(sessionReady({ ...ready, currentIndex: -1 })).toBe(false);
  });

  it("removes samples from frames and clamps the current index", () => {
    const next = removeSamples({ ...appendFrame(emptySession(), frame), currentIndex: 9 }, ["a"]);
    expect(next.pool).toEqual([]);
    expect(next.frames[0]?.crops).toEqual([]);
    expect(next.currentIndex).toBe(0);
    expect(removeSamples(appendFrame(emptySession(), frame), ["other"]).pool).toHaveLength(1);
  });
});

describe("validated native client", () => {
  it("validates both directions and propagates native errors", async () => {
    const calls: unknown[] = [];
    const client = createPokerClient((operation, payload) => {
      calls.push({ operation, payload });
      return Promise.resolve({ changed: 3 });
    });
    expect(await client("clear_session", {})).toEqual({ changed: 3 });
    expect(calls).toEqual([{ operation: "clear_session", payload: {} }]);
    await expect(client("clear_database", { confirmation: "NO" as "CLEAR" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    await expect(
      createPokerClient(() => Promise.resolve({ changed: -1 }))("clear_session", {}),
    ).rejects.toThrow();
    await expect(
      createPokerClient(() => Promise.reject(new Error("native unavailable")))("clear_session", {}),
    ).rejects.toThrow("native unavailable");
  });

  it("rejects IPC inputs that could bypass UI constraints", () => {
    expect(
      pokerOperations.save_regions.request.safeParse({
        regions: { pot: sample.rect },
        screenWidth: 0,
        screenHeight: 1080,
      }).success,
    ).toBe(false);
    expect(
      pokerOperations.entries.request.safeParse({ search: "", offset: -1, limit: 9999 }).success,
    ).toBe(false);
    expect(
      pokerOperations.save_settings.request.safeParse({
        settings: { monitor: "DP-1", username: "", captureIntervalMs: 100 },
      }).success,
    ).toBe(false);
  });
});
