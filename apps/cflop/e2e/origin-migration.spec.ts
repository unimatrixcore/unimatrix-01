import { expect, test } from "@playwright/test";

for (const oldHost of ["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"]) {
  test(`moves browser data from ${oldHost} before rendering the new app`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(
      /^https:\/\/(?:cflop\.us|(?:cflop|cube)\.unimatrix-01\.dev)\//,
      async (route) => {
        const url = new URL(route.request().url());
        const response = await page.request.get(
          "http://localhost:4174" + url.pathname + url.search,
        );
        await route.fulfill({ response });
      },
    );
    await page.addInitScript(
      ({ source }) => {
        if (location.hostname === source) {
          localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
          localStorage.setItem("cflop:pool:pll", '{"pll-ua":false}');
          localStorage.setItem("cflop:preview-mode:drill", "hidden");
        }
      },
      { source: oldHost },
    );
    await page.goto(`https://${oldHost}/learn?migration-check=1#case`);
    await expect(page).toHaveURL("https://cflop.us/learn?migration-check=1#case");
    await expect(page.locator("main")).toBeVisible();
    expect(
      await page.evaluate(() => ({
        progress: localStorage.getItem("cflop:progress:oll"),
        pool: localStorage.getItem("cflop:pool:pll"),
        preview: localStorage.getItem("cflop:preview-mode:drill"),
      })),
    ).toEqual({ progress: '{"oll-1":"known"}', pool: '{"pll-ua":false}', preview: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("main")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("keeps newer destination data and clears the transfer fragment", async ({ page }) => {
  await page.route("https://cflop.us/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await page.request.get("http://localhost:4174" + url.pathname),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("cflop:progress:oll", '{"oll-2":"known"}');
  });
  const fragment = encodeURIComponent(
    JSON.stringify({
      version: 1,
      hash: "",
      entries: [
        ["progress:oll", '{"oll-1":"known"}'],
        ["preview-mode:drill", "hidden"],
      ],
    }),
  );
  await page.goto(`https://cflop.us/drill#cflop-migrate=${fragment}`);
  await expect(page).toHaveURL("https://cflop.us/drill");
  await expect(page.locator("main")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cflop:progress:oll"))).toBe(
    '{"oll-2":"known"}',
  );
  expect(await page.evaluate(() => localStorage.getItem("cflop:preview-mode:drill"))).toBeNull();
});

test("offers retry and a working escape when destination storage rejects writes", async ({
  page,
}) => {
  await page.route("https://cflop.us/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await page.request.get("http://localhost:4174" + url.pathname),
    });
  });
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  const fragment = encodeURIComponent(
    JSON.stringify({ version: 1, hash: "", entries: [["progress:oll", '{"oll-1":"known"}']] }),
  );
  await page.goto(`https://cflop.us/learn#cflop-migrate=${fragment}`);
  await expect(
    page.getByRole("heading", { name: "Your saved progress could not be transferred" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Continue without importing" })).toBeVisible();
  await page.getByRole("link", { name: "Continue without importing" }).click();
  await expect(page).toHaveURL("https://cflop.us/learn");
  await expect(page.locator("main")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your saved progress could not be transferred" }),
  ).toHaveCount(0);
});
