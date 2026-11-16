import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { extractRegions, type Region } from "./extract.mts";
import { loopbackUrl, type Bounds } from "./geometry.mts";

const options = z.object({
  url: z.string().transform(loopbackUrl),
  output: z.string().min(1),
  width: z.coerce.number().int().min(640).max(7680).default(1920),
  height: z.coerce.number().int().min(480).max(4320).default(1080),
  legacyConfig: z.string().optional(),
  geometryBase: z.string().optional(),
});

export type GeometryRegion = Pick<
  Region,
  | "id"
  | "category"
  | "bounds"
  | "polygon"
  | "rotation"
  | "seat"
  | "template"
  | "cardSlot"
  | "envelope"
  | "guide"
  | "guideUnsupportedReason"
> & { ocr?: boolean; source_content?: "text" | "visual_indicator" };

export function regionContentKind(region: Pick<Region, "id" | "category">) {
  const visual = region.id === "header.timer" || ["timer_bar", "active"].includes(region.category);
  return {
    ocr: !visual,
    source_content: visual ? ("visual_indicator" as const) : ("text" as const),
  };
}

export function deriveLegacySeatOffset(legacy: unknown, regions: GeometryRegion[]) {
  const parsed = z
    .object({
      seats: z
        .array(
          z.object({
            name: z.object({
              x: z.number(),
              y: z.number(),
              w: z.number().positive(),
              h: z.number().positive(),
            }),
          }),
        )
        .length(9),
    })
    .parse(legacy);
  const offsets = parsed.seats.map((seat, index) => {
    const center = { x: seat.name.x + seat.name.w / 2, y: seat.name.y + seat.name.h / 2 };
    const matches = regions
      .filter((r) => r.category === "name" && r.bounds && r.seat !== null)
      .map((r) => ({
        seat: r.seat!,
        distance: Math.hypot(
          center.x - r.bounds!.x - r.bounds!.width / 2,
          center.y - r.bounds!.y - r.bounds!.height / 2,
        ),
      }))
      .sort((a, b) => a.distance - b.distance);
    if (
      !matches[0] ||
      matches[0].distance > Math.max(seat.name.w, seat.name.h) ||
      (matches[1] && matches[1].distance < matches[0].distance * 2)
    )
      throw new Error(`Ambiguous legacy seat ${index} mapping`);
    return (matches[0].seat - index + 9) % 9;
  });
  if (new Set(offsets).size !== 1)
    throw new Error("Legacy seat mapping is not one consistent rotation");
  return offsets[0];
}

export function geometryOnly(region: Region): GeometryRegion | null {
  if (
    !region.bounds ||
    !region.polygon ||
    !Number.isFinite(
      region.bounds.x + region.bounds.y + region.bounds.width + region.bounds.height,
    ) ||
    region.bounds.width <= 0 ||
    region.bounds.height <= 0
  )
    return null;
  const { id, category, bounds, polygon, rotation, seat, template, cardSlot, envelope, guide } =
    region;
  return {
    id,
    category,
    bounds,
    polygon,
    rotation,
    seat,
    template,
    cardSlot,
    envelope,
    guide,
    guideUnsupportedReason: region.guideUnsupportedReason,
    ...regionContentKind(region),
  };
}

function union(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function attachGuides(base: GeometryRegion[], measured: GeometryRegion[]): GeometryRegion[] {
  if (new Set(base.map((r) => r.id)).size !== base.length || base.length !== measured.length)
    throw new Error("Geometry base must contain the same unique region identities");
  return base.map((region) => {
    const current = measured.find((r) => r.id === region.id);
    if (!current?.guide || current.category !== region.category || !region.bounds)
      throw new Error(`Guide does not match validated geometry: ${region.id}`);
    if (["award", "popup"].includes(region.category))
      return geometryOnly({ ...current, guideUnsupportedReason: undefined } as Region)!;
    const b = region.bounds,
      s = current.guide.slot;
    const slot = {
      x: Math.max(b.x, s.x),
      y: Math.max(b.y, s.y),
      width: Math.max(0, Math.min(b.x + b.width, s.x + s.width) - Math.max(b.x, s.x)),
      height: Math.max(0, Math.min(b.y + b.height, s.y + s.height) - Math.max(b.y, s.y)),
    };
    if (slot.width <= 0 || slot.height <= 0)
      throw new Error(`Source CSS guide is outside the validated envelope: ${region.id}`);
    const alignment = current.guide.alignment;
    const guide = {
      ...current.guide,
      slot,
      anchor: {
        x:
          alignment === "left"
            ? slot.x
            : alignment === "right"
              ? slot.x + slot.width
              : slot.x + slot.width / 2,
        y: slot.y + slot.height / 2,
      },
    };
    return geometryOnly({ ...region, guide, guideUnsupportedReason: undefined } as Region)!;
  });
}

export async function generateProfile(input: z.input<typeof options>) {
  const config = options.parse(input);
  const browser = await chromium.launch({ headless: true });
  const measured = new Map<string, GeometryRegion>();
  const missing = new Map<string, string>();
  try {
    const page = await browser.newPage({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === new URL(config.url).origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(config.url);
    await page.waitForFunction(() => typeof window.poker?.ready === "function");
    for (let seat = 0; seat < 9; seat++) {
      for (const mode of ["playing", "sitout", "showdown", "bar_timer"]) {
        await page.evaluate(
          async ({ seat, mode }) => {
            window.poker.replay.pause();
            window.poker.setState({
              seats: window.poker.getState().seats.map((s, i) => ({
                ...s,
                name: `Player${i}`,
                stack: 10,
                bet: 1,
                cards: ["As", "Td"],
                status: mode === "sitout" ? "sitout" : "playing",
                action: mode === "sitout" ? "" : "Raise",
                hand: "One Pair",
                winner: mode === "showdown",
                award: mode === "showdown" ? 1 : 0,
                combinationNames: [{ rowIndex: 0, text: "One Pair: Aces" }],
              })),
              board: ["As", "Td", "4c", "8h", "Ks"],
              active: mode === "sitout" ? null : seat,
              dealer: seat,
              bank: 10,
              pots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              highHand: "One Pair: Aces",
              timer: {
                remaining: 14,
                total: 30,
                running: false,
                variant: mode === "bar_timer" ? "default" : "digital",
              },
            });
            window.poker.effects.message(seat, "Time bank activated");
            await window.poker.ready();
            document.getAnimations().forEach((a) => a.pause());
          },
          { seat, mode },
        );
        const result = await page.evaluate(extractRegions);
        for (const region of result.regions) {
          if (region.id === "dealer") {
            region.id = `seat.${seat}.dealer`;
            region.seat = seat;
          }
          const geometry = geometryOnly(region);
          if (!geometry) {
            if (!measured.has(region.id))
              missing.set(region.id, region.reason ?? "Not measured in supported state");
            continue;
          }
          missing.delete(region.id);
          const prior = measured.get(region.id);
          if (prior?.bounds && geometry.bounds && !["rank", "suit"].includes(geometry.category)) {
            geometry.bounds = union(prior.bounds, geometry.bounds);
            const b = geometry.bounds;
            geometry.polygon = [
              { x: b.x, y: b.y },
              { x: b.x + b.width, y: b.y },
              { x: b.x + b.width, y: b.y + b.height },
              { x: b.x, y: b.y + b.height },
            ];
          }
          measured.set(region.id, geometry);
        }
      }
    }
    let regions = [...measured.values()].sort((a, b) => a.id.localeCompare(b.id));
    let geometryBaseHash: string | undefined;
    if (config.geometryBase) {
      const base = JSON.parse(await readFile(config.geometryBase, "utf8")) as {
        viewport: { width: number; height: number };
        regions: GeometryRegion[];
      };
      if (base.viewport.width !== config.width || base.viewport.height !== config.height)
        throw new Error("Geometry base viewport differs from the measured CSS layout");
      regions = attachGuides(base.regions, regions);
      geometryBaseHash = createHash("sha256")
        .update(
          JSON.stringify(
            base.regions.map(({ id, category, bounds, polygon, rotation }) => ({
              id,
              category,
              bounds,
              polygon,
              rotation,
            })),
          ),
        )
        .digest("hex");
    }
    for (const id of [
      "game.id",
      "table.info",
      "pot.total",
      ...Array.from({ length: 9 }, (_, i) => [
        `seat.${i}.name`,
        `seat.${i}.bank`,
        `seat.${i}.bet`,
        `seat.${i}.card.0.rank`,
        `seat.${i}.card.0.suit`,
        `seat.${i}.card.1.rank`,
        `seat.${i}.card.1.suit`,
      ]).flat(),
      ...Array.from({ length: 5 }, (_, i) => [`board.${i}.rank`, `board.${i}.suit`]).flat(),
    ]) {
      if (!measured.has(id)) throw new Error(`Required region could not be derived: ${id}`);
    }
    const core = {
      schema_version: 1,
      viewport: { width: config.width, height: config.height },
      regions,
      unsupported: [...missing].map(([id, reason]) => ({ id, reason })),
      ...(config.legacyConfig
        ? {
            legacy_seat_offset: deriveLegacySeatOffset(
              JSON.parse(await readFile(config.legacyConfig, "utf8")),
              regions,
            ),
          }
        : {}),
      ...(geometryBaseHash ? { geometry_base_sha256: geometryBaseHash } : {}),
    };
    const profile = {
      id: createHash("sha256").update(JSON.stringify(core)).digest("hex"),
      source: "mock_dom_css_and_full_deck_envelopes",
      ...core,
    };
    await writeFile(config.output, JSON.stringify(profile, null, 2) + "\n", { flag: "wx" });
    return {
      output: resolve(config.output),
      id: profile.id,
      regions: regions.length,
      unsupported: core.unsupported,
      legacy_seat_offset: profile.legacy_seat_offset,
    };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.slice(2);
    if (
      !["url", "output", "width", "height", "legacyConfig", "geometryBase"].includes(key) ||
      !process.argv[i + 1]
    )
      throw new Error(
        "Usage: profile.mts --url http://127.0.0.1:5173 --output /tmp/gameplay-regions.json [--width 1920 --height 1080 --legacyConfig /path/archived-regions.json]",
      );
    values[key] = process.argv[i + 1];
  }
  if ((values.width && values.width !== "1920") || (values.height && values.height !== "1080"))
    throw new Error("The active Gameplay layout is fullscreen1920x1080");
  if (values.geometryBase)
    throw new Error(
      "Active profiles are regenerated from source CSS; geometryBase is research-only",
    );
  if (values.legacyConfig)
    throw new Error(
      "Active profiles use the documented fixed seat mapping; legacyConfig is research-only",
    );
  const { generateTightProfile } = await import("./tight-profile.mts");
  const profile = await generateTightProfile({ url: values.url!, output: values.output! });
  console.log(
    JSON.stringify(
      {
        output: resolve(values.output!),
        id: profile.id,
        regions: profile.regions.length,
        ocr_regions: profile.regions.filter((r) => r.ocr !== false).length,
      },
      null,
      2,
    ),
  );
}
