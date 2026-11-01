import { expect, test, type Page } from "@playwright/test";

function markedRedirectTarget(href: string): string {
  const url = new URL(href);
  url.search = "?__cflop_migrate=1&" + url.search.slice(1);
  return url.href;
}

async function serveMigrationWithRedirects(page: Page): Promise<string[]> {
  const bridgeVisits: string[] = [];
  await page.route(
    /^https:\/\/(?:cflop\.us|(?:cflop|cube)\.unimatrix-01\.dev)\//,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "cflop.us") {
        if (url.pathname === "/origin-migration") {
          bridgeVisits.push(url.hostname);
        } else if (!url.pathname.startsWith("/assets/")) {
          await route.fulfill({
            status: 301,
            headers: {
              location: markedRedirectTarget("https://cflop.us" + url.pathname + url.search),
            },
          });
          return;
        }
      }
      await route.fulfill({
        response: await page.request.get("http://localhost:4174" + url.pathname + url.search),
      });
    },
  );
  return bridgeVisits;
}

for (const oldHost of ["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"]) {
  test(`recovers ${oldHost} data after a permanent redirect before rendering`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bridgeVisits = await serveMigrationWithRedirects(page);
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
    // Start where the HTTP redirect lands: Playwright does not intercept a redirect's target.
    await page.goto(markedRedirectTarget("https://cflop.us/learn?migration-check=1#case"));
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
    expect(bridgeVisits).toEqual(
      oldHost === "cflop.unimatrix-01.dev" ? [oldHost] : ["cflop.unimatrix-01.dev", oldHost],
    );
    const sourceStorage = (await page.context().storageState()).origins.find(
      (origin) => origin.origin === `https://${oldHost}`,
    );
    expect(sourceStorage?.localStorage).toContainEqual({
      name: "cube-trainer:progress:oll",
      value: '{"oll-1":"known"}',
    });
  });
}

test("recovers homepage data at the redirected destination with its query and fragment", async ({
  page,
}) => {
  const bridgeVisits = await serveMigrationWithRedirects(page);
  await page.addInitScript(() => {
    if (location.hostname === "cflop.unimatrix-01.dev") {
      localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    }
  });
  await page.goto(markedRedirectTarget("https://cflop.us/?from=bookmark#saved"));
  await expect(page).toHaveURL("https://cflop.us/?from=bookmark#saved");
  await expect(page.locator("main")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cflop:progress:oll"))).toBe(
    '{"oll-1":"known"}',
  );
  expect(bridgeVisits).toEqual(["cflop.unimatrix-01.dev"]);
});

test("checks empty old profiles once without looping on reload", async ({ page }) => {
  const bridgeVisits = await serveMigrationWithRedirects(page);
  await page.goto(markedRedirectTarget("https://cflop.us/drill?fresh=1#start"));
  await expect(page).toHaveURL("https://cflop.us/drill?fresh=1#start");
  await expect(page.locator("main")).toBeVisible();
  expect(bridgeVisits).toEqual(["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"]);
  await page.reload();
  await expect(page.locator("main")).toBeVisible();
  expect(bridgeVisits).toHaveLength(2);
  await page.goto(markedRedirectTarget("https://cflop.us/drill?fresh=1#start"));
  await expect(page).toHaveURL("https://cflop.us/drill?fresh=1#start");
  await expect(page.locator("main")).toBeVisible();
  expect(bridgeVisits).toHaveLength(2);
});

test("direct new-domain visitors never visit old hosts or mark migration complete", async ({
  page,
}) => {
  const bridgeVisits = await serveMigrationWithRedirects(page);
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest()) documents.push(request.url());
  });
  await page.goto("https://cflop.us/?new=1#start");
  await expect(page.locator("main")).toBeVisible();
  await expect(page).toHaveURL("https://cflop.us/?new=1#start");
  expect(bridgeVisits).toEqual([]);
  expect(documents).toEqual(["https://cflop.us/?new=1"]);
  expect(
    await page.evaluate(() => localStorage.getItem("cflop:origin-migration-complete:v1")),
  ).toBeNull();
});

test("does not visit old profiles when destination already has progress", async ({ page }) => {
  const bridgeVisits = await serveMigrationWithRedirects(page);
  await page.addInitScript(() => {
    if (location.hostname === "cflop.us") {
      localStorage.setItem("cflop:progress:oll", '{"oll-2":"known"}');
    }
  });
  await page.goto(markedRedirectTarget("https://cflop.us/learn"));
  await expect(page).toHaveURL("https://cflop.us/learn");
  await expect(page.locator("main")).toBeVisible();
  expect(bridgeVisits).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("cflop:progress:oll"))).toBe(
    '{"oll-2":"known"}',
  );
});

test("retries a blocked source before initializing destination storage", async ({ page }) => {
  await serveMigrationWithRedirects(page);
  await page.addInitScript(() => {
    if (location.hostname !== "cflop.unimatrix-01.dev") return;
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    if (sessionStorage.getItem("test-storage-failed")) return;
    sessionStorage.setItem("test-storage-failed", "1");
    const readSessionItem = sessionStorage.getItem.bind(sessionStorage);
    Storage.prototype.getItem = function (key: string) {
      if (this === localStorage) throw new DOMException("Blocked", "SecurityError");
      return readSessionItem(key);
    };
  });
  await page.goto(markedRedirectTarget("https://cflop.us/learn?retry=1#case"));
  await expect(
    page.getByRole("heading", { name: "Your saved progress could not be transferred" }),
  ).toBeVisible();
  expect(new URL(page.url()).hostname).toBe("cflop.unimatrix-01.dev");
  const beforeRetry = (await page.context().storageState()).origins.find(
    (origin) => origin.origin === "https://cflop.us",
  );
  expect(beforeRetry?.localStorage ?? []).toEqual([]);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL("https://cflop.us/learn?retry=1#case");
  await expect(page.locator("main")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cflop:progress:oll"))).toBe(
    '{"oll-1":"known"}',
  );
});

test("lets a user continue after source storage fails even with a long fragment", async ({
  page,
}) => {
  await serveMigrationWithRedirects(page);
  await page.addInitScript(() => {
    if (location.hostname !== "cflop.unimatrix-01.dev") return;
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    const readSessionItem = sessionStorage.getItem.bind(sessionStorage);
    Storage.prototype.getItem = function (key: string) {
      if (this === localStorage) throw new DOMException("Blocked", "SecurityError");
      return readSessionItem(key);
    };
  });
  const targetHref = "https://cflop.us/learn#" + "x".repeat(2049);
  await page.goto(markedRedirectTarget(targetHref));
  await expect(
    page.getByRole("heading", { name: "Your saved progress could not be transferred" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Continue without importing" }).click();
  await expect(page).toHaveURL(targetHref);
  await expect(page.locator("main")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your saved progress could not be transferred" }),
  ).toHaveCount(0);
  const sourceStorage = (await page.context().storageState()).origins.find(
    (origin) => origin.origin === "https://cflop.unimatrix-01.dev",
  );
  expect(sourceStorage?.localStorage).toContainEqual({
    name: "cube-trainer:progress:oll",
    value: '{"oll-1":"known"}',
  });
});

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
