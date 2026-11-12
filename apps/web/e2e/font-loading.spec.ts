import { expect, test } from "@playwright/test";

test("loads the small text face and retains Nerd Font symbols", async ({ page }) => {
  const fonts: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("GeistMonoNerdFont-") && response.url().includes(".woff2")) {
      fonts.push(response.url());
    }
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(fonts.some((url) => url.includes("Regular-Latin-"))).toBe(true);
  expect(fonts.some((url) => /Regular-(?!Latin-)/u.test(url))).toBe(false);

  await page.evaluate(async () => {
    const symbol = document.createElement("span");
    symbol.textContent = "\uf000";
    symbol.style.fontFamily = '"GeistMono Nerd Font"';
    symbol.style.fontWeight = "400";
    document.body.append(symbol);
    await document.fonts.ready;
  });
  await expect.poll(() => fonts.some((url) => /Regular-(?!Latin-)/u.test(url))).toBe(true);
});
