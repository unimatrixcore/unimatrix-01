import { expect, test } from "@playwright/test";

for (const route of ["/", "/learn", "/drill"]) {
  test(`${route} does not load unused syntax-highlighting grammars`, async ({ page }) => {
    const scripts: Promise<string>[] = [];
    const errors: string[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith(".js")) scripts.push(response.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(route);
    if (route === "/")
      await expect(page.getByRole("heading", { name: "CFLOP", exact: true })).toBeVisible();
    else
      await expect(page.getByRole("button", { name: "Choose cases", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(scripts.length).toBeGreaterThan(0);
    const source = (await Promise.all(scripts)).join("\n");
    for (const marker of ["before-tokenize", "after-tokenize", "language-javascript"])
      expect(source.includes(marker), `${route} requested an unused Prism grammar`).toBe(false);
    expect(errors).toEqual([]);
  });
}
