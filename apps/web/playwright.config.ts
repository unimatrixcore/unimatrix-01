import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  reporter: "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
  },
  webServer: {
    command: "pnpm run build && pnpm exec vite preview --host localhost --port 4173",
    reuseExistingServer: !process.env.CI,
    url: "http://localhost:4173",
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
