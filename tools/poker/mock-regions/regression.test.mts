import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
