import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      {
        find: /^@unimatrix\/api-client$/,
        replacement: fileURLToPath(
          new URL("../../packages/api-client/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/content$/,
        replacement: fileURLToPath(new URL("../../packages/content/src/index.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/shared$/,
        replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/ui$/,
        replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      },
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    coverage: createCoverageConfig({
      // Re-measured after the CMS and Clerk auth left for `apps/admin`
      // (2026-08-02): 52.38%/50% statements/functions, rounded down to 52/50.
      // The drop from the prior 59/60 is the CMS's own well-tested code
      // leaving alongside it, not a new gap — the remaining `*.lazy.tsx` route
      // components are still only exercised by the Playwright smoke suite,
      // same as before the move.
      thresholds: { statements: 52, functions: 50 },
    }),
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
