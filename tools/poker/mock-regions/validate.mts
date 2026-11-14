import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { extractRegions } from "./extract.mts";
import { loopbackUrl } from "./geometry.mts";

const url = loopbackUrl(process.argv[2] ?? "http://127.0.0.1:5173");
const output = process.argv[3];
if (!output?.startsWith("/tmp/"))
  throw new Error("Validation output must be a fresh /tmp directory");
await mkdir(output, { recursive: false });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(url).origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(url);
  await page.waitForFunction(() => !!window.poker?.ready);
  const cards = [..."23456789TJQKA"].flatMap((rank) => [..."shdc"].map((suit) => rank + suit));
  const summaries = [];
  const positions = new Map<number, Set<string>>();
  const labels = new Map<string, Set<string>>();
  let frame = 0;
  for (const deck of ["default", "four-colors"]) {
    for (let offset = 0; offset < 52; offset++) {
      const viewport = [
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
        { width: 1024, height: 768 },
      ][frame % 3];
      await page.setViewportSize(viewport);
      await page.evaluate(
        ({ deck, hand, offset }) => {
          const seats = Array.from({ length: 9 }, (_, i) => ({
            ...window.poker.getState().seats[i],
            name: `Player${i}`,
            stack: 17.78,
            bet: 0,
            status: "playing",
            cards: hand,
            action: "Raise",
            hand: "",
            combinationNames: null,
            winner: false,
          }));
          window.poker.setState({
            hero: offset % 9,
            useMySeat: true,
            seats,
            board: [...hand, ...hand, hand[0]],
            theme: { cards: deck },
            blinds: [0.01, 0.05],
            displayInBB: true,
            bbPrecision: 1,
            timer: { remaining: 14, total: 30, running: false, variant: "digital" },
            active: 4,
            dealer: 3,
          });
        },
        { deck, hand: [cards[offset], cards[(offset + 1) % 52]], offset },
      );
      await page.evaluate(async () => {
        await window.poker.ready();
        document.getAnimations().forEach((a) => a.pause());
      });
      const result = await page.evaluate(extractRegions);
      if (frame === 0) {
        await page.screenshot({ path: `${output}/first.png` });
        await writeFile(`${output}/first.json`, JSON.stringify(result, null, 2));
      }
      const cardRegions = result.regions.filter(
        (r) => r.category === "rank" || r.category === "suit",
      );
      assert.equal(cardRegions.length, 46);
      assert.deepEqual(
        cardRegions
          .filter((r) => r.visibility !== "visible")
          .map((r) => ({ id: r.id, reason: r.reason })),
        [],
      );
      for (const r of result.regions.filter((r) => r.seat !== null && r.template)) {
        const set = positions.get(r.seat!) ?? new Set<string>();
        set.add(r.template!);
        positions.set(r.seat!, set);
      }
      for (const r of cardRegions) {
        const set = labels.get(`${deck}:${r.id}`) ?? new Set<string>();
        set.add(r.label!);
        labels.set(`${deck}:${r.id}`, set);
      }
      for (const id of ["game.id", "pot.total", "seat.4.timer", "dealer"])
        assert.equal(result.regions.find((r) => r.id === id)?.visibility, "visible", id);
      if (frame < 3) await page.screenshot({ path: `${output}/frame-${frame}.png` });
      summaries.push({
        deck,
        offset,
        viewport,
        visible: result.regions.filter((r) => r.visibility === "visible").length,
      });
      frame++;
      if (frame % 20 === 0) console.log(`Validated ${frame} card states`);
    }
  }
  for (const templates of positions.values()) assert.equal(templates.size, 9);
  for (const [id, values] of labels) assert.equal(values.size, id.endsWith("rank") ? 13 : 4, id);
  for (let seat = 0; seat < 9; seat++) {
    await page.evaluate((seat) => {
      window.poker.setState({
        seats: window.poker.getState().seats.map((s, i) => ({ ...s, bet: i === seat ? 17.78 : 0 })),
      });
    }, seat);
    await page.evaluate(() => window.poker.ready());
    const result = await page.evaluate(extractRegions);
    const bet = result.regions.find((r) => r.id === `seat.${seat}.bet`)!;
    assert.equal(bet.label, "355.6 BB");
    assert.equal(bet.visibility, "visible", `${bet.id}: ${bet.reason}`);
  }
  await page.evaluate(() =>
    window.poker.setState({
      seats: Array.from({ length: 9 }, (_, i) => ({
        ...window.poker.getState().seats[i],
        name: `Player${i}`,
        stack: 1,
        bet: 0,
        status: "folded",
        cards: ["Ts", "Ah"],
        action: "",
        hand: "",
        winner: false,
      })),
      active: null,
    }),
  );
  await page.evaluate(() => window.poker.ready());
  const folded = await page.evaluate(extractRegions);
  const table = folded.regions.find((r) => r.id === "table.info")!;
  assert.equal(table.visibility, "visible", table.reason ?? "");
  assert.equal(table.label, "Tigard #11, NLHE  - 0.01/0.05");
  assert.deepEqual(
    folded.regions.filter((r) => r.id.startsWith("table.")).map((r) => r.id),
    ["table.info"],
  );
  assert.equal(
    folded.regions.filter(
      (r) => r.seat !== null && ["rank", "suit"].includes(r.category) && r.visibility === "visible",
    ).length,
    36,
  );
  await writeFile(
    `${output}/summary.json`,
    JSON.stringify(
      {
        frames: frame,
        templates: Object.fromEntries([...positions].map(([k, v]) => [k, [...v]])),
        cardRegionCoverage: Object.fromEntries([...labels].map(([k, v]) => [k, [...v]])),
        foldedCardGlyphs: 36,
        summaries,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        frames: frame,
        logicalSeats: positions.size,
        templatesPerSeat: 9,
        decks: 2,
        viewportSizes: 3,
        cardValues: 52,
        foldedCardGlyphs: 36,
        output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
