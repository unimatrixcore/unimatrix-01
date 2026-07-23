import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  reporter: "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:4174",
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
  },
  webServer: {
    command: process.env.CI
      ? "pnpm exec vite preview --host localhost --port 4174"
      : "pnpm run build && pnpm exec vite preview --host localhost --port 4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://localhost:4174",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
      },
    },
  ],
});
