import { chromium } from "@playwright/test";
import { z } from "zod";
import { mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRegions } from "./extract.mts";
import { loopbackUrl } from "./geometry.mts";

const options = z.object({
  url: z.string().transform(loopbackUrl),
  output: z.string().min(1),
  width: z.coerce.number().int().min(640).max(7680).default(1280),
  height: z.coerce.number().int().min(480).max(4320).default(800),
  state: z.string().optional(),
});

export async function capture(input: z.input<typeof options>) {
  const config = options.parse(input);
  const root = await realpath(resolve(fileURLToPath(new URL("../../..", import.meta.url))));
  const output = resolve(config.output);
  const relation = relative(root, output);
  if (
    relation === "" ||
    (!(relation === ".." || relation.startsWith("../")) &&
      !resolve(output).startsWith(resolve(root, ".notes") + "/"))
  ) {
    throw new Error(
      "Write private screenshots/crops outside the repository or under ignored .notes",
    );
  }
  await mkdir(output, { recursive: false });
  const actualOutput = await realpath(output);
  const actualRelation = relative(root, actualOutput);
  if (
    actualRelation === "" ||
    (!(actualRelation === ".." || actualRelation.startsWith("../")) &&
      !actualOutput.startsWith(resolve(root, ".notes") + "/"))
  ) {
    await rm(output, { recursive: true });
    throw new Error("Output resolves into the repository through a symlink");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol) || url.origin === new URL(config.url).origin)
        await route.continue();
      else await route.abort();
    });
    await page.goto(config.url);
    await page.waitForFunction(() => typeof window.poker?.ready === "function");
    if (config.state) {
      const patch: unknown = JSON.parse(await readFile(config.state, "utf8"));
      await page.evaluate((value) => window.poker.setState(value), patch);
    }
    await page.evaluate(async () => {
      window.poker.replay.pause();
      const state = window.poker.getState();
      if (state.timer) window.poker.setState({ timer: { ...state.timer, running: false } });
      await window.poker.ready();
      document.getAnimations().forEach((animation) => animation.pause());
    });
    const result = await page.evaluate(extractRegions);
    const png = await page.screenshot();
    await writeFile(resolve(output, "frame.png"), png);
    const renderer = await browser.newPage();
    const image = `data:image/png;base64,${png.toString("base64")}`;
    const crops: Record<string, string> = {};
    const previewCrops: Record<string, string> = {};
    for (const region of result.regions) {
      if (region.visibility !== "visible" || !region.polygon) continue;
      const encoded = await renderer.evaluate(
        async ({ polygon, image }) => {
          const img = new Image();
          img.src = image;
          await img.decode();
          const [a, b, , d] = polygon;
          const width = Math.hypot(b.x - a.x, b.y - a.y),
            height = Math.hypot(d.x - a.x, d.y - a.y);
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(width);
          canvas.height = Math.ceil(height);
          const ctx = canvas.getContext("2d")!;
          const ux = (b.x - a.x) / width,
            uy = (b.y - a.y) / width,
            vx = (d.x - a.x) / height,
            vy = (d.y - a.y) / height;
          const det = ux * vy - uy * vx;
          ctx.setTransform(
            vy / det,
            -uy / det,
            -vx / det,
            ux / det,
            (-vy * a.x + vx * a.y) / det,
            (uy * a.x - ux * a.y) / det,
          );
          ctx.drawImage(img, 0, 0);
          return canvas.toDataURL("image/png").split(",")[1];
        },
        { polygon: region.polygon, image },
      );
      const filename = `${region.id}.png`;
      await writeFile(resolve(output, filename), Buffer.from(encoded, "base64"));
      previewCrops[region.id] = filename;
      if (region.autoLabelEligible) crops[region.id] = filename;
    }
    const manifest = {
      schemaVersion: 2,
      source: "private_local_mock",
      labelEvidence: "controlled_render_state",
      visuallyVerified: false,
      visibilityMethod: "computed_style_ancestor_clipping_and_foreground_intersections",
      occlusionChecked: true,
      limitations: [
        "NLHE is the only variant rendered by this mock; other poker variants are not verified",
        "Arbitrary overlays and transient animation occlusion require scenario-specific checks",
        "Canvas card squeeze has no ordinary card-face DOM; no rank/suit labels are inferred",
      ],
      ...result,
      crops,
      previewCrops,
    };
    await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return {
      output,
      visible: result.regions.filter((r) => r.visibility === "visible").length,
      autoLabeledCrops: Object.keys(crops).length,
      unsupported: result.regions
        .filter((r) => r.visibility === "unsupported")
        .map((r) => ({ id: r.id, reason: r.reason })),
      absent: result.regions.filter((r) => r.visibility === "absent").length,
    };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    if (!["url", "output", "width", "height", "state"].includes(key) || !process.argv[i + 1])
      throw new Error(
        "Usage: node tools/poker/mock-regions/capture.mts --url http://127.0.0.1:5173 --output /tmp/private-capture [--width 1280 --height 800 --state /tmp/state.json]",
      );
    values[key] = process.argv[i + 1];
  }
  console.log(JSON.stringify(await capture(values as z.input<typeof options>), null, 2));
}
