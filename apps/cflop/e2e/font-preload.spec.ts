import { expect, test } from "@playwright/test";

test("preloads the faces used by the tool without downloading them twice", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("GeistMonoNerdFont-") && request.url().includes(".woff2")) {
      requests.push(request.url());
    }
  });
  await page.goto("/drill");
  await page.evaluate(() => document.fonts.ready);
  for (const weight of ["Regular", "Medium", "Bold"]) {
    const matching = requests.filter((url) => url.includes(`${weight}-Latin-`));
    expect(matching).toHaveLength(1);
    await expect(page.locator(`link[rel="preload"][href*="${weight}-Latin-"]`)).toHaveCount(1);
  }
});
