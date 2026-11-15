import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { format, resolveConfig } from "prettier";
import { extractRegions } from "./extract.mts";
import { loopbackUrl } from "./geometry.mts";

export const tightOptions = z.object({
  url: z.string().transform(loopbackUrl),
  output: z.string().min(1),
});

export async function generateTightProfile(input: z.input<typeof tightOptions>) {
  const options = tightOptions.parse(input);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    await page.goto(options.url);
    await page.waitForFunction(() => typeof window.poker?.ready === "function");
    await page.evaluate(async () => {
      window.poker.replay.pause();
      const state = window.poker.getState();
      window.poker.setState({
        blinds: [0.5, 1],
        bank: 355.6,
        pots: [355.6],
        handId: "89612405",
        board: ["As", "Td", "4c", "8h", "Ks"],
        seats: state.seats.map((seat, i) => ({
          ...seat,
          name: `Player${i}`,
          stack: 355.6,
          bet: 355.6,
          cards: ["As", "Td"],
          status: "playing",
          action: "",
        })),
      });
      await window.poker.ready();
      document.getAnimations().forEach((a) => a.pause());
    });
    const extracted = (await page.evaluate(extractRegions)).regions;
    const cards = extracted.filter((r) => r.category === "rank" || r.category === "suit");
    const regions = await page.evaluate((sourceRegions) => {
      type B = { x: number; y: number; width: number; height: number };
      const results: Record<string, unknown>[] = [];
      const sourceBounds = (id: string): B => {
        const bounds = sourceRegions.find((region) => region.id === id)?.bounds;
        if (!bounds) throw Error(`Missing source allocation ${id}`);
        return bounds;
      };
      const clip = (b: B): B => {
        const x = Math.max(0, b.x),
          y = Math.max(0, b.y);
        return {
          x,
          y,
          width: Math.min(innerWidth, b.x + b.width) - x,
          height: Math.min(innerHeight, b.y + b.height) - y,
        };
      };
      const searchArea = (b: B): B =>
        clip({
          x: Math.floor(b.x) - 1,
          y: Math.floor(b.y) - 1,
          width: Math.ceil(b.x + b.width) - Math.floor(b.x) + 2,
          height: Math.ceil(b.y + b.height) - Math.floor(b.y) + 2,
        });
      const box = (el: Element): B => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const add = (
        id: string,
        category: string,
        el: Element | null,
        source: string,
        localizer?: Record<string, unknown>,
      ) => {
        if (!el) throw Error(`Missing source field ${id}`);
        const b = box(el);
        const parent = ["name", "bank", "cv_nameplate"].includes(category)
          ? el.closest(".r-player-bar")
          : null;
        const maskSource = parent
          ? "sp_default_nameplate"
          : category === "pot"
            ? "upper_pot"
            : ["bet", "split_pot"].includes(category)
              ? "chip_columns_value"
              : null;
        if (b.width <= 0 || b.height <= 0) throw Error(`Empty source field ${id}`);
        results.push({
          id,
          category,
          bounds: b,
          polygon: [
            { x: b.x, y: b.y },
            { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
            { x: b.x, y: b.y + b.height },
          ],
          rotation: 0,
          ocr: true,
          source_content: "text",
          source_region_id: source,
          ...(maskSource ? { crop_mask_source: maskSource } : {}),
          ...(parent ? { crop_mask_parent_bounds: box(parent) } : {}),
          localizer,
          guide: {
            slot: b,
            anchor: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
            alignment: "center",
            family: category,
            source: "css_slot",
          },
          envelope: {
            policy: localizer ? "pixel_resolved_single_panel" : "fixed_css_text_row",
            limit: "1920x1080 source field; search areas are never OCR crops",
            clippedToViewport: false,
          },
        });
      };
      for (let old = 0; old < 9; old++) {
        const seat = (old + 3) % 9,
          base = `[data-seat="${seat}"]`;
        add(
          `seats[${old}].name`,
          "name",
          document.querySelector(`${base} .player-name`),
          `seat.${seat}.name`,
        );
        add(
          `seats[${old}].nameplate`,
          "cv_nameplate",
          document.querySelector(`${base} .r-player-bar`),
          `seat.${seat}.nameplate`,
        );
        results[results.length - 1]!.ocr = false;
        results[results.length - 1]!.overlay = false;
        const cash = document.querySelector(`${base} .player-cash span`);
        add(`seats[${old}].bank`, "bank", cash?.closest(".bar-text") ?? cash, `seat.${seat}.bank`);
        const bank = results[results.length - 1]!;
        const bb = bank.bounds as B;
        bb.x -= 2;
        bb.y -= 2;
        bb.width += 4;
        bb.height += 4;
        bank.polygon = [
          { x: bb.x, y: bb.y },
          { x: bb.x + bb.width, y: bb.y },
          { x: bb.x + bb.width, y: bb.y + bb.height },
          { x: bb.x, y: bb.y + bb.height },
        ];
        const value = document.querySelector(`[data-bet-seat="${seat}"] .value`);
        const slot = value?.closest(".text");
        if (!value || !slot) throw Error("Missing bet CSS slot");
        const r = box(slot),
          justify = getComputedStyle(slot).justifyContent;
        const alignment =
          justify === "flex-start" ? "left" : justify === "flex-end" ? "right" : "center";
        const ax =
          alignment === "left" ? r.x : alignment === "right" ? r.x + r.width : r.x + r.width / 2;
        const allocation = sourceBounds(`seat.${seat}.bet`);
        const search = searchArea({ ...allocation, y: r.y + r.height / 2 - 46 / 2, height: 46 });
        add(`seats[${old}].bet`, "bet", value, `seat.${seat}.bet`, {
          kind: "panel",
          require_currency_badge: true,
          empty_slot_fallback: true,
          search_bounds: search,
          anchor: { x: ax, y: r.y + r.height / 2 },
          alignment,
          min_height: 20,
          max_height: 46,
          anchor_tolerance: 9,
        });
      }
      const potAllocation = sourceBounds("pot.total");
      const potContainer = document.querySelector(".bank-container");
      const title = potContainer?.querySelector(".title");
      if (!potContainer || !title) throw Error("Missing pot CSS allocation");
      const potBox = box(potContainer),
        titleBox = box(title);
      const potLeft = Math.min(potAllocation.x - titleBox.width, titleBox.x);
      const potRight = Math.max(potAllocation.x + potAllocation.width, titleBox.x + titleBox.width);
      const potsContainer = document.querySelector(".ReactPokerPotsContainer");
      if (!potsContainer) throw Error("Missing split-pot CSS container");
      const potsBox = box(potsContainer);
      const splitValue = document.querySelector('[data-pot-index="0"] .value');
      const splitChip = splitValue?.closest(".ReactPokerPotsContainer__chip");
      if (!splitValue || !splitChip) throw Error("Missing split-pot CSS field");
      const splitBox = box(splitValue),
        chipBox = box(splitChip),
        chipCss = getComputedStyle(splitChip);
      const chips = splitValue.closest(".ReactPokerPotsContainer__chips");
      const containingBlock = potsContainer.parentElement;
      if (!chips || !containingBlock) throw Error("Missing split-pot wrapping container");
      const rowWidth = Math.min(
        parseFloat(getComputedStyle(chips).maxWidth),
        box(containingBlock).width - parseFloat(getComputedStyle(potsContainer).left),
      );
      add("pot", "pot", document.querySelector(".bank-container-content"), "pot.total", {
        kind: "panel",
        allow_pause_text: true,
        max_currency_badges: 1,
        search_bounds: searchArea({
          x: potLeft,
          y: potBox.y + potBox.height / 2 - 46 / 2,
          width: potRight - potLeft,
          height: 46,
        }),
        anchor: { x: potBox.x + potBox.width / 2, y: potBox.y + potBox.height / 2 },
        alignment: "center",
        min_height: 20,
        max_height: 46,
        anchor_tolerance: 12,
      });
      add(
        "split_pot",
        "split_pot",
        document.querySelector('[data-pot-index="0"] .value'),
        "pot.visible",
        {
          kind: "pot_row",
          require_currency_badge: true,
          empty_slot_fallback: true,
          search_bounds: searchArea(sourceBounds("pot.0")),
          min_height: 20,
          max_height:
            Math.ceil(box(document.querySelector('[data-pot-index="0"] .value')!).height) + 1,
          max_panels: 10,
          row_center_x: potsBox.x + potsBox.width / 2,
          row_center_y: splitBox.y + splitBox.height / 2,
          row_pitch:
            chipBox.height + parseFloat(chipCss.marginTop) + parseFloat(chipCss.marginBottom),
          row_width: rowWidth,
          chip_gap: parseFloat(chipCss.marginLeft) + parseFloat(chipCss.marginRight),
          panel_height: splitBox.height,
          row_center_tolerance: 12,
          exclude_region_categories: ["bet"],
        },
      );
      const gameId = document.querySelector(".game-id");
      add("round_id", "round_id", gameId, "game.id");
      if (gameId) {
        const css = getComputedStyle(gameId);
        const radius = (value: string) => {
          const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0];
          return { x: parts[0]!, y: parts[1] ?? parts[0]! };
        };
        const game = results[results.length - 1]!;
        game.crop_mask_source = "game_id_tab";
        game.crop_mask_corners = [
          radius(css.borderTopLeftRadius),
          radius(css.borderTopRightRadius),
          radius(css.borderBottomRightRadius),
          radius(css.borderBottomLeftRadius),
        ];
      }
      const table = document.querySelector(".table-name");
      if (!table) throw Error("Missing table line");
      const line = box(table);
      add("table.info", "table_info", table, "table.info", {
        kind: "text_line",
        search_bounds: { x: line.x, y: line.y - 3, width: line.width, height: line.height + 6 },
        min_height: 8,
        max_height: 35,
      });
      return results;
    }, extracted);
    for (let old = 0; old < 9; old++) {
      const seat = (old + 3) % 9;
      await page.evaluate(async (seat) => {
        const state = window.poker.getState();
        window.poker.setState({
          dealer: seat,
          seats: state.seats.map((s) => ({ ...s, status: "sitout", action: "" })),
        });
        await window.poker.ready();
        document.getAnimations().forEach((a) => a.pause());
      }, seat);
      const fields = await page.evaluate(
        ({ old, seat }) => {
          return [
            [
              `seats[${old}].status`,
              "status",
              document.querySelector(`[data-seat="${seat}"] .r-player-state`),
            ],
            [`seats[${old}].dealer`, "dealer", document.querySelector(".dealer-button")],
          ].map(([id, category, element]) => {
            const el = element as Element | null;
            if (!el) throw Error(`Missing ${id}`);
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) throw Error(`Empty ${id}`);
            const b = { x: r.x, y: r.y, width: r.width, height: r.height };
            return {
              id,
              category,
              bounds: b,
              polygon: [
                { x: r.x, y: r.y },
                { x: r.right, y: r.y },
                { x: r.right, y: r.bottom },
                { x: r.x, y: r.bottom },
              ],
              rotation: 0,
              ocr: true,
              source_region_id: `seat.${seat}.${category}`,
              guide: {
                slot: b,
                anchor: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
                alignment: "center",
                family: category,
                source: "css_slot",
              },
            };
          });
        },
        { old, seat },
      );
      regions.push(...fields);
    }
    const statusCatalog = z
      .object({
        categories: z.object({ status: z.object({ values: z.array(z.string()).min(1) }) }),
      })
      .parse(
        JSON.parse(
          await readFile(
            new URL("../../../packages/poker/ocr-contract.json", import.meta.url),
            "utf8",
          ),
        ),
      ).categories.status.values;
    const measuredStyles = new Map<
      string,
      {
        bounds: { x: number; y: number; width: number; height: number };
        styles: Record<string, unknown>[];
      }
    >();
    for (const label of statusCatalog) {
      await page.evaluate(async (label) => {
        window.poker.replay.pause();
        window.poker.setState({
          active: null,
          seats: window.poker.getState().seats.map((s) => ({
            ...s,
            status: label === "Away" ? "away" : label === "Sit out" ? "sitout" : "playing",
            disconnected: label === "Disconnected",
            action: ["Away", "Sit out", "Disconnected"].includes(label) ? "" : label,
            stack: 100,
            bet: 0,
            winner: false,
          })),
        });
        await window.poker.ready();
        document.getAnimations().forEach((a) => a.pause());
      }, label);
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll("[data-seat]")].flatMap((seat) => {
          const el = seat.querySelector(".player-action .text,.r-player-state .text");
          if (!el) return [];
          const b = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          const rgb = s.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
          return [
            {
              id: `seats[${(Number(seat.getAttribute("data-seat")) + 6) % 9}].status`,
              bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
              background_rgb: rgb.slice(0, 3),
              background_alpha: rgb[3] ?? 1,
              radius: parseFloat(s.borderTopLeftRadius),
              foreground: s.color
                .match(/[\d.]+/g)
                ?.map(Number)
                .slice(0, 3)
                .every((v) => v >= 140)
                ? "light"
                : "dark",
            },
          ];
        }),
      );
      for (const field of fields) {
        let entry = measuredStyles.get(field.id);
        if (!entry) {
          entry = { bounds: { ...field.bounds }, styles: [] };
          measuredStyles.set(field.id, entry);
        } else {
          const b = entry.bounds,
            r = field.bounds;
          const right = Math.max(b.x + b.width, r.x + r.width),
            bottom = Math.max(b.y + b.height, r.y + r.height);
          b.x = Math.min(b.x, r.x);
          b.y = Math.min(b.y, r.y);
          b.width = right - b.x;
          b.height = bottom - b.y;
        }
        const anchor = {
          x: field.bounds.x + field.bounds.width / 2,
          y: field.bounds.y + field.bounds.height,
        };
        const key = JSON.stringify([
          field.background_rgb,
          field.background_alpha,
          field.foreground,
          anchor,
        ]);
        const old = entry.styles.find((s) => s.key === key);
        if (old) {
          old.min_height = Math.min(Number(old.min_height), Math.floor(field.bounds.height) - 6);
          old.max_height = Math.max(Number(old.max_height), Math.ceil(field.bounds.height) + 6);
          old.max_width = Math.max(Number(old.max_width), Math.ceil(field.bounds.width) + 8);
        } else
          entry.styles.push({
            key,
            background_rgb: field.background_rgb,
            background_alpha: field.background_alpha,
            foreground: field.foreground,
            radius: field.radius,
            anchor,
            min_height: Math.floor(field.bounds.height) - 6,
            max_height: Math.ceil(field.bounds.height) + 6,
            max_width: Math.ceil(field.bounds.width) + 8,
            nominal_bounds: field.bounds,
          });
      }
    }
    for (const field of regions.filter((r) => r.category === "status")) {
      const entry = measuredStyles.get(String(field.id));
      if (!entry) throw Error(`Missing source status styles ${field.id}`);
      const b = entry.bounds;
      field.localizer = {
        kind: "status_panel",
        search_bounds: {
          x: Math.max(0, b.x - 8),
          y: Math.max(0, b.y - 8),
          width: b.width + 16,
          height: b.height + 16,
        },
        styles: entry.styles.map(({ key, ...style }) => style),
      };
      field.crop_mask_source = "status_announcement";
    }
    const card_priors: Record<string, NonNullable<(typeof cards)[number]["cardPrior"]>> = {};
    for (const region of cards) {
      const board = /^board\.(\d)\.(rank|suit)$/.exec(region.id);
      const seat = /^seat\.(\d)\.card\.([01])\.(rank|suit)$/.exec(region.id);
      const id = board
        ? `community_cards[${board[1]}]${board[2] === "suit" ? ".suit" : ""}`
        : seat
          ? `seats[${(Number(seat[1]) + 6) % 9}].cards[${seat[2]}]${seat[3] === "suit" ? ".suit" : ""}`
          : null;
      if (!id || !region.bounds || !region.polygon) continue;
      const card_prior_id = id.replace(/\.suit$/, "");
      if (region.cardPrior) card_priors[card_prior_id] = region.cardPrior;
      regions.push({
        id,
        category: region.category === "rank" ? "card" : "suit",
        bounds: region.bounds,
        polygon: region.polygon,
        rotation: region.rotation,
        ocr: true,
        source_region_id: region.id,
        cv_bounds: region.cvBounds,
        card_prior_id,
        card_field: region.category === "rank" ? "rank" : "suit",
        guide: region.guide,
        envelope: region.envelope,
      });
    }
    regions.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (
      regions.length !== 104 ||
      regions.filter((r) => r.ocr !== false).length !== 95 ||
      new Set(regions.map((r) => r.id)).size !== 104
    )
      throw Error(`Expected104definitions/95OCR, got${regions.length}`);
    const cv_regions: Record<string, unknown> = {
      screen_width: 1920,
      screen_height: 1080,
      seats: Array.from({ length: 9 }, () => ({})),
    };
    for (const region of regions) {
      const id = String(region.id);
      if (id.endsWith(".suit") || id === "table.info") continue;
      const b = (region.cv_bounds ?? region.bounds) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const rect = {
        x: Math.floor(b.x),
        y: Math.floor(b.y),
        w: Math.ceil(b.x + b.width) - Math.floor(b.x),
        h: Math.ceil(b.y + b.height) - Math.floor(b.y),
      };
      const tokens = [...id.matchAll(/([a-z_]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]));
      let object: Record<string | number, unknown> = cv_regions;
      for (let i = 0; i < tokens.length - 1; i++) {
        const key = tokens[i]!;
        object[key] ??= typeof tokens[i + 1] === "number" ? [] : {};
        object = object[key] as Record<string | number, unknown>;
      }
      object[tokens[tokens.length - 1]!] = rect;
    }
    const body = {
      style_profile: {
        viewport: "fullscreen1920x1080",
        panel_badges: ["SC", "GC"],
        unsupported_panel_formats: ["USD_without_badge", "custom_currency_templates"],
      },
      schema_version: 2,
      source: "mock_dom_css_and_full_deck_envelopes",
      viewport: { width: 1920, height: 1080 },
      localizer_policy: "baseline_field_panels_v3",
      presence_policy: "source_pixel_presence_autocrop_only_v3",
      card_presence_policy: "ocr_driven_v1",
      card_glyph_policy: "source_seeded_card_components_v1",
      legacy_seat_offset: 0,
      source_seat_offset: 3,
      card_priors,
      cv_regions,
      regions,
      unsupported: [],
    };
    const profile = {
      id: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      ...body,
    };
    await writeFile(
      resolve(options.output),
      await format(JSON.stringify(profile, null, 2), {
        ...(await resolveConfig(resolve(import.meta.dirname, "../../../package.json"))),
        parser: "json",
      }),
    );
    return profile;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const values = Object.fromEntries(
    process.argv.slice(2).reduce<[string, string][]>((entries, value, index, args) => {
      if (index % 2 === 0) entries.push([value.replace(/^--/, ""), args[index + 1]!]);
      return entries;
    }, []),
  );
  const profile = await generateTightProfile(tightOptions.parse(values));
  console.log(
    JSON.stringify({ id: profile.id, regions: profile.regions.length, output: values.output }),
  );
}
