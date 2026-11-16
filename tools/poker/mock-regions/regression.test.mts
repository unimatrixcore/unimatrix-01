import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { extractRegions } from "./extract.mts";
import { loopbackUrl } from "./geometry.mts";

test("validation refuses normalized and symlinked output escapes before writing", () => {
  const root = mkdtempSync("/tmp/poker-validation-boundary-");
  try {
    const name = root.split("/").at(-1)!;
    const outside = join(homedir(), `${name}-output`);
    symlinkSync(homedir(), join(root, "outside"), "dir");
    for (const output of [`/tmp/../${outside.slice(1)}`, join(root, "outside", `${name}-output`)]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./validate.mts", import.meta.url)), "http://127.0.0.1:1", output],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Validation output must/);
      assert.equal(existsSync(outside), false);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test(
  "excludes overlaid, flipped and vertically clipped labels",
  { skip: !process.env.POKER_MOCK_URL },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(loopbackUrl(process.env.POKER_MOCK_URL!));
      await page.waitForFunction(() => !!window.poker?.ready);
      await page.evaluate(async () => {
        const seats = window.poker.getState().seats.map((s) => ({
          ...s,
          name: "Player",
          cards: ["Ts", "Ah"],
          stack: 1,
          status: "playing",
          bet: 0,
          action: "",
          hand: "",
          combinationNames: null,
          winner: false,
        }));
        window.poker.setState({ seats, active: null });
        await window.poker.ready();
      });
      const initial = await page.evaluate(extractRegions);
      assert.deepEqual(
        initial.regions.filter((r) => r.id.startsWith("table.")).map((r) => r.id),
        ["table.info"],
      );
      assert.equal(
        initial.regions.find((r) => r.id === "table.info")?.label,
        "Tigard #11, NLHE  - 0.01/0.02",
      );
      assert.equal(initial.regions.find((r) => r.id === "table.info")?.visibility, "visible");
      assert.equal(initial.regions.find((r) => r.id === "seat.0.name")?.visibility, "visible");
      await page.evaluate(() => {
        const r = document.querySelector('[data-seat="0"] .player-name')!.getBoundingClientRect();
        const overlay = document.createElement("div");
        overlay.id = "test-overlay";
        overlay.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:black;z-index:2147483647;pointer-events:none`;
        document.body.append(overlay);
      });
      const overlaid = await page.evaluate(extractRegions);
      assert.match(
        overlaid.regions.find((r) => r.id === "seat.0.name")?.reason ?? "",
        /foreground/,
      );
      assert.equal(overlaid.regions.find((r) => r.id === "seat.0.name")?.autoLabelEligible, false);
      assert.equal(overlaid.regions.find((r) => r.id === "seat.0.name")?.cropLabel, null);
      await page.evaluate(() => {
        document.querySelector("#test-overlay")!.remove();
        const parent = document.querySelector('[data-seat="0"] .r-card')!.parentElement!;
        parent.dataset.testOriginalStyle = parent.getAttribute("style") ?? "";
        parent.style.overflow = "hidden";
        parent.style.width = "1px";
        parent.style.height = "1px";
      });
      const clippedCard = await page.evaluate(extractRegions);
      for (const category of ["rank", "suit"]) {
        const region = clippedCard.regions.find((r) => r.id === `seat.0.card.0.${category}`)!;
        assert.equal(region.visibility, "unsupported");
        assert.match(region.reason ?? "", /clipped/);
        assert.equal(region.autoLabelEligible, false);
        assert.equal(region.cropLabel, null);
      }
      await page.evaluate(() => {
        const parent = document.querySelector('[data-seat="0"] .r-card')!.parentElement!;
        parent.setAttribute("style", parent.dataset.testOriginalStyle!);
        delete parent.dataset.testOriginalStyle;
        (document.querySelector('[data-seat="0"] .r-card .face') as HTMLElement).style.transform =
          "rotateY(90deg)";
        const name = document.querySelector('[data-seat="0"] .player-name') as HTMLElement;
        name.style.height = "1px";
        name.style.overflow = "hidden";
      });
      const clipped = await page.evaluate(extractRegions);
      assert.equal(
        clipped.regions.find((r) => r.id === "seat.0.card.0.rank")?.visibility,
        "unsupported",
      );
      assert.match(clipped.regions.find((r) => r.id === "seat.0.name")?.reason ?? "", /clipped/);
      for (const id of ["seat.0.card.0.rank", "seat.0.name"]) {
        assert.equal(clipped.regions.find((r) => r.id === id)?.autoLabelEligible, false);
        assert.equal(clipped.regions.find((r) => r.id === id)?.cropLabel, null);
      }
      await page.evaluate(async () => {
        const name = document.querySelector('[data-seat="0"] .player-name') as HTMLElement;
        name.style.removeProperty("height");
        name.style.removeProperty("overflow");
        window.poker.setState({
          active: 4,
          timer: { remaining: 14, total: 30, running: false, variant: "digital" },
          settings: { chat: { showBubbleMessages: true } },
        });
        await window.poker.ready();
        window.poker.effects.message(4, "Time bank activated");
      });
      await page.waitForSelector('[data-seat="4"] .message-content');
      await page.waitForSelector('[data-seat="4"] .bubble-animation-enter-done');
      const popup = await page.evaluate(extractRegions);
      assert.equal(
        popup.regions.find((r) => r.id === "seat.4.popup")?.label,
        "Time bank activated",
      );
      assert.equal(
        popup.regions.find((r) => r.id === "seat.4.popup")?.visibility,
        "visible",
        JSON.stringify(popup.regions.find((r) => r.id === "seat.4.popup")),
      );
      assert.equal(popup.regions.find((r) => r.id === "seat.4.timer")?.label, "14");
    } finally {
      await browser.close();
    }
  },
);

test(
  "maximum envelopes stay fixed across short and extreme built-in amounts",
  { skip: !process.env.POKER_MOCK_URL },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(loopbackUrl(process.env.POKER_MOCK_URL!));
      await page.waitForFunction(() => !!window.poker?.ready);
      const capture = async (value: number, displayInBB: boolean, grouping: boolean) => {
        await page.evaluate(
          ({ value, displayInBB, grouping }) => {
            const seats = window.poker.getState().seats.map((s) => ({
              ...s,
              name: "Player",
              stack: 100,
              bet: value,
              status: "playing",
              cards: ["As", "Kh"],
              action: "",
              hand: "",
              combinationNames: null,
              winner: false,
            }));
            window.poker.setState({
              seats,
              hero: 4,
              useMySeat: false,
              bank: 0,
              active: null,
              blinds: [1, 3],
              currencyPrecision: 0,
              decimals: 8,
              bbPrecision: 8,
              currency: "$",
              displayInBB,
              grouping,
            });
          },
          { value, displayInBB, grouping },
        );
        await page.evaluate(() => window.poker.ready());
        return page.evaluate(extractRegions);
      };
      const small = await capture(1, true, false);
      await page.evaluate(async () => {
        window.poker.setState({
          seats: window.poker.getState().seats.map((s) => ({ ...s, cards: ["Ts", "Ah"] })),
        });
        await window.poker.ready();
      });
      const differentCards = await page.evaluate(extractRegions);
      for (const a of small.regions.filter((r) => r.category === "rank" || r.category === "suit"))
        assert.deepEqual(differentCards.regions.find((r) => r.id === a.id)?.bounds, a.bounds, a.id);
      const potGuides = [];
      for (const count of [1, 2, 10])
        for (const value of [1, 355.6]) {
          await page.evaluate(
            async ({ count, value }) => {
              window.poker.setState({ pots: Array.from({ length: count }, () => value) });
              await window.poker.ready();
            },
            { count, value },
          );
          const state = await page.evaluate(extractRegions);
          const guide = state.regions.find((region) => region.id === "pot.0")!.guide!;
          potGuides.push(guide);
          assert.equal(guide.family, "split_pot_group");
        }
      for (const guide of potGuides)
        assert.deepEqual(
          guide,
          potGuides[0],
          "pot CSS group guide must not depend on count/reflow/current width",
        );
      const headerGuides = [];
      for (const handId of ["1", "X".repeat(200)]) {
        await page.evaluate(async (handId) => {
          window.poker.setState({ handId });
          await window.poker.ready();
        }, handId);
        headerGuides.push(
          (await page.evaluate(extractRegions)).regions.find((region) => region.id === "game.id")!
            .guide,
        );
      }
      assert.deepEqual(
        headerGuides[0],
        headerGuides[1],
        "game ID guide must follow its fixed CSS slot",
      );
      for (const options of [
        { value: Number.MAX_SAFE_INTEGER, bb: true, group: true },
        { value: Number.MAX_SAFE_INTEGER, bb: false, group: true },
        { value: 3556, bb: false, group: false },
      ]) {
        const large = await capture(options.value, options.bb, options.group);
        for (let seat = 0; seat < 9; seat++) {
          const id = `seat.${seat}.bet`,
            a = small.regions.find((r) => r.id === id)!,
            b = large.regions.find((r) => r.id === id)!;
          assert.deepEqual(b.bounds, a.bounds, id);
          assert.deepEqual(
            b.guide,
            a.guide,
            `${id}: guide follows CSS allocation, not current ink`,
          );
          assert.equal(b.guide?.source, "css_slot");
          assert.ok(b.guide!.slot.width < b.bounds!.width);
          assert.equal(b.guide!.anchor.y, b.guide!.slot.y + b.guide!.slot.height / 2);
          assert.equal(b.envelope?.policy, "safe_funds_formatter");
          assert.ok(b.bounds!.width > 300 && b.bounds!.width < 500, id);
          assert.ok(
            b.inkBounds!.x >= b.bounds!.x - 0.5 &&
              b.inkBounds!.x + b.inkBounds!.width <= b.bounds!.x + b.bounds!.width + 0.5,
            id,
          );
        }
      }
      await page.evaluate(async () => {
        window.poker.setState({
          hero: 4,
          useMySeat: true,
          dealer: 3,
          currency: "SC",
          currencyPrecision: 2,
          decimals: 2,
          bbPrecision: 1,
          displayInBB: true,
          blinds: [0.01, 0.05],
          seats: window.poker.getState().seats.map((s, i) => ({ ...s, bet: i === 4 ? 17.78 : 0 })),
        });
        await window.poker.ready();
      });
      const contaminated = await page.evaluate(extractRegions);
      const bet = contaminated.regions.find((r) => r.id === "seat.4.bet")!;
      assert.ok(bet.cropOverlaps?.includes("dealer"), JSON.stringify(bet.cropOverlaps));
      assert.equal(bet.autoLabelEligible, false);
      assert.equal(bet.cropLabel, null);
    } finally {
      await browser.close();
    }
  },
);

test(
  "split-pot maximum envelopes contain all rendered values across centered wrapping",
  { skip: !process.env.POKER_MOCK_URL },
  async () => {
    const frozen = JSON.parse(
      readFileSync(
        new URL("../../../packages/poker-native/assets/gameplay-regions.json", import.meta.url),
        "utf8",
      ),
    ) as {
      regions: {
        id: string;
        localizer?: { search_bounds: { x: number; y: number; width: number; height: number } };
      }[];
    };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(loopbackUrl(process.env.POKER_MOCK_URL!));
      await page.waitForFunction(() => !!window.poker?.ready);
      for (const count of [1, 2, 10])
        for (const mode of [
          { bb: true, group: true },
          { bb: false, group: true },
          { bb: false, group: false },
        ]) {
          await page.evaluate(
            async ({ count, mode }) => {
              window.poker.replay.pause();
              window.poker.setState({
                currency: "$",
                currencyPrecision: 0,
                decimals: 8,
                bbPrecision: 8,
                displayInBB: mode.bb,
                grouping: mode.group,
                blinds: [1, 3],
                bank: 0,
                pots: Array.from({ length: count }, () => Number.MAX_SAFE_INTEGER),
                seats: window.poker.getState().seats.map((s) => ({ ...s, bet: 0 })),
              });
              await window.poker.ready();
              document.getAnimations().forEach((a) => a.pause());
            },
            { count, mode },
          );
          const result = await page.evaluate(extractRegions);
          const pots = result.regions.filter((r) => r.category === "split_pot" && r.inkBounds);
          assert.equal(pots.length, count, "Maximum-amount case must render every requested pot");
          const panels = await page.evaluate(() =>
            [...document.querySelectorAll("[data-pot-index] .text")].map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            }),
          );
          assert.equal(panels.length, count, "Every requested pot must have a panel");
          const search = frozen.regions.find((r) => r.id === "split_pot")!.localizer!.search_bounds;
          for (const panel of panels)
            assert.ok(
              panel.x >= search.x - 0.5 &&
                panel.y >= search.y - 0.5 &&
                panel.x + panel.width <= search.x + search.width + 0.5 &&
                panel.y + panel.height <= search.y + search.height + 0.5,
              JSON.stringify({ count, mode, search, panel }),
            );
          for (const region of pots) {
            const b = search,
              ink = region.inkBounds!;
            assert.ok(
              ink.x >= b.x - 0.5 &&
                ink.y >= b.y - 0.5 &&
                ink.x + ink.width <= b.x + b.width + 0.5 &&
                ink.y + ink.height <= b.y + b.height + 0.5,
              JSON.stringify({ id: region.id, count, mode, bounds: b, ink }),
            );
          }
        }
    } finally {
      await browser.close();
    }
  },
);

test(
  "award and popup guides use fixed CSS slots and contain source motion extrema",
  { skip: !process.env.POKER_MOCK_URL },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      let reference: unknown;
      for (const amount of [1, Number.MAX_SAFE_INTEGER]) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        await page.addInitScript(() => {
          // Limit concurrent deck fetches: Chromium can exhaust resources when the
          // extractor requests all SVGs at once while these effects are active.
          const fetchAsset = window.fetch.bind(window);
          let pending = Promise.resolve();
          window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (!String(input).endsWith(".svg")) return fetchAsset(input, init);
            const result = pending.then(() => fetchAsset(input, init));
            pending = result.then(
              () => undefined,
              () => undefined,
            );
            return result;
          }) as typeof window.fetch;
          const schedule = window.setTimeout.bind(window);
          window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
            schedule(
              handler,
              delay !== undefined && delay >= 3500 && delay <= 4400 ? 60000 : delay,
              ...args,
            )) as typeof window.setTimeout;
        });
        await page.goto(loopbackUrl(process.env.POKER_MOCK_URL!));
        await page.waitForFunction(() => !!window.poker?.ready);
        await page.evaluate(async (amount) => {
          window.poker.setState({
            currencyPrecision: 0,
            decimals: 8,
            bbPrecision: 8,
            blinds: [1, 1],
            grouping: true,
            displayInBB: true,
            seats: window.poker
              .getState()
              .seats.map((s) => ({ ...s, winner: true, award: amount, action: "" })),
            settings: { chat: { showBubbleMessages: true } },
          });
          for (let i = 0; i < 9; i++)
            window.poker.effects.message(i, amount === 1 ? "OK" : "W".repeat(200));
          await window.poker.ready();
          await document.fonts.ready;
          document.getAnimations().forEach((a) => a.pause());
        }, amount);
        assert.deepEqual(pageErrors, []);
        await page.waitForSelector('[data-seat="8"] .message-content', {
          state: "attached",
          timeout: 2000,
        });
        for (const phase of [
          "bubble-animation-enter",
          "bubble-animation-enter-active",
          "bubble-animation-enter-done",
          "bubble-animation-exit-active",
        ]) {
          for (const progress of [0, 0.5, 1]) {
            await page.evaluate(
              ({ phase, progress }) => {
                document.querySelectorAll<HTMLElement>(".message").forEach((el) => {
                  el.style.transition = "none";
                  el.className = `message ${phase}`;
                });
                document.querySelectorAll(".r-seat__won_message").forEach((el) =>
                  el.getAnimations().forEach((a) => {
                    a.pause();
                    a.currentTime = Number(a.effect!.getTiming().duration) * progress;
                  }),
                );
              },
              { phase, progress },
            );
            const regions = (await page.evaluate(extractRegions)).regions.filter((r) =>
              ["award", "popup"].includes(r.category),
            );
            assert.equal(regions.length, 18);
            const guides = regions.map((r) => ({ id: r.id, guide: r.guide }));
            if (reference === undefined) reference = guides;
            else assert.deepEqual(guides, reference, `${amount}/${phase}/${progress}`);
            const rendered = await page.evaluate(() =>
              [
                ...document.querySelectorAll(".PlayerWonContainer__funds__text,.message-content"),
              ].map((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                const r = el.matches(".message-content")
                  ? el.getBoundingClientRect()
                  : range.getBoundingClientRect();
                return {
                  id: `seat.${el.closest("[data-seat]")!.getAttribute("data-seat")}.${el.matches(".message-content") ? "popup" : "award"}`,
                  x: r.x,
                  y: r.y,
                  right: r.right,
                  bottom: r.bottom,
                };
              }),
            );
            for (const ink of rendered) {
              const b = regions.find((r) => r.id === ink.id)!.bounds!;
              assert.ok(
                ink.x >= b.x - 1 &&
                  ink.right <= b.x + b.width + 1 &&
                  ink.y >= b.y - 1 &&
                  ink.bottom <= b.y + b.height + 1,
                JSON.stringify({ amount, phase, progress, ink, b }),
              );
            }
          }
        }
        for (const mode of ["missing", "nonlinear"] as const) {
          await page.evaluate((mode) => {
            document.querySelectorAll(".r-seat__won_message").forEach((el) => {
              const animation = new Animation(
                new KeyframeEffect(el, [{ transform: "scale(2)" }, { transform: "scale(3)" }], {
                  duration: 100,
                }),
              );
              Object.defineProperty(el, "getAnimations", {
                configurable: true,
                value: () => (mode === "missing" ? [] : [animation]),
              });
            });
          }, mode);
          const awards = (await page.evaluate(extractRegions)).regions.filter(
            (r) => r.category === "award",
          );
          assert.equal(awards.length, 9);
          for (const region of awards) {
            assert.equal(region.visibility, "unsupported", `${mode}: ${region.id}`);
            assert.equal(region.bounds, null);
            assert.equal(region.autoLabelEligible, false);
            assert.equal(region.cropLabel, null);
          }
        }
      }
    } finally {
      await browser.close();
    }
  },
);
