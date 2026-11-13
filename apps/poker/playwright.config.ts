import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  reporter: "list",
  workers: 1,
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4180",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite build --mode test-browser --outDir .test-browser-dist && pnpm exec vite preview --outDir .test-browser-dist --host 127.0.0.1 --port 4180",
    url: "http://127.0.0.1:4180",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
