import { pokerRegionsSchema, type PokerRect, type PokerRegions } from "@unimatrix/shared";

export function canonicalRegionId(id: string): string {
  if (id === "pot") return "pot.main";
  if (id === "split_pot") return "pot.split";
  const community = /^community_cards\[([0-4])\]$/.exec(id);
  if (community) return `community.card_${Number(community[1]) + 1}`;
  const seat = /^seats\[([0-8])\]\.(name|nameplate|bank|bet|status|dealer|cards\[([01])\])$/.exec(
    id,
  );
  if (seat) return `seat.${seat[1]}.${seat[3] === undefined ? seat[2] : `hand_${seat[3]}`}`;
  return id;
}

export function defaultRegionIds(): string[] {
  return [
    "round_id",
    "pot.main",
    "pot.split",
    ...Array.from({ length: 5 }, (_, i) => `community.card_${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) =>
      ["name", "nameplate", "bank", "bet", "hand_0", "hand_1", "status", "dealer"].map(
        (field) => `seat.${i}.${field}`,
      ),
    ).flat(),
  ];
}

export function checkedRegions(regions: PokerRegions, width: number, height: number): PokerRegions {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384
  )
    throw new Error("Invalid screen dimensions.");
  const parsed = pokerRegionsSchema.parse(regions);
  const result: PokerRegions = {};
  const allowed = new Set(defaultRegionIds());
  for (const [id, rect] of Object.entries(parsed)) {
    const canonical = canonicalRegionId(id);
    if (!allowed.has(canonical)) throw new Error(`Unknown region: ${id}`);
    if (canonical in result) throw new Error(`Duplicate region: ${canonical}`);
    if (rect.x + rect.w > width || rect.y + rect.h > height)
      throw new Error(`Region outside image: ${id}`);
    result[canonical] = { ...rect };
  }
  return result;
}

export interface NativePokerRegions {
  screen_width: number;
  screen_height: number;
  round_id: PokerRect | null;
  pot: PokerRect | null;
  split_pot: PokerRect | null;
  community_cards: (PokerRect | null)[];
  seats: Record<string, PokerRect | (PokerRect | null)[] | null>[];
}

export function exportNativeRegions(
  flat: PokerRegions,
  width: number,
  height: number,
): NativePokerRegions {
  const regions = checkedRegions(flat, width, height);
  return {
    screen_width: width,
    screen_height: height,
    round_id: regions.round_id ?? null,
    pot: regions["pot.main"] ?? null,
    split_pot: regions["pot.split"] ?? null,
    community_cards: Array.from(
      { length: 5 },
      (_, i) => regions[`community.card_${i + 1}`] ?? null,
    ),
    seats: Array.from({ length: 9 }, (_, i) => ({
      name: regions[`seat.${i}.name`] ?? null,
      nameplate: regions[`seat.${i}.nameplate`] ?? null,
      bank: regions[`seat.${i}.bank`] ?? null,
      bet: regions[`seat.${i}.bet`] ?? null,
      status: regions[`seat.${i}.status`] ?? null,
      dealer: regions[`seat.${i}.dealer`] ?? null,
      cards: [regions[`seat.${i}.hand_0`] ?? null, regions[`seat.${i}.hand_1`] ?? null],
    })),
  };
}
