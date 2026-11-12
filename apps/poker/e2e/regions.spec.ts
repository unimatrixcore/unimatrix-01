import { expect, test } from "@playwright/test";
import type { PokerRegionEditorSave } from "@unimatrix/shared";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let regions: Record<string, { x: number; y: number; w: number; h: number }> = {};
    Object.assign(window, { editorSaves: [] });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      await Promise.resolve();
      if (request.method === "POST") {
        const config = request.body as { regions: typeof regions };
        regions = config.regions;
        (window as unknown as { editorSaves: unknown[] }).editorSaves.push(config);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { saved: true, exportPath: "/fixture/regions.json" },
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { regions, screenWidth: 1920, screenHeight: 1080 },
      };
    };
  });
});

test("standalone editor draws scaled coordinates, autosaves, clears and exports without changing Lab navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/regions.html");
  await expect(page.locator(".ri")).toHaveCount(80);
  await expect(page.locator("#cur")).toHaveText("Drawing: Community Card 2");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#183321";
    context.fillRect(0, 0, 1920, 1080);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.locator("#media-picker").setInputFiles([
    { name: "z-table.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") },
    { name: "a-table.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") },
  ]);
  await expect(page.locator("#ml")).toHaveText("a-table.png (1/2)");
  await page.locator("#np").click();
  await expect(page.locator("#ml")).toHaveText("z-table.png (2/2)");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#ml")).toHaveText("a-table.png (1/2)");
  await expect(page.locator("#bgimg")).toBeVisible();
  await expect
    .poll(() =>
      page.locator("#bgimg").evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(1920);
  const bounds = await page.locator("#hit").boundingBox();
  if (!bounds) throw new Error("No drawing surface");
  const scale = Math.min(bounds.width / 1920, bounds.height / 1080),
    ox = Math.round((bounds.width - 1920 * scale) / 2),
    oy = Math.round((bounds.height - 1080 * scale) / 2);
  await page.mouse.move(bounds.x + ox + 100 * scale, bounds.y + oy + 100 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + ox + 400 * scale, bounds.y + oy + 300 * scale, { steps: 5 });
  await page.mouse.up();
  const saves = () =>
    page.evaluate(
      () => (window as unknown as { editorSaves: PokerRegionEditorSave[] }).editorSaves,
    );
  await expect.poll(async () => (await saves()).length).toBe(1);
  expect((await saves())[0]).toMatchObject({
    regions: { "community.card_2": { x: 100, y: 100, w: 300, h: 200 } },
    screenWidth: 1920,
    screenHeight: 1080,
  });
  await expect(page.locator("#cur")).toHaveText("Drawing: Community Card 3");
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#hit")).toHaveAttribute("data-zoom", "1.1");
  const beforePan = await page.locator("#bgimg").evaluate((image) => image.style.transform);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(bounds.x + 500, bounds.y + 400, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect
    .poll(() => page.locator("#bgimg").evaluate((image) => image.style.transform))
    .not.toBe(beforePan);
  expect((await saves()).length).toBe(1);
  await page.getByRole("button", { name: /Community Card 2/ }).click();
  await page.keyboard.press("Delete");
  await expect.poll(async () => Object.keys((await saves()).at(-1)?.regions ?? {}).length).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#be").click();
  await expect.poll(async () => (await saves()).at(-1)?.export).toBe(true);
  await expect(page.locator("#status")).toHaveText("Exported!");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("region-editor.png"), fullPage: true });
  await page.setViewportSize({ width: 700, height: 650 });
  await expect(page.locator("#be")).toBeVisible();
  expect(errors).toEqual([]);
});

test("video playback, frame stepping and seek retain standalone export resolution", async ({
  page,
}) => {
  await page.goto("/regions.html");
  const clip = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    const recording = new Promise<string>((resolve) => {
      recorder.onstop = () => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve((typeof reader.result === "string" ? reader.result : "").split(",")[1]!);
        };
        reader.readAsDataURL(new Blob(parts, { type: "video/webm" }));
      };
    });
    recorder.start();
    for (let index = 0; index < 35; index++) {
      const context = canvas.getContext("2d")!;
      context.fillStyle = index % 2 ? "#123456" : "#456123";
      context.fillRect(0, 0, 320, 180);
      await new Promise((resolve) => setTimeout(resolve, 34));
    }
    recorder.stop();
    stream.getTracks().forEach((track) => {
      track.stop();
    });
    return recording;
  });
  await page.locator("#media-picker").setInputFiles({
    name: "table.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(clip, "base64"),
  });
  await expect(page.locator("#hit")).toHaveAttribute("data-natural-width", "320");
  await page.locator("#hit").click();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.locator("#bgvid").evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBeCloseTo(1 / 30, 4);
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => page.locator("#bgvid").evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBe(0);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause video" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play video" })).toBeVisible();
  await page.locator("#vseek").fill("1");
  await expect
    .poll(() => page.locator("#bgvid").evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#be").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { editorSaves: PokerRegionEditorSave[] }).editorSaves.at(-1),
      ),
    )
    .toMatchObject({ screenWidth: 1920, screenHeight: 1080, export: true });
});
