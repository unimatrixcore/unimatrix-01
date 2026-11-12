import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  reporter: "list",
  workers: 1,
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4189",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite build --mode test-browser --outDir ../../.orchestration/ocr-browser-dist && pnpm exec vite preview --outDir ../../.orchestration/ocr-browser-dist --host 127.0.0.1 --port 4189",
    url: "http://127.0.0.1:4189",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
