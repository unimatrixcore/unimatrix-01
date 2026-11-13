import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  reporter: "list",
  workers: 1,
  outputDir: "../../.orchestration/region-browser-results",
  testMatch: "regions.spec.ts",
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4191",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite build --mode test-browser --outDir ../../.orchestration/region-browser-dist && pnpm exec vite preview --outDir ../../.orchestration/region-browser-dist --host 127.0.0.1 --port 4191",
    url: "http://127.0.0.1:4191",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
