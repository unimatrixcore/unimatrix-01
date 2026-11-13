import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4181",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite build --mode test-browser --outDir .test-browser-dist && pnpm exec vite preview --outDir .test-browser-dist",
    url: "http://127.0.0.1:4181",
    reuseExistingServer: false,
    timeout: 60000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
